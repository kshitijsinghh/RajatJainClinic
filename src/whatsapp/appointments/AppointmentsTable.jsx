// The table view. Same events as the grid, same pop-up on click — this is a
// different shape for the same day, not a different screen.

import { apptLook, replyPill, waShort } from '../statusModel';
import { fmtDay, fmtMin } from '../ui';

function ReplyCell({ status, size }) {
  const pill = replyPill(status);
  if (pill.bg === 'transparent') {
    return <span style={{ fontSize: size || 12.5, color: '#98b0ab' }}>{pill.text}</span>;
  }
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 100,
      fontWeight: 700, fontSize: size || 12.5, background: pill.bg, color: pill.ink,
    }}>
      {pill.text}
    </span>
  );
}

export default function AppointmentsTable({ events, onOpenEvent, isMobile }) {
  if (!events.length) {
    return (
      <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, padding: '54px 20px', textAlign: 'center' }}>
        <p style={{ fontSize: 15.5, fontWeight: 600, color: '#5c7a76' }}>No appointments in this range.</p>
      </div>
    );
  }

  if (isMobile) {
    return (
      <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, overflow: 'hidden' }}>
        {events.map((ev, i) => {
          const look = apptLook(ev.status);
          return (
            <button
              key={ev.appointmentId}
              onClick={(e) => onOpenEvent(ev, e.currentTarget)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
                background: '#fff', border: 0, borderTop: i ? '1px solid #eef4f3' : 0,
                padding: 0, cursor: 'pointer',
              }}
            >
              <span style={{ width: 6, alignSelf: 'stretch', minHeight: 70, background: look.bar, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, padding: '13px 0' }}>
                <span style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <span style={{ fontWeight: 700, color: '#0e3b39', fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {ev.name}
                  </span>
                  <span style={{ fontWeight: 700, color: '#0e756c', fontSize: 13.5, flexShrink: 0 }}>{fmtMin(ev.startMin)}</span>
                </span>
                <span style={{ display: 'block', fontSize: 12.5, color: '#5c7a76', marginTop: 2 }}>
                  {(ev.treatment || '—')} · {fmtDay(ev.date)}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                  <ReplyCell status={ev.status} size={12} />
                  <span style={{ fontSize: 11.5, color: '#98b0ab' }}>{waShort(ev.status)}</span>
                </span>
              </span>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#0e756c" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginRight: 14 }}>
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: 820 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#7a9994', fontSize: 11.5, letterSpacing: '.05em', textTransform: 'uppercase' }}>
              <th style={{ padding: '12px 10px 12px 20px', fontWeight: 700, width: 30 }} />
              <th style={{ padding: '12px 10px', fontWeight: 700 }}>Date</th>
              <th style={{ padding: '12px 10px', fontWeight: 700 }}>Time</th>
              <th style={{ padding: '12px 10px', fontWeight: 700 }}>Patient</th>
              <th style={{ padding: '12px 10px', fontWeight: 700 }}>Treatment</th>
              <th style={{ padding: '12px 10px', fontWeight: 700 }}>WhatsApp</th>
              <th style={{ padding: '12px 20px 12px 10px', fontWeight: 700 }}>Reply</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => {
              const look = apptLook(ev.status);
              return (
                <tr
                  key={ev.appointmentId}
                  onClick={(e) => onOpenEvent(ev, e.currentTarget)}
                  style={{ borderTop: '1px solid #eef4f3', cursor: 'pointer' }}
                >
                  <td style={{ padding: '12px 10px 12px 20px' }}>
                    <span style={{
                      display: 'block', width: 12, height: 12, borderRadius: 4,
                      background: look.bg, border: '1px solid ' + look.bd, borderLeft: '3px solid ' + look.bar,
                    }} />
                  </td>
                  <td style={{ padding: '12px 10px', color: '#33534f', whiteSpace: 'nowrap' }}>
                    {fmtDay(ev.date, { weekday: 'short', day: 'numeric', month: 'short' })}
                  </td>
                  <td style={{ padding: '12px 10px', fontWeight: 700, color: '#0e3b39', whiteSpace: 'nowrap' }}>
                    {fmtMin(ev.startMin)} – {fmtMin(ev.endMin)}
                  </td>
                  <td style={{ padding: '12px 10px' }}>
                    <span style={{ display: 'block', color: '#0e3b39', fontWeight: 600 }}>{ev.name}</span>
                    <span style={{ display: 'block', fontSize: 12.5, color: '#98b0ab' }}>{ev.mobile}</span>
                  </td>
                  <td style={{ padding: '12px 10px', color: '#5c7a76' }}>{ev.treatment || '—'}</td>
                  <td style={{ padding: '12px 10px', color: '#5c7a76', whiteSpace: 'nowrap' }}>{waShort(ev.status)}</td>
                  <td style={{ padding: '12px 20px 12px 10px' }}><ReplyCell status={ev.status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
