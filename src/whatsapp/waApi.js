// Every call to the WhatsApp service. Nothing else in the app talks to
// /whatsapp/* directly.
//
// These routes sit behind the API Gateway authorizer, so unlike the Apps
// Script calls they carry a real Authorization header. Apps Script cannot read
// headers — which is why api.js puts the token in the query string — but API
// Gateway can, and a token in a URL ends up in access logs.
//
// Appointments live in DynamoDB, not in the Sheet. The Sheet still owns the
// visit and its clinical record; the appointment is a separate row that
// reminders, reschedules and cancellations are driven from, because a
// scheduler cannot poll a spreadsheet and a cancelled slot has to be
// authoritative somewhere.

import { logEvent } from '../api';
import { getAccessToken } from '../auth';

const AWS_URL = import.meta.env.VITE_AWS_API_URL;
const CLINIC_ID = import.meta.env.VITE_CLINIC_ID;

const TIMEOUT_MS = 20000;
const SLOW_MS = 4000;

export function waConfigured() {
  return !!(AWS_URL && CLINIC_ID);
}

async function waFetch(path, opts, ctx) {
  if (!waConfigured()) throw new Error('WhatsApp is not configured for this clinic.');

  // Sending the request anyway produces a bare 403 from the gateway, which
  // surfaces as "Couldn't send" and sends whoever is debugging it looking at
  // templates and bindings. The session is the actual problem; say so.
  const token = await getAccessToken();
  if (!token) {
    const e = new Error('Your session has expired. Please sign in again.');
    e.sessionExpired = true;
    throw e;
  }
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
  const t0 = Date.now();
  const op = (ctx && ctx.op) || 'wa';

  let res;
  try {
    res = await fetch(AWS_URL + path, {
      ...(opts || {}),
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...((opts && opts.headers) || {}),
      },
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
    logEvent({ kind: 'wa_request', op, outcome: timedOut ? 'timeout' : 'network_error',
      error: String((err && err.message) || err), ms: Date.now() - t0 });
    throw new Error('Could not reach the messaging service. Check your connection.');
  } finally {
    if (timer) clearTimeout(timer);
  }

  const ms = Date.now() - t0;
  let text = '';
  try { text = await res.text(); } catch { /* body already gone */ }

  if (!res.ok) {
    logEvent({ kind: 'wa_request', op, outcome: 'http_error', httpStatus: res.status, ms,
      responseBody: text.slice(0, 2000) });
    // The authorizer answers a bare 401 by design — it never says which check
    // failed. Anything else is worth repeating to the user verbatim.
    if (res.status === 401 || res.status === 403) throw new Error('Not authorised. Please sign in again.');
    throw new Error('Messaging service error (' + res.status + ')');
  }

  let json;
  try { json = JSON.parse(text); } catch {
    logEvent({ kind: 'wa_request', op, outcome: 'non_json', httpStatus: res.status, ms });
    throw new Error('The messaging service returned an unexpected response.');
  }
  if (json && json.ok === false) {
    logEvent({ kind: 'wa_request', op, outcome: 'api_error', httpStatus: res.status, ms,
      serverError: String(json.error || '') });
    throw new Error(json.error || 'Messaging service error');
  }
  if (ms > SLOW_MS) logEvent({ kind: 'wa_request', op, outcome: 'ok', httpStatus: res.status, ms, slow: true });
  return json;
}

function qs(params) {
  const p = new URLSearchParams();
  Object.keys(params || {}).forEach((k) => {
    const v = params[k];
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  });
  const s = p.toString();
  return s ? '?' + s : '';
}

/* ── Configuration ────────────────────────────────────────────────────── */

// One call at boot, and only when the org record says this clinic has
// WhatsApp. A clinic without it makes no /whatsapp/* request at all, so
// turning the feature on is a DynamoDB write and a refresh — never a deploy.
export async function fetchWaConfig() {
  const json = await waFetch('/whatsapp/config/' + encodeURIComponent(CLINIC_ID), undefined, { op: 'waConfig' });
  return {
    enabled: !!json.enabled,
    clinicPhone: json.clinicPhone || '',
    // Normalised to bare digits so callers can test membership without
    // worrying about +91 / spaces / leading zeros.
    optedOut: new Set((json.optedOut || []).map((m) => String(m).replace(/\D/g, '').slice(-10))),
  };
}

/* ── Appointments ─────────────────────────────────────────────────────── */

export function listAppointments({ from, to }) {
  return waFetch('/whatsapp/appointments' + qs({ clinicId: CLINIC_ID, from, to }), undefined,
    { op: 'listAppointments' }).then((j) => j.appointments || []);
}

// Called when a doctor saves a next appointment. Safe to call with an
// unchanged date and time: the backend compares before it sends, so re-saving
// a form must not fire a second confirmation.
export function upsertAppointment({ patientId, visitId, name, mobile, date, time, treatment, durationMin }) {
  return waFetch('/whatsapp/appointments', {
    method: 'POST',
    body: JSON.stringify({ clinicId: CLINIC_ID, patientId, visitId, name, mobile, date, time, treatment, durationMin }),
  }, { op: 'upsertAppointment' });
}

export function rescheduleAppointment({ appointmentId, date, time }) {
  return waFetch('/whatsapp/appointments/' + encodeURIComponent(appointmentId) + '/reschedule', {
    method: 'POST',
    body: JSON.stringify({ clinicId: CLINIC_ID, date, time }),
  }, { op: 'rescheduleAppointment' });
}

export function cancelAppointment({ appointmentId }) {
  return waFetch('/whatsapp/appointments/' + encodeURIComponent(appointmentId) + '/cancel', {
    method: 'POST',
    body: JSON.stringify({ clinicId: CLINIC_ID }),
  }, { op: 'cancelAppointment' });
}

/* ── Messages ─────────────────────────────────────────────────────────── */

// The key is deterministic — same document, same version, same key — so a
// double click, a second tab and a retried request all collapse into one send.
export function idempotencyKeyFor(visitId, useCase, docVersion) {
  return [visitId || 'novisit', useCase, docVersion == null ? '1' : String(docVersion)].join(':');
}

export function sendMessage({ useCase, patientId, visitId, mobile, name, params, docVersion, documentUrl }) {
  return waFetch('/whatsapp/messages/send', {
    method: 'POST',
    body: JSON.stringify({
      clinicId: CLINIC_ID, useCase, patientId, visitId, mobile, name,
      params: params || {}, documentUrl,
      idempotencyKey: idempotencyKeyFor(visitId, useCase, docVersion),
    }),
  }, { op: 'sendMessage' });
}

export function getMessage(messageId) {
  return waFetch('/whatsapp/messages/' + encodeURIComponent(messageId) + qs({ clinicId: CLINIC_ID }),
    undefined, { op: 'getMessage' });
}

export function listMessages({ from, to, event, status, q, page }) {
  return waFetch('/whatsapp/messages' + qs({ clinicId: CLINIC_ID, from, to, event, status, q, page }),
    undefined, { op: 'listMessages' });
}

export function messageStats({ from, to }) {
  return waFetch('/whatsapp/messages/stats' + qs({ clinicId: CLINIC_ID, from, to }),
    undefined, { op: 'messageStats' });
}

export function failedMessages({ date }) {
  return waFetch('/whatsapp/messages/failed' + qs({ clinicId: CLINIC_ID, date, unresolved: 1 }),
    undefined, { op: 'failedMessages' }).then((j) => j.messages || []);
}

export function resolveMessage(messageId) {
  return waFetch('/whatsapp/messages/' + encodeURIComponent(messageId) + '/resolve', {
    method: 'POST',
    body: JSON.stringify({ clinicId: CLINIC_ID }),
  }, { op: 'resolveMessage' });
}

export function patientMessages(patientId) {
  return waFetch('/whatsapp/patients/' + encodeURIComponent(patientId) + '/messages' + qs({ clinicId: CLINIC_ID }),
    undefined, { op: 'patientMessages' }).then((j) => j.messages || []);
}

export function patientMessageStats() {
  return waFetch('/whatsapp/patients/stats' + qs({ clinicId: CLINIC_ID }),
    undefined, { op: 'patientMessageStats' });
}
