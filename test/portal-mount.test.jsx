// Mounts the real patient portal in a DOM and drives it the way a patient
// does. The render smoke test cannot reach any of this: PortalApp starts with
// `loading` true and only leaves it from an effect, so renderToString sees the
// spinner and nothing else. That blind spot is exactly where the blank screen
// after sign-in came from, so this test exists to cover past it.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://clinic.test/portal.html', pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
// navigator is a getter-only global on modern Node.
try { Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true }); } catch { /* Node already provides one */ }
global.localStorage = dom.window.localStorage;
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = clearTimeout;
global.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { createElement: h } = await import('react');
const PortalApp = (await import('../src/PortalApp.jsx')).default;

let pass = 0, fail = 0;
const check = (n, ok, got) => {
  if (ok) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, got === undefined ? '' : String(got).slice(0, 220)); }
};

/* ── the clinic server, as the portal sees it ───────────────────────────── */

const PATIENT = {
  patientId: 'P0001', mobile: '9110968006', name: 'Kshitij Singh',
  age: 27, gender: 'Male', email: '', address: '',
  visits: [{
    visitId: 'P0001_1', no: 1, date: new Date().toISOString().slice(0, 10),
    done: false, queueNumber: 1,
    clinical: { patientProblem: '', patientMedicalHistory: '', patientAllergies: '', patientDentalHistory: '' },
  }],
};
const scopedSnapshot = () => ({
  ok: true, patients: { P0001: JSON.parse(JSON.stringify(PATIENT)) },
  order: ['P0001'], payments: {}, upiQr: '', scoped: true,
});

// What the server sends back from a write when it could not identify the
// caller — a clinic on authMode: off has no claims to scope by. This is the
// shape that blanked the portal.
const bareAck = () => ({ ok: true, patientId: 'P0001', visitId: 'P0001_1', saved: ['patientProblem'] });

let writeResponse = bareAck;
const calls = [];

global.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  calls.push(body ? body.action : (u.match(/action=(\w+)/) || [])[1]);
  const reply = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (body && body.action === 'savePatientProblem') return reply(writeResponse());
  if (body && body.action === 'portalCheckin') return reply(writeResponse());
  if (/action=patientSnapshot/.test(u)) return reply(scopedSnapshot());
  if (/\/org\//.test(u)) return reply({ ok: true, clinicName: 'Test Clinic' });
  return reply({ ok: true });
};
global.sendBeacon = () => true;

// A live patient session, so the portal boots straight into the Today screen
// instead of the login form.
localStorage.setItem('pp_session', JSON.stringify({
  accessToken: 'test-token', expiresAt: Math.floor(Date.now() / 1000) + 3600,
}));
localStorage.setItem('patient_session', JSON.stringify({ mobile: '9110968006' }));

/* ── mount ──────────────────────────────────────────────────────────────── */

const root = createRoot(document.getElementById('root'));
const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };

let crashed = null;
const onErr = (e) => { crashed = e.error || e.reason || e; };
dom.window.addEventListener('error', onErr);
dom.window.addEventListener('unhandledrejection', onErr);

await act(async () => { root.render(h(PortalApp)); });
await flush();

const text = () => document.body.textContent || '';
const html = () => document.body.innerHTML || '';

check('the portal renders past the loading spinner', !/Loading, please wait/.test(text()), text().slice(0, 90));
check('the signed-in patient is on screen', /Kshitij Singh/.test(text()), text().slice(0, 160));
check('the health-details form is offered', /Your health details/.test(text()), text().slice(0, 200));
check('the four questions are all asked',
  ["What's troubling you today?", 'Medical history', 'Allergies', 'Dental history']
    .every((q) => text().includes(q)), text().slice(0, 300));
check('the queue number card is gone', !/queue number/i.test(text()));
check('the checked-in line points at the form', /Fill in your health details below while you wait/.test(text()));

/* ── the bug: a write that answers with a bare ack ──────────────────────── */

const area = document.querySelectorAll('textarea');
check('four textareas are rendered', area.length === 4, area.length);

