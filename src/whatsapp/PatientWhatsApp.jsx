// The two WhatsApp pieces on a patient's profile: the opted-out pill, and a
// card listing what has been sent to them.

import { useEffect, useState } from 'react';
import { failureReason, msgLook, msgStatus, triggerLook } from './statusModel';
import { fmtClock, fmtDayOf, WaGlyph } from './ui';
import { patientMessages } from './waApi';
import { useWa } from './WaContext';

// Staff cannot switch messages back on, and the pill does not pretend
// otherwise. Only the patient can, by sending START — an opt-out the clinic
// could reverse from its own console would not be an opt-out.
export function OptedOutPill({ mobile }) {
  const wa = useWa();
  if (!wa.enabled || !wa.isOptedOut(mobile)) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 100,
      fontSize: 12.5, fontWeight: 700, background: 'rgba(255,255,255,.14)',
      border: '1px solid rgba(255,255,255,.3)', color: '#dfeeeb',
    }}>
      <WaGlyph size={13} color="#dfeeeb" />
      WhatsApp off · patient's choice
    </span>
  );
}

export default function PatientWhatsAppCard({ patientId, patientName, mobile }) {
  const wa = useWa();
  const [rows, setRows] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!wa.enabled || !patientId) return undefined;
    patientMessages(patientId)
      .then((r) => { if (!cancelled) setRows(r); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [wa.enabled, patientId]);

  if (!wa.enabled) return null;

  const optedOut = wa.isOptedOut(mobile);
  const first = String(patientName || '').trim().split(/\s+/)[0] || 'this patient';

  return (
    <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, padding: '20px 22px', marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
        <WaGlyph size={17} />
        <h3 style={{ flex: 1, fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 16, color: '#0e3b39' }}>
          WhatsApp messages
        </h3>
        {rows && <span style={{ fontSize: 12.5, color: '#98b0ab' }}>{rows.length} sent</span>}
      </div>

      {optedOut && (
        <p style={{ fontSize: 13, color: '#5c7a76', lineHeight: 1.5, marginBottom: 12, padding: '10px 12px', background: '#f5f8f7', border: '1px solid #e2efec', borderRadius: 10 }}>
          If {first} wants messages again, ask them to send START to the clinic's WhatsApp.
        </p>
      )}

      {rows === null && <p style={{ fontSize: 13.5, color: '#98b0ab' }}>Loading…</p>}
      {rows !== null && rows.length === 0 && (
        <p style={{ fontSize: 13.5, color: '#98b0ab' }}>Nothing has been sent to {first} yet.</p>
      )}

      {rows !== null && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {rows.slice(0, 12).map((m) => {
            const st = msgStatus(m.status, m.reply);
            const look = msgLook(st);
            const trig = triggerLook(m.useCase);
            return (
              <div
                key={m.messageId}
                style={{
                  display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap',
                  border: '1px solid #eef4f3', borderRadius: 12, padding: '11px 13px',
                  background: st === 'failed' ? '#fffaf2' : '#fff',
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: trig.color, flexShrink: 0 }} />
                <span style={{ flex: '1 1 150px', minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: '#0e3b39' }}>{trig.event}</span>
                  <span style={{ display: 'block', fontSize: 12, color: '#98b0ab' }}>
                    {fmtDayOf(m.sentAt)} · {fmtClock(m.sentAt)}
                    {st === 'failed' ? ' · ' + failureReason(m.failureCode, m.failureReason) : ''}
                    {m.reply ? ' · Replied ' + m.reply : ''}
                  </span>
                </span>
                <span style={{
                  padding: '3px 10px', borderRadius: 100, fontWeight: 700, fontSize: 12,
                  background: look.bg, color: look.ink, flexShrink: 0,
                }}>
                  {look.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
