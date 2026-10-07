// "Send to WhatsApp", inside the e-prescription and payment-receipt pop-ups.
//
// One hook owns the state machine and two small components render it, because
// the control and the strip below it are the same state shown in two places
// and the pop-up header and body are far apart in the DOM.
//
// The label is always "Send to WhatsApp" and never carries the patient's
// name: the button is pressed while the patient is standing there, and a
// button that names someone is a button you check twice.

import { useCallback, useEffect, useRef, useState } from 'react';
import { failureReason, firstName, msgStatus } from './statusModel';
import { WaGlyph, Spinner, fmtClock, maskPhone } from './ui';
import { getMessage, sendMessage } from './waApi';
import { useWa } from './WaContext';

const POLL_MS = 3000;
const STILL_TRYING_MS = 8000;

// The first send keeps the plain document version, so the deterministic key
// still collapses a double click. Every later one is tagged, which is what
// makes "Send again" actually send again.
export function docVersionForAttempt(docVersion, attempt) {
  if (!attempt) return docVersion;
  return (docVersion == null || docVersion === '' ? '1' : String(docVersion)) + '#' + attempt;
}

export function useDocSend({ useCase, patient, visitId, docVersion, params, documentUrl, existing }) {
  const wa = useWa();
  const optedOut = wa.enabled && wa.isOptedOut(patient && patient.mobile);

  // `existing` is the last send for this document, if the visit already knows
  // about one. Reopening a pop-up must not look like nothing has happened.
  const [state, setState] = useState(() => {
    if (!existing) return 'idle';
    const st = msgStatus(existing.status);
    return st === 'failed' ? 'failed' : st === 'seen' ? 'seen' : st === 'delivered' ? 'delivered' : 'sending';
  });
  const [msg, setMsg] = useState(existing || null);
  const [error, setError] = useState('');
  const [stillTrying, setStillTrying] = useState(false);
  const pollRef = useRef(null);
  const slowRef = useRef(null);

  // Which attempt this is. The idempotency key is deliberately deterministic
  // so a double click, a second tab and a retried request all collapse into
  // one send — but "Send again" is a person deciding they want another
  // message, and with an unchanged key the backend recognises the first one
  // and hands it straight back, so nothing goes. Starts at 1 when the pop-up
  // already knows about a send, because the next click is then a resend too.
  const attemptRef = useRef(existing ? 1 : 0);

  const stopPolling = useCallback(() => {
    clearInterval(pollRef.current);
    clearTimeout(slowRef.current);
    pollRef.current = null;
    slowRef.current = null;
  }, []);

  // Polling is bounded by the pop-up's lifetime, not by a retry count: a
  // document that is still "sending" when the pop-up closes is not lost, it
  // just stops being watched, and the visit will show the outcome.
  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback((messageId) => {
    stopPolling();
    setStillTrying(false);
    slowRef.current = setTimeout(() => setStillTrying(true), STILL_TRYING_MS);
    pollRef.current = setInterval(async () => {
      try {
        const res = await getMessage(messageId);
        const m = res.message || res;
        setMsg(m);
        const st = msgStatus(m.status);
        if (st === 'failed') { setState('failed'); stopPolling(); }
        else if (st === 'seen') { setState('seen'); stopPolling(); }
        else if (st === 'delivered') { setState('delivered'); /* keep polling: seen may still arrive */ }
      } catch { /* a dropped poll is not a failed send */ }
    }, POLL_MS);
  }, [stopPolling]);

  const send = useCallback(async () => {
    if (state === 'sending') return;
    // Read before the await so two clicks landing together still take
    // different numbers; the guard above already covers the in-flight case.
    const attempt = attemptRef.current;
    attemptRef.current += 1;
    setState('sending');
    setError('');
    setStillTrying(false);
    try {
      const res = await sendMessage({
        useCase,
        patientId: patient && patient.patientId,
        visitId,
        mobile: patient && patient.mobile,
        name: patient && patient.name,
        params: params || {},
        documentUrl,
        docVersion: docVersionForAttempt(docVersion, attempt),
      });
      const m = res.message || res;
      setMsg(m);
      if (msgStatus(m.status) === 'failed') { setState('failed'); return; }
      poll(m.messageId);
    } catch (err) {
      setState('failed');
      setError(String((err && err.message) || ''));
    }
  }, [state, useCase, patient, visitId, params, documentUrl, docVersion, poll]);

  // A document use case cannot be sent before its file exists.
  const needsDoc = useCase === 'EPRESCRIPTION' || useCase === 'PAYMENT_RECEIPT';
  return { state, msg, error, stillTrying, optedOut, enabled: wa.enabled,
    ready: !needsDoc || !!documentUrl, send };
}

/* ── The control ──────────────────────────────────────────────────────── */

