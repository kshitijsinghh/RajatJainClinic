// The 420px drawer behind a row in the message log.
//
// Everything in here is read-only except "Try again" — the drawer exists to
// answer "what actually happened to this message", which is the question
// reception asks when a patient says they never got anything.

import { failureReason, msgLook, msgStatus, triggerLook } from '../statusModel';
import { fmtClock, fmtDayOf, fmtPhone, Spinner, WaGlyph } from '../ui';

// The ladder is monotonic but lossy: Meta can report `read` without ever
// sending `delivered`. A step is therefore drawn as reached when anything
// later than it was reached, not only when its own timestamp exists.
function Timeline({ msg }) {
  const st = msgStatus(msg.status, msg.reply);
  const hasReply = !!msg.reply;
  const reachedIdx = hasReply ? 3 : st === 'seen' ? 2 : st === 'delivered' ? 1 : st === 'failed' ? -1 : 0;

  const steps = [
    { key: 'sent', label: 'Sent', at: msg.sentAt },
    { key: 'delivered', label: 'Delivered', at: msg.deliveredAt },
    { key: 'seen', label: 'Seen', at: msg.readAt },
    { key: 'replied', label: 'Replied', at: msg.repliedAt },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {steps.map((s, i) => {
        const reached = i <= reachedIdx;
        const last = i === steps.length - 1;
        return (
          <div key={s.key} style={{ display: 'flex', gap: 11, minHeight: last ? 'auto' : 34 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
              <span style={{
                width: 11, height: 11, borderRadius: '50%', marginTop: 3,
                background: reached ? '#12805a' : '#fff',
                border: '2px solid ' + (reached ? '#12805a' : '#d6e7e3'),
              }} />
              {!last && <span style={{ width: 2, flex: 1, minHeight: 20, background: i < reachedIdx ? '#12805a' : '#e8f1ef' }} />}
            </div>
            <div style={{ paddingBottom: last ? 0 : 10 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: reached ? '#0e3b39' : '#b0c5c1' }}>
                {s.label}
              </span>
              {reached && s.at && (
                <span style={{ display: 'block', fontSize: 12, color: '#7a9994' }}>
                  {fmtDayOf(s.at)} · {fmtClock(s.at)}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, padding: '7px 0', borderBottom: '1px solid #f3f8f7' }}>
      <span style={{ fontSize: 12.5, color: '#7a9994', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, color: '#0e3b39', fontWeight: 600, textAlign: 'right', minWidth: 0, wordBreak: 'break-word' }}>
        {children}
      </span>
    </div>
  );
}

export default function MessageDrawer({ msg, retrying, onClose, onRetry }) {
  if (!msg) return null;

  const st = msgStatus(msg.status, msg.reply);
  const look = msgLook(st);
  const trig = triggerLook(msg.useCase);

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(14,59,57,.35)' }} />
      <aside style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 420, maxWidth: '100vw', zIndex: 131,
        background: '#fff', borderLeft: '1px solid #dfece9', overflowY: 'auto',
        boxShadow: '-24px 0 60px -24px rgba(14,59,57,.4)',
      }}>
        <div style={{
          position: 'sticky', top: 0, background: '#fff', borderBottom: '1px solid #eef4f3',
          padding: '15px 18px', display: 'flex', alignItems: 'center', gap: 10, zIndex: 2,
        }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: trig.color, flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 16, color: '#0e3b39' }}>
            {trig.event}
          </span>
          <span style={{
            padding: '3px 11px', borderRadius: 100, fontWeight: 700, fontSize: 12,
            background: look.bg, color: look.ink, flexShrink: 0,
          }}>
            {look.label}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ width: 30, height: 30, flexShrink: 0, borderRadius: 8, border: 0, background: '#eef4f3', color: '#5c7a76', fontSize: 14, cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: '14px 18px 24px' }}>
          <Field label="Patient">{msg.name}</Field>
          <Field label="WhatsApp number">{fmtPhone(msg.mobile)}</Field>
          <Field label="Patient ID">{msg.patientId || '—'}</Field>
          <Field label="Template">
            <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>
              {msg.templateName || '—'}
            </code>
          </Field>
          <Field label="Visit">{msg.visitId || '—'}</Field>
          <Field label="Sent by">{msg.sentBy || 'Automatic'}</Field>
          <Field label="Reply">
            {msg.reply
              ? <span style={{
                display: 'inline-block', padding: '2px 10px', borderRadius: 100, fontWeight: 700, fontSize: 12.5,
                background: msg.reply === 'Coming' ? '#dff3e6' : '#fde3e0',
                color: msg.reply === 'Coming' ? '#0f5f42' : '#8c1d17',
              }}>{msg.reply}</span>
              : <span style={{ color: '#98b0ab', fontWeight: 400 }}>No reply yet</span>}
          </Field>

          <h4 style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#7a9994', margin: '20px 0 11px' }}>
            What happened
          </h4>
          <Timeline msg={msg} />

          {st === 'failed' && (
            <div style={{ background: '#fff8ec', border: '1px solid #f0dcb8', borderRadius: 13, padding: '13px 14px', marginTop: 18 }}>
              <p style={{ fontSize: 13.5, fontWeight: 700, color: '#8a4f0b' }}>Not delivered</p>
              <p style={{ fontSize: 12.5, color: '#8a4f0b', marginTop: 3, lineHeight: 1.45 }}>
                {failureReason(msg.failureCode, msg.failureReason)}
              </p>
              <div style={{ display: 'flex', gap: 9, marginTop: 12 }}>
                <a
                  href={'tel:' + String(msg.mobile || '').replace(/\D/g, '')}
                  style={{
                    flex: 1, minHeight: 40, borderRadius: 10, border: '1px solid #e2c795', background: '#fff',
                    color: '#8a4f0b', fontWeight: 700, fontSize: 13, textDecoration: 'none',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  Call patient
                </a>
                <button
                  onClick={() => onRetry(msg)}
                  disabled={retrying}
                  style={{
                    flex: 1, minHeight: 40, borderRadius: 10, border: 0, background: '#128c7e',
                    color: '#fff', fontWeight: 700, fontSize: 13, cursor: retrying ? 'default' : 'pointer',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  }}
                >
                  {retrying && <Spinner size={12} />}
                  {retrying ? 'Sending…' : 'Try again'}
                </button>
              </div>
            </div>
          )}

          <h4 style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#7a9994', margin: '20px 0 11px' }}>
            What the patient saw
          </h4>
          {/* Deliberately styled like WhatsApp: staff recognise the bubble
              instantly and stop asking whether this is the message or a
              summary of it. */}
          <div style={{ background: '#e4ddd4', borderRadius: 13, padding: 14 }}>
            <div style={{
              background: '#dcf8c6', borderRadius: '10px 10px 2px 10px', padding: '9px 11px',
              fontSize: 13.5, color: '#111b21', lineHeight: 1.5, whiteSpace: 'pre-wrap',
              boxShadow: '0 1px 1px rgba(0,0,0,.1)',
            }}>
              {msg.preview || '—'}
              <span style={{ display: 'block', textAlign: 'right', fontSize: 10.5, color: '#667781', marginTop: 4 }}>
                {fmtClock(msg.sentAt)}
              </span>
            </div>
            {(msg.buttons || []).length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
                {msg.buttons.map((b) => (
                  <div key={b} style={{
                    background: '#dcf8c6', borderRadius: 8, padding: '8px 11px', textAlign: 'center',
                    fontSize: 13.5, color: '#0a7cff', fontWeight: 500, borderTop: '1px solid rgba(0,0,0,.07)',
                  }}>
                    {b}
                  </div>
                ))}
              </div>
            )}
            <p style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#5c7a76', marginTop: 10 }}>
              <WaGlyph size={12} color="#5c7a76" />
              Sent from the clinic's WhatsApp number
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}