await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(area[2], 'Penicillin');
  area[2].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});
await flush();

const sendBtn = [...document.querySelectorAll('button')].find((b) => /Send to doctor/.test(b.textContent));
check('the send button is there', !!sendBtn, [...document.querySelectorAll('button')].map((b) => b.textContent).join(' | '));

writeResponse = bareAck;
await act(async () => { sendBtn.click(); });
await flush();

check('a bare acknowledgement does not crash the portal', !crashed, crashed && crashed.message);
check('...and the screen is still showing something', text().trim().length > 0, text().length);
check('...with the patient still signed in', /Kshitij Singh/.test(text()), text().slice(0, 160));
check('...and the allergy shown back to them', /Penicillin/.test(text()), text().slice(0, 300));
check('...reported as sent', /sent to the doctor/i.test(text()), text().slice(0, 300));
check('the portal refetched its records rather than trusting the ack',
  calls.filter((c) => c === 'patientSnapshot').length >= 2, calls.join(','));

/* ── and a scoped snapshot still works ──────────────────────────────────── */

writeResponse = () => ({ ...scopedSnapshot(), patientId: 'P0001', visitId: 'P0001_1' });
crashed = null;
const editBtn = [...document.querySelectorAll('button')].find((b) => /Edit/.test(b.textContent));
if (editBtn) { await act(async () => { editBtn.click(); }); await flush(); }
const saveBtn = [...document.querySelectorAll('button')].find((b) => /Save changes|Send to doctor/.test(b.textContent));
if (saveBtn) { await act(async () => { saveBtn.click(); }); await flush(); }
check('a scoped snapshot response also works', !crashed, crashed && crashed.message);
check('...and the patient is still there', /Kshitij Singh/.test(text()), text().slice(0, 160));
check('the page never goes empty', html().length > 500, html().length);

/* ── Visit history, on or off ───────────────────────────────────────────
   Built twice: once with VITE_PORTAL_HISTORY unset and once with "false".
   HISTORY_OFF says which build is running, so the same mounted portal is
   asserted from both sides. */

const HISTORY_OFF = process.env.PORTAL_HISTORY_OFF === '1';
const tabs = () => [...document.querySelectorAll('nav button')].map((b) => b.textContent.trim());

if (HISTORY_OFF) {
  check('[history off] the History tab is not offered', !tabs().some((t) => /History/.test(t)), tabs());
  check('[history off] Today and Family remain', tabs().length === 2, tabs());
  check('[history off] nothing says "Visit history"', !/Visit history/.test(text()));
  const fam = [...document.querySelectorAll('nav button')].find((b) => /Family/.test(b.textContent));
  await act(async () => { fam.click(); });
  await flush();
  check('[history off] the Family tab still opens', /Everyone registered on this mobile number/.test(text()), text().slice(0, 200));
  check('[history off] ...without promising a history page',
    !/Tap anyone to view their visit history/.test(text()), text().slice(0, 240));
  // Tapping a member must not route to a view the clinic switched off.
  const member = [...document.querySelectorAll('button')].find((b) => /Kshitij Singh/.test(b.textContent));
  if (member) { await act(async () => { member.click(); }); await flush(); }
  check('[history off] tapping a family member does not open records',
    !/Visit history/.test(text()), text().slice(0, 200));
  check('[history off] the portal is still rendering', text().trim().length > 0 && !crashed, crashed && crashed.message);
} else {
  check('[history on] the History tab is offered', tabs().some((t) => /History/.test(t)), tabs());
  check('[history on] all three tabs are there', tabs().length === 3, tabs());
  const histBtn = [...document.querySelectorAll('nav button')].find((b) => /History/.test(b.textContent));
  await act(async () => { histBtn.click(); });
  await flush();
  check('[history on] it opens the visit history', /Visit history/.test(text()), text().slice(0, 200));
  check('[history on] showing the patient', /Kshitij Singh/.test(text()), text().slice(0, 160));
  check('[history on] nothing crashed', !crashed, crashed && crashed.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
