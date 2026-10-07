// Session handling.
//
// What changed and why: the previous version checked an allow-list that was
// compiled into the public bundle, inside the browser, and stored the "user"
// as a plain object in localStorage. Both were advisory — setting that key by
// hand logged you in, and nothing was ever sent to the server anyway.
//
// Now the browser holds two server-issued credentials:
//
//   accessToken   a signed JWT sent with every request; Apps Script verifies
//                 it. Short-lived (~30 min) so a copied one expires quickly.
//   refreshToken  exchanged for a new access token without involving Google.
//                 Single-use: each refresh returns a new one.
//
// Google's own token is used exactly once, at sign-in, and then discarded —
// it expires in about an hour and the implicit flow issues nothing to renew
// it, so the session cannot be tied to its lifetime.

const AWS_URL = import.meta.env.VITE_AWS_API_URL;
const CLINIC_ID = import.meta.env.VITE_CLINIC_ID || '';
const SESSION_KEY = 'pp_session';

// Refresh this far before expiry so a request is never issued with a token
// that dies in flight.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Kept only to show a helpful message before the round trip. The real
// allow-list is in DynamoDB and enforced server-side; this cannot grant
// access to anyone.
const HINT_EMAILS = (import.meta.env.VITE_ALLOWED_EMAILS || '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

export function looksAllowed(email) {
  if (!HINT_EMAILS.length) return true;      // no hint configured: let the server decide
  return HINT_EMAILS.includes(String(email || '').toLowerCase());
}

function read() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function write(session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* private mode */ }
}

// Fired whenever the session is destroyed, so the shell can show the login
// screen instead of leaving a signed-out console looking signed in.
//
// Without this, a failed refresh wiped the session silently and the app
// carried on: the Sheet, the PDFs and the org record are all reachable
// without a token, so nothing visibly broke until a /whatsapp/* call came
// back 403 with no explanation.
export const SIGNED_OUT_EVENT = 'patientpad:signed-out';

export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem('clinic_auth'); } catch { /* the old forgeable key */ }
  try { window.dispatchEvent(new Event(SIGNED_OUT_EVENT)); } catch { /* not a browser */ }
}

export function getStoredUser() {
  const s = read();
  if (!s || !s.user) return null;
  // The refresh token is what keeps the session alive; once it is gone the
  // session is over regardless of what else is cached.
  if (!s.refreshToken || (s.refreshExpiresAt && Date.now() / 1000 > s.refreshExpiresAt)) {
    clearSession();
    return null;
  }
  return s.user;
}

