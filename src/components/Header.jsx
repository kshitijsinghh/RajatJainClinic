import { useState, useEffect } from 'react';
import { TOUCH_BTN } from '../styles';
import { WaGlyph } from '../whatsapp/ui';
import { useWa } from '../whatsapp/WaContext';

const MESSAGES_MIN_WIDTH = 900;

export default function Header({ view, onGoDash, onGoAppts, onGoPatients, onGoMessages, user, onLogout }) {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 760);
  const [wide, setWide] = useState(window.innerWidth >= MESSAGES_MIN_WIDTH);
  const [accountOpen, setAccountOpen] = useState(false);
  const wa = useWa();

  // The Messages tab is not offered below 900px. Its own view explains why if
  // someone lands there by resizing, but the nav should not advertise a tab
  // that will tell you to go away.
  const showMessages = wa.enabled && wide && !!onGoMessages;

  useEffect(() => {
    const onResize = () => {
      const m = window.innerWidth < 760;
      setIsMobile((prev) => (prev !== m ? m : prev));
      const w = window.innerWidth >= MESSAGES_MIN_WIDTH;
      setWide((prev) => (prev !== w ? w : prev));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const userInitial = user ? (user.name || user.email || '?')[0].toUpperCase() : '?';
  const hasPicture = user && user.picture;
  const isPatView = view === 'patients' || view === 'patientDetail';

  const avatarBtn = (size, ml) => (
    <button
      onClick={() => setAccountOpen((o) => !o)}
      aria-label="Account"
      style={{
        width: size, height: size, flexShrink: 0, borderRadius: '50%',
        border: '2px solid rgba(127,212,201,.5)', background: '#0b302e',
        padding: 0, cursor: 'pointer', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginLeft: ml || 0,
      }}
    >
      {hasPicture ? (
        <img src={user.picture} alt="" referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : (
        <span style={{
          width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: '#12a094', color: '#fff', fontWeight: 700, fontSize: size === 34 ? 14 : 15,
          fontFamily: "'Bricolage Grotesque'",
        }}>
          {userInitial}
        </span>
      )}
    </button>
  );

  const signOutBtn = (
    <button
      onClick={() => { setAccountOpen(false); onLogout(); }}
      style={{
        padding: '9px 18px', borderRadius: 9, border: '1px solid rgba(255,255,255,.35)',
        background: 'rgba(255,255,255,.08)', color: '#fff', fontWeight: 700, fontSize: 13.5, cursor: 'pointer',
      }}
    >
      Sign out
    </button>
  );

  if (isMobile) {
    return (
      <header style={{ background: '#0e3b39', color: '#fff', position: 'sticky', top: 0, zIndex: 40 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 14px 8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
            <span style={{
              width: 30, height: 30, flexShrink: 0, borderRadius: 8,
              background: 'linear-gradient(135deg,#12a094,#0e756c)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="4" width="14" height="17" rx="2.5" />
                <path d="M9 4a3 3 0 0 1 6 0" />
                <path d="M9 12h6M9 16h4" />
              </svg>
            </span>
            <span style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 16, whiteSpace: 'nowrap' }}>
              PatientPad
            </span>
            <span style={{ fontSize: 12.5, color: '#7fd4c9', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
              · Dr. Jain's Dental Polyclinic
            </span>
          </div>
          {avatarBtn(34)}
        </div>
        <div style={{ display: 'flex', gap: 6, padding: '0 14px 10px' }}>
          <button onClick={onGoDash} style={{ ...TOUCH_BTN, flex: 1, padding: '11px 6px', borderRadius: 10, border: 0, cursor: 'pointer', fontWeight: 700, fontSize: 14, background: view === 'dashboard' ? '#12a094' : 'rgba(255,255,255,.12)', color: '#fff' }}>
            Visits
          </button>
          <button onClick={onGoAppts} style={{ ...TOUCH_BTN, flex: 1, padding: '11px 6px', borderRadius: 10, border: 0, cursor: 'pointer', fontWeight: 700, fontSize: 14, background: view === 'appointments' ? '#12a094' : 'rgba(255,255,255,.12)', color: '#fff' }}>
            Appointments
          </button>
          <button onClick={onGoPatients} style={{ ...TOUCH_BTN, flex: 1, padding: '11px 6px', borderRadius: 10, border: 0, cursor: 'pointer', fontWeight: 700, fontSize: 14, background: isPatView ? '#12a094' : 'rgba(255,255,255,.12)', color: '#fff' }}>
            Patients
          </button>
        </div>
        {accountOpen && (
          <div style={{ padding: '0 14px 12px', display: 'flex', justifyContent: 'flex-end' }}>
            {signOutBtn}
          </div>
        )}
      </header>
    );
  }

  return (
    <header style={{ background: '#0e3b39', color: '#fff', position: 'sticky', top: 0, zIndex: 40 }}>
      <div style={{
        maxWidth: 1180, margin: '0 auto', padding: '10px 14px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 auto' }}>
          <span style={{
            width: 36, height: 36, flexShrink: 0, borderRadius: 10,
            background: 'linear-gradient(135deg,#12a094,#0e756c)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
          }}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="4" width="14" height="17" rx="2.5" />
              <path d="M9 4a3 3 0 0 1 6 0" />
              <path d="M9 12h6M9 16h4" />
            </svg>
          </span>
          <span style={{ lineHeight: 1.05, minWidth: 0 }}>
            <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 16.5 }}>
              PatientPad
            </span>
            <span style={{
              display: 'block', fontSize: 9.5, letterSpacing: '.16em', textTransform: 'uppercase',
              color: '#7fd4c9', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              Dr. Jain's Dental Polyclinic
            </span>
          </span>
        </div>
        <nav style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          <button onClick={onGoDash} style={{ ...TOUCH_BTN, padding: '9px 15px', borderRadius: 9, border: 0, cursor: 'pointer', fontWeight: 700, fontSize: 13.5, background: view === 'dashboard' ? '#12a094' : 'rgba(255,255,255,.12)', color: '#fff' }}>
            Visits
          </button>
          <button onClick={onGoAppts} style={{ ...TOUCH_BTN, padding: '9px 15px', borderRadius: 9, border: 0, cursor: 'pointer', fontWeight: 700, fontSize: 13.5, background: view === 'appointments' ? '#12a094' : 'rgba(255,255,255,.12)', color: '#fff' }}>
            Appointments
          </button>
          <button onClick={onGoPatients} style={{ ...TOUCH_BTN, padding: '9px 15px', borderRadius: 9, border: 0, cursor: 'pointer', fontWeight: 700, fontSize: 13.5, background: isPatView ? '#12a094' : 'rgba(255,255,255,.12)', color: '#fff' }}>
            Patients
          </button>
          {showMessages && (
            <button onClick={onGoMessages} style={{ ...TOUCH_BTN, padding: '9px 15px', borderRadius: 9, border: 0, cursor: 'pointer', fontWeight: 700, fontSize: 13.5, background: view === 'messages' ? '#12a094' : 'rgba(255,255,255,.12)', color: '#fff', gap: 7 }}>
              <WaGlyph size={14} color="#fff" />
              Messages
            </button>
          )}
          {avatarBtn(36, 4)}
          {accountOpen && signOutBtn}
        </nav>
      </div>
    </header>
  );
}