export function SendControl({ send, patient, phone }) {
  const { state, stillTrying, optedOut, enabled, msg, ready } = send;
  if (!enabled || optedOut) return null;
  // The document is still being generated. Offering the button here would
  // send the server a null URL and produce a failure the user caused by
  // being quick, which is not their mistake to see.
  if (!ready) {
    return (
      <span style={{
        minHeight: phone ? 48 : 36, padding: phone ? 0 : '0 15px',
        borderRadius: phone ? 12 : 100, flex: phone ? 1 : undefined,
        background: phone ? '#eef4f3' : 'rgba(255,255,255,.18)',
        color: phone ? '#8aa8a3' : 'rgba(255,255,255,.75)',
        fontWeight: 700, fontSize: phone ? 15 : 13.5,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      }}>
        Preparing…
      </span>
    );
  }

  const first = firstName(patient && patient.name);
  const at = fmtClock((msg && (msg.readAt || msg.deliveredAt || msg.sentAt)) || '');

  const base = phone
    ? {
      flex: 1, minHeight: 48, borderRadius: 12, border: 0, fontWeight: 700, fontSize: 15,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 9,
    }
    : {
      minHeight: 36, padding: '0 15px', borderRadius: 100, border: 0, fontWeight: 700, fontSize: 13.5,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    };

  if (state === 'sending') {
    return (
      <button disabled style={{ ...base, background: phone ? '#9ccfc8' : 'rgba(255,255,255,.75)', color: phone ? '#fff' : '#0e3b39', cursor: 'default' }}>
        <Spinner size={13} color={phone ? '#fff' : '#0e756c'} track={phone ? 'rgba(255,255,255,.4)' : '#cfe3df'} />
        {stillTrying ? 'Still trying…' : 'Sending…'}
      </button>
    );
  }

  if (state === 'delivered' || state === 'seen') {
    const label = state === 'seen' ? 'Seen by ' + first : 'Sent to ' + first;
    // On a phone a completed send stops being a button: the job is done and
    // the bar should go back to offering Download and Print.
    if (phone) {
      return (
        <span style={{ ...base, background: '#eef4f3', color: '#5c7a76', cursor: 'default' }}>
          ✓ Sent to WhatsApp
        </span>
      );
    }
    return (
      <span style={{ ...base, background: '#dff3e6', color: '#0f5f42', cursor: 'default' }}>
        ✓ {label}{at ? ' · ' + at : ''}
      </span>
    );
  }

  if (state === 'failed') {
    return (
      <button
        onClick={send.send}
        style={{ ...base, background: phone ? '#c0392b' : '#fdecea', color: phone ? '#fff' : '#c0392b', cursor: 'pointer' }}
      >
        Didn't send — Try again
      </button>
    );
  }

  return (
    <button
      onClick={send.send}
      style={{ ...base, background: phone ? '#128c7e' : '#fff', color: phone ? '#fff' : '#0e3b39', cursor: 'pointer' }}
    >
      <WaGlyph size={phone ? 17 : 15} color={phone ? '#fff' : '#128c7e'} />
      Send to WhatsApp
    </button>
  );
}

/* ── The strip underneath ─────────────────────────────────────────────── */

export function SendStrip({ send, patient }) {
  const { state, msg, error, stillTrying, optedOut, enabled } = send;
  if (!enabled) return null;

  const name = (patient && patient.name) || 'This patient';
  const first = firstName(name);

  if (optedOut) {
    return (
      <div className={NOPRINT} style={strip('#f5f8f7', '#e2efec')}>
        <span style={{ fontSize: 13, color: '#5c7a76', lineHeight: 1.5 }}>
          {name} has turned off WhatsApp messages from the clinic. Print this or hand it over in person.
        </span>
      </div>
    );
  }

  if (state === 'sending' && stillTrying) {
    return (
      <div className={NOPRINT} style={strip('#f7fbfa', '#e2efec')}>
        <span style={{ fontSize: 13, color: '#5c7a76', lineHeight: 1.5 }}>
          Still trying — you can close this, we'll show the result on the visit.
        </span>
      </div>
    );
  }

  if (state === 'delivered' || state === 'seen') {
    const at = fmtClock((msg && (msg.readAt || msg.deliveredAt || msg.sentAt)) || '');
    return (
      <div className={NOPRINT} style={strip('#eefaf3', '#c8e9d7')}>
        <span style={{ fontSize: 13, color: '#0f5f42', lineHeight: 1.5 }}>
          {state === 'seen' ? 'Seen by ' : 'Delivered to '}{first} on WhatsApp ({maskPhone(patient && patient.mobile)}).
          {at ? ' · ' + at : ''}
        </span>
        <button onClick={send.send} style={linkBtn('#0f5f42')}>Send again</button>
      </div>
    );
  }

  if (state === 'failed') {
    return (
      <div className={NOPRINT} style={strip('#fdecea', '#f6d3c8')}>
        <span style={{ fontSize: 13, color: '#c0392b', lineHeight: 1.5 }}>
          {failureReason(msg && msg.failureCode, (msg && msg.failureReason) || error)}
        </span>
        <button onClick={send.send} style={linkBtn('#c0392b')}>Try again</button>
      </div>
    );
  }

  return null;
}

