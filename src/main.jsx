import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import Login from './components/Login.jsx'
import { getStoredUser, signOut, SIGNED_OUT_EVENT } from './auth'

document.addEventListener('wheel', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type === 'number' && document.activeElement === e.target) {
    e.preventDefault();
  }
}, { passive: false });

function Root() {
  const [user, setUser] = useState(getStoredUser);

  // A refresh that fails destroys the session. Show the login screen then,
  // rather than letting someone keep working in a console whose every
  // authenticated call will be refused.
  useEffect(() => {
    const onSignedOut = () => setUser(null);
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, []);

  if (!user) return <Login onAuth={setUser} />;

  // Revokes the session server-side as well as locally, so the refresh token
  // cannot be used again by anyone who copied it.
  return <App user={user} onLogout={() => { signOut(); setUser(null); }} />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
