// Four numbers for this month on the Patients tab.
//
// This is the whole of the "dashboard" the brief asked for. A separate
// dashboard tab is a page nobody opens between patients; four numbers on a
// tab the owner already visits is the same answer with no new habit.

import { useEffect, useState } from 'react';
import { patientMessageStats } from './waApi';
import { useWa } from './WaContext';

export default function MonthStats() {
  const wa = useWa();
  const [s, setS] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!wa.enabled) return undefined;
    patientMessageStats()
      .then((r) => { if (!cancelled) setS(r); })
      .catch(() => { if (!cancelled) setS(null); });
    return () => { cancelled = true; };
  }, [wa.enabled]);

  if (!wa.enabled || !s) return null;

  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');
  const cards = [
    { label: 'Messages this month', value: s.triggered, sub: 'sent on WhatsApp', ink: '#0e3b39' },
    { label: 'Reached patients', value: s.delivered, sub: pct(s.delivered, s.triggered) + ' of sent', ink: '#12805a' },
    { label: 'Replied', value: s.replied, sub: 'tapped Coming or Can\'t come', ink: '#0e756c' },
    { label: 'Not delivered', value: s.failed, sub: s.failed ? 'these need a phone call' : 'nothing to chase', ink: s.failed ? '#b8690f' : '#8aa8a3' },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 14 }}>
      {cards.map((c) => (
        <div key={c.label} style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 15, padding: '14px 16px' }}>
          <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#8aa8a3' }}>
            {c.label}
          </span>
          <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 22, color: c.ink, marginTop: 2 }}>
            {c.value}
          </span>
          <span style={{ display: 'block', fontSize: 12, color: '#98b0ab', marginTop: 2 }}>{c.sub}</span>
        </div>
      ))}
    </div>
  );
}