function strip(bg, bd) {
  return {
    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    background: bg, borderTop: '1px solid ' + bd, padding: '10px 20px',
  };
}

// Applied to everything inside the pop-up that is console chrome rather than
// part of the document. See the print rules in index.css.
const NOPRINT = 'wa-noprint';
function linkBtn(color) {
  return {
    background: 'transparent', border: 0, padding: 0, color, fontWeight: 700,
    fontSize: 13, textDecoration: 'underline', cursor: 'pointer', marginLeft: 'auto',
  };
}

/* ── The icon buttons that replace "Print / Save PDF" ─────────────────── */

export function IconButton({ onClick, title, children, phone }) {
  const [busy, setBusy] = useState(false);
  const size = phone ? 44 : 34;

  // Fetching the document and handing it to the browser takes a moment, and
  // without this the icon swallowed the click silently — which reads as a
  // dead button and invites a second one.
  async function go() {
    if (busy || !onClick) return;
    setBusy(true);
    try { await onClick(); } catch (err) { console.error(title + ' failed:', err); } finally { setBusy(false); }
  }

  return (
    <button
      onClick={go}
      disabled={busy}
      title={title}
      aria-label={title}
      aria-busy={busy || undefined}
      style={{
        width: size, height: size, flexShrink: 0, borderRadius: phone ? 12 : 9,
        cursor: busy ? 'progress' : 'pointer',
        border: phone ? '1px solid #cfe3df' : 0,
        background: phone ? '#fff' : 'rgba(255,255,255,.15)',
        color: phone ? '#0e756c' : '#fff',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0,
      }}
    >
      {busy ? <Spinner /> : children}
    </button>
  );
}

export function DownloadIcon({ color = 'currentColor' }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </svg>
  );
}

export function PrintIcon({ color = 'currentColor' }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z" />
    </svg>
  );
}

/* ── The pop-up header ────────────────────────────────────────────────── */

// A clinic without WhatsApp keeps the header it already has, down to the
// "Print" and "Download" text buttons — `fallback`. Only a clinic that has
// been switched on gets the send pill and the icon buttons. Two layouts is a
// small price for a rollout that cannot touch the clinics not in it.
export function DocPopupHeader({ title, send, patient, onPrint, onDownload, onClose, fallback, phone }) {
  const bar = {
    background: '#0e3b39', color: '#fff', padding: '14px 20px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  };
  const close = (
    <button
      onClick={onClose}
      aria-label="Close"
      style={{ width: 32, height: 32, flexShrink: 0, borderRadius: 8, border: 0, background: 'rgba(255,255,255,.15)', color: '#fff', fontSize: 15, cursor: 'pointer' }}
    >
      ✕
    </button>
  );

  if (!send.enabled) {
    return (
      <div id="rx-chrome" style={bar}>
        <span style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 16 }}>{title}</span>
        <div style={{ display: 'flex', gap: 8 }}>{fallback}{close}</div>
      </div>
    );
  }

  // On a phone the header carries only the title and ✕; everything actionable
  // lives in the bar fixed to the bottom of the screen, within thumb reach.
  if (phone) {
    return (
      <div id="rx-chrome" style={bar}>
        <span style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 16 }}>{title}</span>
        {close}
      </div>
    );
  }

  return (
    <div id="rx-chrome" style={bar}>
      <span style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 16 }}>{title}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <SendControl send={send} patient={patient} />
        {onDownload && <IconButton onClick={onDownload} title="Download PDF"><DownloadIcon /></IconButton>}
        {onPrint && <IconButton onClick={onPrint} title="Print"><PrintIcon /></IconButton>}
        {close}
      </div>
    </div>
  );
}

/* ── The fixed bottom bar on a phone ──────────────────────────────────── */

export function PhoneActionBar({ send, patient, onDownload, onPrint }) {
  const done = send.state === 'delivered' || send.state === 'seen';
  return (
    <div className={NOPRINT} style={{
      position: 'sticky', bottom: 0, background: '#fff', borderTop: '1px solid #e2efec',
      padding: '10px 14px calc(10px + env(safe-area-inset-bottom))',
      display: 'flex', alignItems: 'center', gap: 10, zIndex: 5,
    }}>
      {/* Once the document has gone, Download and Print come first again —
          the remaining reason to be here is to put paper in someone's hand. */}
      {done && <SendControl send={send} patient={patient} phone />}
      <IconButton onClick={onDownload} title="Download PDF" phone><DownloadIcon /></IconButton>
      <IconButton onClick={onPrint} title="Print" phone><PrintIcon /></IconButton>
      {!done && <SendControl send={send} patient={patient} phone />}
    </div>
  );
}
