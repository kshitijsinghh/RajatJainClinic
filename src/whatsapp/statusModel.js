// The one place WhatsApp status becomes something a human reads.
//
// The backend stores five delivery states (accepted / sent / delivered / read /
// failed) and, separately, the patient's button reply. The Appointments tab
// shows a fusion of the two as four colours; the Messages tab shows the
// delivery state alone as four pills. Those are two renderings of one
// derivation, so they live together here — derived twice is derived wrong the
// first time someone changes a threshold.
//
// Every label in this file is quoted from "The words" in the UX document.
// Do not paraphrase them: "template", "delivery status" and "opt-out" are
// deliberately absent from everything staff can see.

/* ── Appointment status: delivery fused with the reply ────────────────── */

// The seven values the calendar understands. Ordered loosest to firmest.
export const APPT_NOT_SENT = 'notsent';
export const APPT_FAILED = 'failed';
export const APPT_OFF = 'off';
export const APPT_SENT = 'sent';
export const APPT_SEEN = 'seen';
export const APPT_COMING = 'coming';
export const APPT_CANT = 'cant';

const APPT_LOOK = {
  notsent: { bg: '#ffffff', bd: '#cfd9d7', bar: '#9fb3af', ink: '#0e3b39', label: 'Not sent' },
  // Same white fill as "not sent", amber edge. Reception has to be able to
  // tell "we never sent it" from "we sent it and it bounced" at a glance —
  // only the second one needs a phone call.
  failed: { bg: '#ffffff', bd: '#e9c48f', bar: '#b8690f', ink: '#0e3b39', label: 'Not sent' },
  off: { bg: '#ffffff', bd: '#cfd9d7', bar: '#9fb3af', ink: '#0e3b39', label: 'Not sent' },
  sent: { bg: '#fff5cc', bd: '#efd273', bar: '#d9a90f', ink: '#5a4300', label: 'Awaiting reply' },
  seen: { bg: '#fff5cc', bd: '#efd273', bar: '#d9a90f', ink: '#5a4300', label: 'Awaiting reply' },
  coming: { bg: '#dff3e6', bd: '#8fd0a8', bar: '#1f9a58', ink: '#0f5f42', label: 'Coming' },
  cant: { bg: '#fde3e0', bd: '#eea198', bar: '#d23b2f', ink: '#8c1d17', label: "Can't come" },
};

const APPT_BUCKET = {
  notsent: 'white', failed: 'white', off: 'white',
  sent: 'yellow', seen: 'yellow', coming: 'green', cant: 'red',
};

export function apptLook(status) {
  return APPT_LOOK[status] || APPT_LOOK.notsent;
}
export function apptBucket(status) {
  return APPT_BUCKET[status] || 'white';
}

// A reply outranks delivery: a patient who tapped "Coming" has self-evidently
// seen the message, whatever the ladder got round to recording.
//
// The ladder is also monotonic and lossy — `delivered` may never arrive at all
// when Meta collapses it with `read` — so this reads "has it got at least this
// far", never "is it exactly this".
export function apptStatus(appt) {
  if (!appt) return APPT_NOT_SENT;
  const answer = appt.confirmation && appt.confirmation.answer;
  if (answer === 'coming') return APPT_COMING;
  if (answer === 'cant_come') return APPT_CANT;
  if (appt.whatsappOff) return APPT_OFF;
  const s = String((appt.confirmation && appt.confirmation.lastMessageStatus) || appt.lastMessageStatus || '').toLowerCase();
  if (s === 'failed') return APPT_FAILED;
  if (s === 'read') return APPT_SEEN;
  if (s === 'delivered' || s === 'sent' || s === 'accepted') return APPT_SENT;
  return APPT_NOT_SENT;
}

/* ── Message status: the five→four collapse ───────────────────────────── */

const MSG_LOOK = {
  sent: { label: 'Sent', bg: '#eef4f3', ink: '#4a6864' },
  delivered: { label: 'Delivered', bg: '#e3f5ec', ink: '#12805a' },
  seen: { label: 'Seen', bg: '#d7efe9', ink: '#0b5f58' },
  failed: { label: 'Not delivered', bg: '#fff4e5', ink: '#8a4f0b' },
};

export const MSG_FILTERS = ['All', 'Seen', 'Delivered', 'Sent', 'Not delivered'];

export function msgStatus(raw, reply) {
  const s = String(raw || '').toLowerCase();
  if (s === 'failed') return 'failed';
  if (s === 'read' || s === 'seen') return 'seen';
  // A patient who tapped a button has read the message. Meta only reports
  // `read` when read receipts are on, so counting that alone shows "Seen 0"
  // beside a log full of "Replied Coming" — which reads as a bug, not as a
  // privacy setting. The same rule lives in core.mjs uiStatus().
  if (reply) return 'seen';
  if (s === 'delivered') return 'delivered';
  return 'sent'; // queued and accepted both read as "Sent"; neither is worth a word of its own
}
export function msgLook(status) {
  return MSG_LOOK[status] || MSG_LOOK.sent;
}

