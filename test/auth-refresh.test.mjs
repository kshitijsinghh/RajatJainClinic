// refreshSession must tell "the server rejected this token" apart from "the
// request never got there". Only the first may end the session.
import { strict as A } from 'node:assert';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const events = [];
globalThis.window = { dispatchEvent: (e) => events.push(e.type) };
globalThis.Event = class { constructor(t) { this.type = t; } };

const { getAccessToken, clearSession } = await import('../src/auth.js');

let pass = 0, fail = 0;
const check = (n, ok, got) => { if (ok) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, got === undefined ? '' : JSON.stringify(got)); } };

const expiring = () => {
  store.clear(); events.length = 0;
  store.set('pp_session', JSON.stringify({
    user: { email: 'a@b.c' }, accessToken: 'old',
    expiresAt: Math.floor(Date.now() / 1000) + 60,          // inside the 5-min margin
    refreshToken: 'r1', refreshExpiresAt: Math.floor(Date.now() / 1000) + 43200,
  }));
};
const session = () => JSON.parse(store.get('pp_session') || 'null');

// A network failure: fetch rejects, so the error carries no status.
expiring();
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
check('a dropped request returns no token', (await getAccessToken()) === '');
check('...but keeps the session so the next attempt can work', !!session(), session());
check('...and does not announce a sign-out', events.length === 0, events);

// A 500: the server is unwell, the token is not.
expiring();
globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) });
check('a 500 keeps the session', (await getAccessToken()) === '' && !!session(), session());

// A 401: the token really is rejected.
expiring();
globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: 'Session ended', reuse: true }) });
check('a 401 ends the session', (await getAccessToken()) === '' && !session(), session());
check('...and announces the sign-out', events.includes('patientpad:signed-out'), events);

// A 403 likewise.
expiring();
globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ ok: false }) });
check('a 403 ends the session', (await getAccessToken()) === '' && !session());

// The happy path still rotates both tokens.
expiring();
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
  ok: true, token: 'new', expiresAt: Math.floor(Date.now() / 1000) + 1800,
  refreshToken: 'r2', refreshExpiresAt: Math.floor(Date.now() / 1000) + 43200 }) });
check('a successful refresh returns the new token', (await getAccessToken()) === 'new');
check('...and stores the rotated refresh token', session().refreshToken === 'r2', session().refreshToken);

// A token with plenty of life left is not refreshed at all.
store.clear(); events.length = 0;
store.set('pp_session', JSON.stringify({ user: {}, accessToken: 'fresh',
  expiresAt: Math.floor(Date.now() / 1000) + 1800, refreshToken: 'r1' }));
let called = false;
globalThis.fetch = async () => { called = true; throw new Error('should not be called'); };
check('a healthy token is used without a round trip', (await getAccessToken()) === 'fresh' && !called);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
