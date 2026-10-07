// The event pop-up: a card anchored to the event on desktop, a sheet that
// slides up from the bottom on a phone. It also owns the inline reschedule
// form and the cancel confirmation, because all three are the same decision
// about the same appointment and splitting them would mean passing the
// appointment through three components to say one thing.

import { useLayoutEffect, useRef, useState } from 'react';
import {
  apptLook, firstName, replyPill, replySub, waBlock,
  APPT_CANT, APPT_COMING, APPT_FAILED, APPT_NOT_SENT, APPT_OFF,
} from '../statusModel';
import { WaGlyph, Spinner, fmtClock, fmtDay, fmtMin, toTimeInput, toMinutes } from '../ui';

function TrashIcon({ color = '#c0392b', size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

export function CancelModal({ ev, optedOut, busy, onKeep, onConfirm }) {
  if (!ev) return null;
  const first = firstName(ev.name);
  const line = optedOut
    ? first + ' has WhatsApp turned off — please call to let them know.'
    : first + ' will get a WhatsApp message that this appointment is cancelled, and any pending reminders will stop.';

  return (
    <div
      onClick={onKeep}
      style={{
        position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(14,59,57,.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 20, maxWidth: 400, width: '100%', padding: '26px 24px 22px',
          textAlign: 'center', boxShadow: '0 28px 60px -18px rgba(14,59,57,.55)',
        }}
      >
        <div style={{
          width: 48, height: 48, borderRadius: '50%', background: '#fdecea', margin: '0 auto 14px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <TrashIcon size={21} />
        </div>
        <h3 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 18.5, color: '#0e3b39' }}>
          Cancel this appointment?
        </h3>
        <p style={{ fontWeight: 700, fontSize: 15, color: '#0e3b39', marginTop: 10 }}>{ev.name}</p>
        <p style={{ fontSize: 14, color: '#5c7a76', marginTop: 2 }}>
          {fmtDay(ev.date, { weekday: 'long', day: 'numeric', month: 'long' })} · {fmtMin(ev.startMin)}
        </p>
        <p style={{ fontSize: 13.5, color: '#5c7a76', marginTop: 14, lineHeight: 1.5 }}>{line}</p>

        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button
            onClick={onKeep}
            disabled={busy}
            style={{
              flex: 1, minHeight: 44, borderRadius: 11, border: '1px solid #cfe3df', background: '#fff',
              color: '#0e756c', fontWeight: 700, fontSize: 14, cursor: busy ? 'default' : 'pointer',
            }}
          >
            Keep appointment
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            style={{
              flex: 1, minHeight: 44, borderRadius: 11, border: 0, background: busy ? '#d98b82' : '#c0392b',
              color: '#fff', fontWeight: 700, fontSize: 14, cursor: busy ? 'default' : 'pointer',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            {busy && <Spinner size={13} />}
            {busy ? 'Cancelling…' : 'Yes, cancel it'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Where a popover of `panelHeight` should sit so it stays fully on screen,
// given where its event is. Pulled out so the arithmetic can be tested: the
// bug was that the panel grew when the reschedule section opened and nothing
// re-checked whether the bottom still fit.
export function fitTop(anchorTop, panelHeight, viewportHeight, gap = 12) {
  const want = Math.max(gap, anchorTop || 80);
  const highest = Math.max(gap, viewportHeight - panelHeight - gap);
  return Math.min(want, highest);
}

export default function EventPopover({
  ev, anchor, isMobile, optedOut, busy, error,
  onClose, onSendNow, onReschedule, onAskCancel, onOpenVisit,
}) {
  const [resOpen, setResOpen] = useState(false);
  const [resDate, setResDate] = useState(ev ? ev.date : '');
  const [resTime, setResTime] = useState(ev ? toTimeInput(ev.startMin) : '');

  // Where the popover actually sits, measured rather than guessed.
  //
  // The position used to be clamped against a hard-coded 440px height. Open
  // the reschedule panel and the popover grows well past that, so its bottom
  // — and the Save button with it — fell off the screen with no way to reach
  // it. Measuring after every render that can change the height lifts it
  // back into view instead.
  const panelRef = useRef(null);
  const [fittedTop, setFittedTop] = useState(null);

  useLayoutEffect(() => {
    if (isMobile || !ev) { setFittedTop(null); return; }
    const el = panelRef.current;
    if (!el) return;
    setFittedTop(fitTop((anchor && anchor.top) || 80, el.offsetHeight, window.innerHeight));
  }, [isMobile, anchor, resOpen, ev && ev.appointmentId]);

  if (!ev) return null;

  const look = apptLook(ev.status);
  const first = firstName(ev.name);
  const [waTitle, waSub, waInk] = waBlock(ev.status, first, fmtClock(ev.lastSentAt));
  const pill = replyPill(ev.status);
  const canSend = ev.status === APPT_NOT_SENT || ev.status === APPT_FAILED;
  const sendLabel = ev.status === APPT_FAILED ? 'Try again' : 'Send now';

  // What saving the reschedule will actually do, said before they press it.
  // The amber variant is the one that matters: the patient has already been
  // told a different time, and that message has to be corrected.
  const resMin = toMinutes(resTime);
  const changed = resDate !== ev.date || resMin !== ev.startMin;
  const newLabel = resDate ? fmtDay(resDate) + ', ' + (resMin == null ? '—' : fmtMin(resMin)) : '—';
  let resLine = 'Pick a new date or time.';
  let resInk = '#5c7a76';
  if (changed) {
    if (ev.status === APPT_OFF || optedOut) {
      resLine = first + ' has WhatsApp off — call to tell them the new time: ' + newLabel + '.';
    } else if (ev.status === APPT_NOT_SENT) {
      resLine = 'Saving will send ' + first + ' a WhatsApp confirmation for ' + newLabel + '.';
      resInk = '#33534f';
    } else {
      resLine = first + ' was told ' + fmtDay(ev.date) + ', ' + fmtMin(ev.startMin)
        + '. Saving cancels that reminder and sends the new time: ' + newLabel + '.';
      resInk = '#8a4f0b';
    }
  }

  // Until the first measurement lands, fall back to the old estimate so the
  // popover does not flash at the top of the screen.
  const desktopTop = fittedTop == null
    ? Math.min(Math.max(12, (anchor && anchor.top) || 80), Math.max(12, window.innerHeight - 440))
    : fittedTop;

  const shell = isMobile
    ? {
      position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 110, background: '#fff',
      borderRadius: '20px 20px 0 0', maxHeight: '88vh', overflowY: 'auto',
      boxShadow: '0 -20px 50px -20px rgba(14,59,57,.5)', paddingBottom: 'env(safe-area-inset-bottom)',
    }
    : {
      position: 'fixed', zIndex: 110, width: 380,
      left: Math.min(Math.max(12, (anchor && anchor.left) || 40), Math.max(12, window.innerWidth - 392)),
      top: desktopTop,
      background: '#fff', border: '1px solid #dfece9', borderRadius: 20,
      // Derived from the real top, not from the viewport alone: with a fixed
      // `top`, a max-height of 100vh still lets the panel run off the bottom.
      maxHeight: 'calc(100vh - ' + (desktopTop + 12) + 'px)', overflowY: 'auto',
      boxShadow: '0 28px 60px -18px rgba(14,59,57,.5)',
    };

  const row = (label, value) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0' }}>
      <span style={{ fontSize: 13, color: '#7a9994' }}>{label}</span>
      <span style={{ fontSize: 13.5, color: '#0e3b39', fontWeight: 600, textAlign: 'right' }}>{value}</span>
    </div>
  );

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 105, background: isMobile ? 'rgba(14,59,57,.45)' : 'transparent' }}
      />
      <div ref={panelRef} style={shell}>
        <div style={{ padding: '16px 18px 0', display: 'flex', alignItems: 'flex-start', gap: 11 }}>
          <span style={{ flexShrink: 0, width: 15, height: 15, borderRadius: 5, marginTop: 5, background: look.bar }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#7a9994' }}>
              {look.label}
            </p>
            <h3 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 18, color: '#0e3b39', marginTop: 2 }}>
              {ev.name}
            </h3>
            <a
              href={'tel:' + String(ev.mobile || '').replace(/\s/g, '')}
              style={{ fontSize: 13, color: '#0e756c', fontWeight: 600, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 3 }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#0e756c" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
              </svg>
              {ev.mobile}
            </a>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ width: 30, height: 30, flexShrink: 0, borderRadius: 8, border: 0, background: '#eef4f3', color: '#5c7a76', fontSize: 14, cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: '12px 18px 0' }}>
          <div style={{ borderTop: '1px solid #eef4f3', paddingTop: 8 }}>
            {row('When', fmtDay(ev.date, { weekday: 'long', day: 'numeric', month: 'long' }) + ' · ' + fmtMin(ev.startMin) + ' – ' + fmtMin(ev.endMin))}
            {row('Treatment', ev.treatment || '—')}
            {row('Visit', ev.visitId || '—')}
          </div>
        </div>

        {/* WhatsApp block */}
        <div style={{ padding: '12px 18px 0' }}>
          <div style={{ background: '#f7fbfa', border: '1px solid #eef4f3', borderRadius: 13, padding: '12px 13px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <WaGlyph size={15} />
              <span style={{ fontWeight: 700, fontSize: 13.5, color: waInk }}>{waTitle}</span>
            </div>
            {waSub && <p style={{ fontSize: 12.5, color: '#5c7a76', marginTop: 5, lineHeight: 1.45 }}>{waSub}</p>}

            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 10, flexWrap: 'wrap' }}>
              <span style={{
                display: 'inline-block', padding: '3px 11px', borderRadius: 100, fontWeight: 700, fontSize: 13,
                background: pill.bg, color: pill.ink,
                border: pill.bg === 'transparent' ? '1px dashed #cfe3df' : 0,
              }}>
                {ev.status === APPT_COMING ? '✓ ' : ev.status === APPT_CANT ? '✕ ' : ''}{pill.text}
              </span>
              {canSend && (
                <button
                  onClick={() => onSendNow(ev)}
                  disabled={busy}
                  style={{
                    minHeight: 34, padding: '0 14px', borderRadius: 9, border: 0, background: '#128c7e',
                    color: '#fff', fontWeight: 700, fontSize: 13, cursor: busy ? 'default' : 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 7, opacity: busy ? .7 : 1,
                  }}
                >
                  {busy ? <Spinner size={12} /> : <WaGlyph size={14} color="#fff" />}
                  {busy ? 'Sending…' : sendLabel}
                </button>
              )}
            </div>
            <p style={{ fontSize: 12, color: '#7a9994', marginTop: 7, lineHeight: 1.45 }}>
              {replySub(ev.status, first, fmtClock(ev.confirmation && ev.confirmation.answeredAt), ev.confirmation && ev.confirmation.changed)}
            </p>
          </div>
        </div>

        {error && (
          <p style={{ padding: '10px 18px 0', fontSize: 12.5, color: '#c0392b', fontWeight: 600 }}>{error}</p>
        )}

        {/* Footer: either the two actions, or the reschedule form in their place */}
        <div style={{ padding: '14px 18px 18px' }}>
          {!resOpen && (
            <div style={{ display: 'flex', gap: 9 }}>
              <button
                onClick={() => onAskCancel(ev)}
                style={{
                  flex: 1, minHeight: 44, borderRadius: 11, border: '1px solid #f0c8c2', background: '#fff',
                  color: '#c0392b', fontWeight: 700, fontSize: 13.5, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                }}
              >
                <TrashIcon />
                Cancel appointment
              </button>
              <button
                onClick={() => { setResDate(ev.date); setResTime(toTimeInput(ev.startMin)); setResOpen(true); }}
                style={{
                  flex: 1, minHeight: 44, borderRadius: 11, border: 0, background: '#0e756c',
                  color: '#fff', fontWeight: 700, fontSize: 13.5, cursor: 'pointer',
                }}
              >
                Reschedule
              </button>
            </div>
          )}

          {resOpen && (
            <div style={{ borderTop: '1px solid #eef4f3', paddingTop: 13 }}>
              <div style={{ display: 'flex', gap: 9 }}>
                <label style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: '#7a9994', marginBottom: 4 }}>New date</span>
                  <input
                    type="date" value={resDate} onChange={(e) => setResDate(e.target.value)}
                    style={{ width: '100%', minHeight: 44, padding: '0 10px', borderRadius: 10, border: '1px solid #cfe3df', fontSize: 14, color: '#0e3b39', background: '#fff' }}
                  />
                </label>
                <label style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: '#7a9994', marginBottom: 4 }}>New time</span>
                  <input
                    type="time" value={resTime} onChange={(e) => setResTime(e.target.value)}
                    style={{ width: '100%', minHeight: 44, padding: '0 10px', borderRadius: 10, border: '1px solid #cfe3df', fontSize: 14, color: '#0e3b39', background: '#fff' }}
                  />
                </label>
              </div>
              <p style={{ fontSize: 12.5, color: resInk, marginTop: 9, lineHeight: 1.45 }}>{resLine}</p>
              <div style={{ display: 'flex', gap: 9, marginTop: 12 }}>
                <button
                  onClick={() => setResOpen(false)}
                  disabled={busy}
                  style={{
                    flex: 1, minHeight: 44, borderRadius: 11, border: '1px solid #cfe3df', background: '#fff',
                    color: '#0e756c', fontWeight: 700, fontSize: 13.5, cursor: busy ? 'default' : 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => onReschedule(ev, resDate, resTime)}
                  disabled={busy || !changed || !resDate || resMin == null}
                  style={{
                    flex: 1, minHeight: 44, borderRadius: 11, border: 0,
                    background: (busy || !changed || !resDate || resMin == null) ? '#9ec9c3' : '#0e756c',
                    color: '#fff', fontWeight: 700, fontSize: 13.5,
                    cursor: (busy || !changed) ? 'default' : 'pointer',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  }}
                >
                  {busy && <Spinner size={13} />}
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )}

          {!resOpen && onOpenVisit && ev.visitId && (
            <button
              onClick={() => onOpenVisit(ev)}
              style={{
                width: '100%', minHeight: 40, marginTop: 9, borderRadius: 10, border: 0, background: 'transparent',
                color: '#0e756c', fontWeight: 700, fontSize: 13, cursor: 'pointer',
              }}
            >
              Open visit →
            </button>
          )}
        </div>
      </div>
    </>
  );
}