/* ── Trigger events ───────────────────────────────────────────────────── */

// Keyed by the use case the backend sends. The template name is shown in the
// log for support purposes only; it is the one place a Meta identifier is
// allowed to surface, and it is never spoken of as a "template" elsewhere.
export const TRIGGERS = {
  APPOINTMENT_CONFIRMATION: { event: 'Appointment confirmation', color: '#0e756c' },
  APPOINTMENT_REMINDER: { event: 'Appointment reminder', color: '#3d6fb0' },
  APPOINTMENT_REMINDER_TODAY: { event: 'Same-day reminder', color: '#5b8fd6' },
  APPOINTMENT_RESCHEDULED: { event: 'Reschedule', color: '#8e5bb5' },
  APPOINTMENT_CANCELLED: { event: 'Cancellation', color: '#6b7280' },
  EPRESCRIPTION: { event: 'Prescription', color: '#d1502f' },
  PAYMENT_RECEIPT: { event: 'Payment receipt', color: '#b58412' },
};

export function triggerLook(useCase) {
  return TRIGGERS[useCase] || { event: String(useCase || 'Message'), color: '#8aa8a3' };
}

/* ── Failure reasons, in plain words ──────────────────────────────────── */

// Meta's error codes are useless to reception. These are the only four
// sentences we ever show; anything unmapped falls through to the last one.
export function failureReason(code, raw) {
  const c = String(code || '');
  if (c === '131026' || /not.*whatsapp|not a valid whatsapp/i.test(String(raw || ''))) {
    return "Number isn't on WhatsApp";
  }
  if (c === '131047' || c === '131051' || /blocked/i.test(String(raw || ''))) {
    return 'Patient has blocked the clinic';
  }
  if (c === '132000' || c === '132001' || c === '131008' || /template|param/i.test(String(raw || ''))) {
    return "WhatsApp didn't accept this message — we're looking into it";
  }
  return "Couldn't send — try again, or print it";
}

/* ── Reply pills ──────────────────────────────────────────────────────── */

export function replyPill(status) {
  if (status === APPT_COMING) return { text: 'Coming', bg: '#dff3e6', ink: '#0f5f42' };
  if (status === APPT_CANT) return { text: "Can't come", bg: '#fde3e0', ink: '#8c1d17' };
  if (status === APPT_OFF) return { text: 'No WhatsApp', bg: '#eef4f3', ink: '#7a9994' };
  return { text: 'No reply yet', bg: 'transparent', ink: '#98b0ab' };
}

// The short status column in the table and the phone cards.
export function waShort(status) {
  return {
    notsent: 'Not sent yet', failed: "Didn't deliver", off: 'WhatsApp off',
    sent: 'Delivered', seen: 'Seen', coming: 'Seen · replied', cant: 'Seen · replied',
  }[status] || 'Not sent yet';
}

/* ── The WhatsApp block inside the event pop-up ───────────────────────── */

// Returns [title, explanation, ink]. The explanation always names what the
// clinic should do next when there is something to do, and says nothing when
// there isn't.
export function waBlock(status, first, sentAt) {
  const at = sentAt ? String(sentAt) : '';
  return {
    notsent: ['Confirmation not sent yet', 'Nothing has gone to ' + first + ' on WhatsApp for this appointment.', '#0e3b39'],
    failed: ["Couldn't deliver", "Number isn't on WhatsApp — call " + first + ' to confirm.', '#8a4f0b'],
    off: ['WhatsApp off', first + ' has turned off WhatsApp messages — call to confirm.', '#5c7a76'],
    sent: ['Confirmation delivered', 'Sent ' + at + ' · reminder goes out the day before', '#0e3b39'],
    seen: ['Confirmation seen', 'Sent ' + at + ' · ' + first + ' has opened it', '#0e3b39'],
    coming: ['Confirmation seen', 'Sent ' + at, '#0e3b39'],
    cant: ['Confirmation seen', 'Sent ' + at, '#0e3b39'],
  }[status] || ['Confirmation not sent yet', '', '#0e3b39'];
}

// The sub-line under the reply pill in the pop-up.
export function replySub(status, first, repliedAt, changed) {
  const at = repliedAt ? String(repliedAt) : '';
  if (status === APPT_COMING) return (changed ? 'Changed to Coming · ' : 'Replied ') + at;
  if (status === APPT_CANT) return 'Replied ' + at + ' — this slot can be given to someone else';
  if (status === APPT_SENT || status === APPT_SEEN) return first + " hasn't tapped Coming or Can't come yet.";
  return 'They can only reply once a WhatsApp message reaches them.';
}

export function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'the patient';
}
