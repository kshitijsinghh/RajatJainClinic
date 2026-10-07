import { useEffect, useState } from 'react';
import { getClientId, looksAllowed, signInWithGoogleToken } from '../auth';

export default function Login({ onAuth }) {
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || !hash.includes('access_token')) return;
    setChecking(true);
    const params = new URLSearchParams(hash.substring(1));
    const accessToken = params.get('access_token');
    window.history.replaceState(null, '', window.location.pathname);
    if (!accessToken) { setChecking(false); return; }

    fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken },
    })
      .then((r) => r.json())
      .then(async (info) => {
        const email = (info.email || '').toLowerCase();
        // Local hint only — it saves a round trip for an obvious mistake. The
        // allow-list that actually decides lives server-side.
        if (!looksAllowed(email)) {
          setError('Access denied — ' + email + ' is not authorised.');
          setChecking(false);
          return;
        }
        const user = { email, name: info.name || email, picture: info.picture || '' };
        // Trade Google's token for our own session. Google is not involved
        // again until this session ends.
        await signInWithGoogleToken(accessToken, user);
        onAuth(user);
      })
      .catch((err) => {
        setError(err && err.message ? err.message : 'Something went wrong, please try again');
        setChecking(false);
      });
  }, [onAuth]);

  function handleSignIn() {
    const clientId = getClientId();
    if (!clientId) { setError('Google Client ID not configured.'); return; }
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: window.location.origin,
        response_type: 'token',
        scope: 'email profile',
        prompt: 'select_account',
      }).toString();
    window.location.href = authUrl;
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#eef4f3',
    }}>
      <div style={{
        background: '#fff', borderRadius: 20, padding: '48px 36px', textAlign: 'center',
        boxShadow: '0 8px 40px rgba(14,59,57,.08)', maxWidth: 400, width: '90%',
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: 16, margin: '0 auto 18px',
          background: 'linear-gradient(135deg,#12a094,#0e756c)', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="4" width="14" height="17" rx="2.5" />
            <path d="M9 4a3 3 0 0 1 6 0" />
            <path d="M9 12h6M9 16h4" />
          </svg>
        </div>
        <h1 style={{
          fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 24,
          color: '#0e3b39', margin: '0 0 4px',
        }}>
          PatientPad
        </h1>
        <p style={{
          fontSize: 12, letterSpacing: '.15em', textTransform: 'uppercase',
          color: '#5c7a76', fontWeight: 600, margin: '0 0 28px',
        }}>
          Dr. Jain's Dental Polyclinic
        </p>

        {checking ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '8px 0' }}>
            <div style={{
              width: 40, height: 40, border: '3.5px solid #d6e7e3',
              borderTopColor: '#12a094', borderRadius: '50%',
              animation: 'spin .7s linear infinite',
            }} />
            <span style={{ color: '#5c7a76', fontSize: 14, fontWeight: 600 }}>Signing in...</span>
          </div>
        ) : (
          <button
            onClick={handleSignIn}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 10, padding: '12px 28px',
              border: '1px solid #dadce0', borderRadius: 100, background: '#fff',
              fontSize: 15, fontWeight: 500, color: '#3c4043', cursor: 'pointer',
              fontFamily: "'Hanken Grotesk', system-ui, sans-serif",
              boxShadow: '0 1px 3px rgba(0,0,0,.08)',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 48 48">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
              <path fill="#34A853" d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.28-3.14.76-4.59l-7.98-6.19A23.99 23.99 0 0 0 0 24c0 3.77.9 7.35 2.56 10.52l7.97-5.93z"/>
              <path fill="#FBBC05" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 5.93C6.51 42.62 14.62 48 24 48z"/>
            </svg>
            Sign in with Google
          </button>
        )}

        {error && (
          <p style={{ color: '#c0392b', fontSize: 13, fontWeight: 600, marginTop: 16 }}>{error}</p>
        )}
      </div>
    </div>
  );
}
