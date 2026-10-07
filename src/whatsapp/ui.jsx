// Small pieces shared by every WhatsApp surface: the glyph, a toast, and the
// date/time formatting the calendar and the log both do.

import { useEffect, useState } from 'react';

// 760px is the breakpoint the rest of the console already uses for "phone".
export function useIsPhone(breakpoint = 760) {
  const [phone, setPhone] = useState(typeof window !== 'undefined' ? window.innerWidth < breakpoint : false);
  useEffect(() => {
    const onResize = () => setPhone(window.innerWidth < breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return phone;
}

export function WaGlyph({ size = 16, color = '#128c7e' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm4.52 11.97c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.16.24-.64.8-.79.97-.14.16-.29.18-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.13-.14.17-.25.25-.41.08-.16.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.42-.56-.43h-.48c-.16 0-.43.06-.65.31-.22.24-.86.84-.86 2.05 0 1.21.88 2.38 1 2.55.12.16 1.73 2.64 4.19 3.7.59.25 1.04.4 1.4.51.59.19 1.12.16 1.54.1.47-.07 1.47-.6 1.68-1.18.21-.58.21-1.08.14-1.18-.06-.11-.22-.17-.47-.29z" />
    </svg>
  );
}

export function Spinner({ size = 14, color = '#fff', track = 'rgba(255,255,255,.35)' }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%', border: '2px solid ' + track,
      borderTopColor: color, display: 'inline-block', animation: 'spin .8s linear infinite', flexShrink: 0,
    }} />
  );
}

export function Toast({ message }) {
  if (!message) return null;
  return (
    <div style={{
      position: 'fixed', left: '50%', bottom: 26, transform: 'translateX(-50%)', zIndex: 200,
      background: '#0e3b39', color: '#fff', padding: '12px 20px', borderRadius: 12,
      fontSize: 14, fontWeight: 600, boxShadow: '0 18px 40px -14px rgba(14,59,57,.6)',
      maxWidth: 'calc(100vw - 40px)', textAlign: 'center',
    }}>
      {message}
    </div>
  );
}

/* ── Dates and times ──────────────────────────────────────────────────── */

export function pad2(n) { return String(n).padStart(2, '0'); }

export function ymd(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
export function todayYmd() { return ymd(new Date()); }

// Parsed as local midnight, never `new Date('2026-10-03')` — that is parsed as
// UTC, which moves the day backwards for every clinic east of Greenwich.
export function parseYmd(s) {
  const [y, m, d] = String(s || '').split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function fmtDay(s, opts) {
  try { return parseYmd(s).toLocaleDateString('en-IN', opts || { day: 'numeric', month: 'short' }); }
  catch { return s; }
}

// The day an instant falls on, in the clinic's own timezone.
//
// For a timestamp, use this rather than fmtDay(iso.slice(0, 10)). Those first
// ten characters are the UTC date, so between midnight and 5:30am IST they
// name the previous day — while fmtClock beside them shows the local time,
// and a receipt sent at 3:23am on the 4th reads "3 Oct 3:23 am".
export function fmtDayOf(iso, opts) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-IN', opts || { day: 'numeric', month: 'short' });
  } catch { return ''; }
}

// Minutes since midnight → "11:30 AM".
export function fmtMin(m) {
  const h = Math.floor(m / 60);
  return ((h + 11) % 12 + 1) + ':' + pad2(m % 60) + (h < 12 ? ' AM' : ' PM');
}

// "14:30" → 870. Accepts "2:30 PM" too, because the Sheet holds both.
export function toMinutes(t) {
  const s = String(t || '').trim();
  if (!s) return null;
  const ampm = /PM/i.test(s) ? 12 : /AM/i.test(s) ? 0 : null;
  const [hRaw, mRaw] = s.replace(/\s*[AP]M/i, '').split(':');
  let h = Number(hRaw);
  const m = Number(mRaw || 0);
  if (isNaN(h)) return null;
  if (ampm !== null) h = (h % 12) + ampm;
  return h * 60 + (isNaN(m) ? 0 : m);
}

// 870 → "14:30", for an <input type="time">.
export function toTimeInput(m) {
  if (m == null) return '';
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

export function maskPhone(mobile) {
  const d = String(mobile || '').replace(/\D/g, '').slice(-10);
  if (d.length < 10) return d;
  return d.slice(0, 2) + '••••' + d.slice(-4);
}

export function fmtPhone(mobile) {
  const d = String(mobile || '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? '+91 ' + d.slice(0, 5) + ' ' + d.slice(5) : String(mobile || '');
}

// "3:12 PM" from an ISO timestamp, for "Sent 3:12 PM".
export function fmtClock(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
}
