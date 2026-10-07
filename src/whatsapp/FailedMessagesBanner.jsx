// "3 WhatsApp messages didn't reach patients today."
//
// Collapsed by default and absent entirely at zero. A banner that is always
// there is a banner nobody reads, and this one only earns its place on the
// days something actually needs a phone call.

import { useCallback, useEffect, useState } from 'react';
import { failureReason, triggerLook } from './statusModel';
import { WaGlyph, fmtClock, todayYmd } from './ui';
import { failedMessages, resolveMessage } from './waApi';
import { useWa } from './WaContext';

export default function FailedMessagesBanner() {
  const wa = useWa();
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    if (!wa.enabled) return;
    failedMessages({ date: todayYmd() })
      .then(setRows)
      // Silent: a banner that cannot load is a banner that shows nothing,
      // which is exactly what it shows on a good day anyway.
      .catch(() => {});
  }, [wa.enabled]);

  useEffect(() => { load(); }, [load]);

  if (!wa.enabled || !rows.length) return null;

  async function markDone(id) {
    setBusyId(id);
    try {
      await resolveMessage(id);
      setRows((rs) => rs.filter((r) => r.messageId !== id));
    } catch { /* leave the row in place; it is still a real failure */ }
    finally { setBusyId(''); }
  }

  const n = rows.length;

  return (
    <div style={{ background: '#fff8ec', border: '1px solid #f0dcb8', borderRadius: 14, marginBottom: 14, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
          background: 'transparent', border: 0, padding: '12px 15px', cursor: 'pointer',
        }}
      >
        <WaGlyph size={16} color="#b8690f" />
        <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: '#8a4f0b', fontWeight: 600 }}>
          {n} WhatsApp {n === 1 ? 'message' : 'messages'} didn't reach patients today. Call them so they don't miss out.
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: '#8a4f0b', flexShrink: 0 }}>
          {open ? 'Hide' : 'Show'}
        </span>
      </button>

      {open && (
        <div style={{ borderTop: '1px solid #f0dcb8' }}>
          {rows.map((r) => {
            const reason = failureReason(r.failureCode, r.failureReason);
            const isReceipt = r.useCase === 'PAYMENT_RECEIPT' || r.useCase === 'EPRESCRIPTION';
            return (
              <div
                key={r.messageId}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                  padding: '11px 15px', borderTop: '1px solid #f7ebd6',
                }}
              >
                <span style={{ flex: '1 1 180px', minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5, color: '#0e3b39' }}>{r.name}</span>
                  <span style={{ display: 'block', fontSize: 12, color: '#8a4f0b' }}>
                    {triggerLook(r.useCase).event} · {reason}
                    {r.sentAt ? ' · ' + fmtClock(r.sentAt) : ''}
                  </span>
                </span>
                <a
                  href={'tel:' + String(r.mobile || '').replace(/\D/g, '')}
                  style={{
                    minHeight: 36, padding: '0 13px', borderRadius: 9, border: '1px solid #e2c795',
                    background: '#fff', color: '#8a4f0b', fontWeight: 700, fontSize: 12.5, textDecoration: 'none',
                    display: 'inline-flex', alignItems: 'center', flexShrink: 0,
                  }}
                >
                  Call
                </a>
                <span style={{
                  minHeight: 36, padding: '0 13px', borderRadius: 9, border: '1px solid #e2c795',
                  background: '#fff', color: '#8a4f0b', fontWeight: 700, fontSize: 12.5,
                  display: 'inline-flex', alignItems: 'center', flexShrink: 0,
                }}>
                  {isReceipt ? 'Print it instead' : 'Fix number'}
                </span>
                <button
                  onClick={() => markDone(r.messageId)}
                  disabled={busyId === r.messageId}
                  style={{
                    minHeight: 36, padding: '0 13px', borderRadius: 9, border: 0, background: '#0e756c',
                    color: '#fff', fontWeight: 700, fontSize: 12.5,
                    cursor: busyId === r.messageId ? 'default' : 'pointer', flexShrink: 0,
                  }}
                >
                  {busyId === r.messageId ? '…' : 'Done'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