async function authPost(route, body) {
  if (!AWS_URL) throw new Error('VITE_AWS_API_URL is not configured.');
  const res = await fetch(`${AWS_URL}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clinicId: CLINIC_ID, ...body }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* fall through to the status check */ }
  if (!res.ok || !json || json.ok === false) {
    const e = new Error((json && json.error) || 'Sign-in failed, please try again');
    e.status = res.status;
    e.reuse = !!(json && json.reuse);
    throw e;
  }
  return json;
}

// Exchanges Google's one-time proof of identity for our own session.
export async function signInWithGoogleToken(googleAccessToken, user) {
  const r = await authPost('/auth/token', { kind: 'staff', googleAccessToken });
  write({
    user, role: r.role,
    accessToken: r.token, expiresAt: r.expiresAt,
    refreshToken: r.refreshToken, refreshExpiresAt: r.refreshExpiresAt,
  });
  return r;
}

// The portal's equivalent. Firebase keeps its own session alive, so a fresh
// ID token is always obtainable without asking the patient to log in again.
export async function signInWithFirebaseToken(firebaseIdToken) {
  const r = await authPost('/auth/token', { kind: 'patient', firebaseIdToken });
  write({
    user: { role: 'patient' }, role: r.role,
    accessToken: r.token, expiresAt: r.expiresAt,
  });
  return r;
}

// The portal's other door: a patient who signs in with Google rather than a
// phone OTP. The resulting token is scoped by the Google-verified EMAIL
// instead of a phone number, and the clinic server matches it against the
// email on the patient record.
export async function signInWithGooglePatientToken(googleAccessToken) {
  const r = await authPost('/auth/token', { kind: 'patient_google', googleAccessToken });
  write({
    user: { role: 'patient' }, role: r.role,
    accessToken: r.token, expiresAt: r.expiresAt,
  });
  return r;
}

// True when a usable patient/staff token is still in hand. The portal uses it
// to decide whether a page reload can go straight to the records or has to
// show the login screen again — patient tokens carry no refresh token, so an
// expired one cannot be renewed without signing in.
export function hasLiveToken() {
  const s = read();
  if (!s || !s.accessToken) return false;
  return (s.expiresAt || 0) * 1000 - Date.now() > 30 * 1000;
}

// ── Patient portal: OTP over WhatsApp ───────────────────────────────────
//
// Unlike the Firebase path, the clinic server issues the code and the token
// itself. Both endpoints are deliberately unauthenticated — they are how a
// patient GETS a token — and carry their own rate limiting instead.

export async function requestPortalOtp(phone) {
  return authPost('/portal/otp/request', { phone });
}

export async function signInWithPortalOtp(phone, code) {
  const r = await authPost('/portal/otp/verify', { phone, code });
  write({
    user: { role: 'patient' }, role: r.role,
    accessToken: r.token, expiresAt: r.expiresAt,
  });
  return r;
}

let refreshInFlight = null;

async function refreshSession() {
  const s = read();
  if (!s || !s.refreshToken) throw new Error('No session');

  // Several requests can notice an expiring token at once; they must share a
  // single refresh, because the refresh token is single-use and a second
  // call would look like a replay and revoke the whole session.
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const r = await authPost('/auth/refresh', { refreshToken: s.refreshToken });
      write({ ...s, accessToken: r.token, expiresAt: r.expiresAt,
              refreshToken: r.refreshToken, refreshExpiresAt: r.refreshExpiresAt });
      return r.token;
    } catch (err) {
      // Only a server that actually rejected the token ends the session.
      //
      // This used to clear on any throw, which meant a dropped request, a
      // 500 or a CORS hiccup signed the doctor out mid-consultation — and
      // when /auth/refresh was failing server-side on a reserved-word bug,
      // that turned one broken endpoint into a sign-out every half hour.
      // The refresh token is still valid in all those cases, so keeping it
      // lets the next attempt succeed.
      const status = err && err.status;
      if (status === 401 || status === 403) clearSession();
      throw err;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

// The token to send with a request, refreshed first if it is close to expiry.
// Returns '' when there is no session, so callers behave exactly as before
// while a clinic is still running with authMode off.
export async function getAccessToken() {
  const s = read();
  if (!s || !s.accessToken) return '';
  const msLeft = (s.expiresAt || 0) * 1000 - Date.now();
  if (msLeft > REFRESH_MARGIN_MS) return s.accessToken;
  if (!s.refreshToken) return s.accessToken;   // patient sessions do not refresh this way
  try { return await refreshSession(); } catch { return ''; }
}

// Called when the server rejects a token mid-session: force one refresh so a
// single expired token does not surface as an error to the doctor.
export async function forceRefresh() {
  try { return await refreshSession(); } catch { return ''; }
}

export async function signOut() {
  const s = read();
  clearSession();
  if (s && s.refreshToken) {
    // Best effort: the session is already gone locally either way.
    try { await authPost('/auth/logout', { refreshToken: s.refreshToken }); } catch { /* ignore */ }
  }
}

export function getClientId() {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
}

// Retained for callers that still import it; the real check is server-side.
export const isAllowed = looksAllowed;
export function storeUser() { /* superseded by signInWithGoogleToken */ }
export function clearUser() { clearSession(); }
