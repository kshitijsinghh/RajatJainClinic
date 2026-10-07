import { useState, useEffect } from 'react';
import { TOUCH_BTN } from '../styles';
import MonthStats from '../whatsapp/MonthStats';

function num(x) { const n = parseFloat(x); return isNaN(n) ? 0 : n; }
function inr(n) { return '₹' + Math.round(n).toLocaleString('en-IN'); }

const PAY_MAP = {
  'Fully Paid': ['#e3f5ec', '#12805a'],
  'Partially paid': ['#fdf0dc', '#a9741a'],
  'Not paid': ['#fdecea', '#c0392b'],
};

const PHONE_SVG = (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M6.62 10.79a15.53 15.53 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02l-2.2 2.2z" />
  </svg>
);

export default function Patients({ allPatients, outstandingTotal, onOpenPatient }) {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 760);
  const [pq, setPq] = useState('');
  const [patFrom, setPatFrom] = useState('');
  const [patTo, setPatTo] = useState('');
  const [patPayFilter, setPatPayFilter] = useState('All');
  const [page, setPage] = useState(1);
  const [outstandingOnly, setOutstandingOnly] = useState(false);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 760);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => { setPage(1); }, [pq, patFrom, patTo, patPayFilter, outstandingOnly]);

  let filtered = [...allPatients];
  if (patFrom) filtered = filtered.filter((p) => p.lastDate >= patFrom);
  if (patTo) filtered = filtered.filter((p) => p.lastDate <= patTo);

  const qq = pq.trim().toLowerCase();
  if (qq) filtered = filtered.filter((p) => (p.name + ' ' + p.mobile + ' ' + p.patientId).toLowerCase().includes(qq));

  if (outstandingOnly) {
    filtered = filtered.filter((p) => p.outstanding > 0);
  } else if (patPayFilter !== 'All') {
    filtered = filtered.filter((p) => p.status === patPayFilter);
  }

  filtered.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));

  const perPage = isMobile ? 6 : 10;
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(page, totalPages);
  const pageItems = filtered.slice((safePage - 1) * perPage, safePage * perPage);
  const showPager = totalPages > 1;

  const payFilterOptions = ['All', 'Not paid', 'Partially paid', 'Fully Paid'];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h2 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 22, color: '#0e3b39' }}>Patients</h2>
          <p style={{ color: '#5c7a76', fontSize: 14.5, marginTop: 2 }}>All registered patients, most recent visit first.</p>
        </div>

        {!isMobile && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#5c7a76', fontWeight: 600 }}>
            From
            <input type="date" value={patFrom} onChange={(e) => setPatFrom(e.target.value)}
              style={{ padding: '9px 11px', border: '1px solid #cfe3df', borderRadius: 9, fontSize: 13.5, background: '#fff' }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#5c7a76', fontWeight: 600 }}>
            To
            <input type="date" value={patTo} onChange={(e) => setPatTo(e.target.value)}
              style={{ padding: '9px 11px', border: '1px solid #cfe3df', borderRadius: 9, fontSize: 13.5, background: '#fff' }} />
          </label>
          <button onClick={() => { setPatFrom(''); setPatTo(''); }}
            style={{ padding: '9px 13px', borderRadius: 9, border: '1px solid #d6e7e3', background: '#fff', color: '#5c7a76', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            Clear
          </button>
        </div>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 16 }}>
        <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 15, padding: '14px 16px' }}>
          <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#8aa8a3' }}>Patients</span>
          <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 27, color: '#0e756c', marginTop: 2 }}>{allPatients.length}</span>
        </div>
        <div onClick={() => { setOutstandingOnly(true); setPatPayFilter('All'); }}
          style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 15, padding: '14px 16px', cursor: 'pointer' }}>
          <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#8aa8a3' }}>Outstanding payment</span>
          <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 27, color: '#ef5a3c', marginTop: 2 }}>{inr(outstandingTotal)}</span>
          <span style={{ display: 'block', fontSize: 11.5, color: '#98b0ab', marginTop: 2 }}>Tap to view unpaid patients →</span>
        </div>
      </div>

      <MonthStats />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <input className="fld" value={pq} onChange={(e) => setPq(e.target.value)} placeholder="Search name, mobile or ID…"
          style={{ flex: '0 1 300px', minWidth: 180, padding: '11px 14px', border: '1px solid #d6e7e3', borderRadius: 11, fontSize: 14.5, background: '#fff', minHeight: 44 }} />
        <button onClick={() => document.activeElement && document.activeElement.blur()}
          style={{ ...TOUCH_BTN, padding: '11px 20px', borderRadius: 11, border: 0, background: '#0e756c', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', gap: 8 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
          Search
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#8aa8a3', textTransform: 'uppercase', letterSpacing: '.05em' }}>Payment</span>
        {payFilterOptions.map((val) => (
          <button key={val} onClick={() => { setOutstandingOnly(false); setPatPayFilter(val); }}
            style={{
              ...TOUCH_BTN, padding: '8px 14px', borderRadius: 100, cursor: 'pointer',
              border: '1px solid ' + ((patPayFilter === val && !outstandingOnly) ? '#0e756c' : '#d6e7e3'),
              background: (patPayFilter === val && !outstandingOnly) ? '#0e756c' : '#fff',
              color: (patPayFilter === val && !outstandingOnly) ? '#fff' : '#5c7a76',
              fontWeight: 700, fontSize: 13,
            }}
          >
            {val}
          </button>
        ))}
      </div>

      {filtered.length > 0 && (
        <>
          <div className="card-view">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 12 }}>
              {pageItems.map((p) => {
                const [stBg, stInk] = PAY_MAP[p.status] || ['#eef4f3', '#8aa8a3'];
                return (
                  <div key={p.patientId} onClick={() => onOpenPatient(p.patientId)}
                    style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 16, padding: '16px 18px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontWeight: 700, color: '#0e3b39', fontSize: 16.5 }}>{p.name}</span>
                        <span style={{ display: 'block', fontSize: 12.5, color: '#98b0ab' }}>
                          <span style={{ fontFamily: 'ui-monospace,monospace', color: '#0e756c', fontWeight: 600 }}>{p.patientId}</span> · {p.ageGender}
                        </span>
                      </div>
                      <span style={{ flexShrink: 0, display: 'inline-block', padding: '4px 11px', borderRadius: 100, fontSize: 12, fontWeight: 700, background: stBg, color: stInk }}>{p.status}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderTop: '1px solid #f0f6f5', paddingTop: 10 }}>
                      <div style={{ fontSize: 13, color: '#5c7a76', lineHeight: 1.35 }}>
                        <span style={{ display: 'block' }}>Last visit: <strong style={{ color: '#33534f' }}>{p.lastLabel}</strong> · {p.visitCount} visit(s)</span>
                        <span style={{ display: 'block' }}>{p.mobile}</span>
                        {p.outstanding > 0 && (
                          <span style={{ display: 'block', color: '#c0392b', fontWeight: 700, marginTop: 2 }}>Outstanding: {inr(p.outstanding)}</span>
                        )}
                      </div>
                      <a href={'tel:' + p.mobile} onClick={(e) => e.stopPropagation()} title="Call patient" aria-label="Call patient"
                        style={{ flexShrink: 0, width: 40, height: 40, borderRadius: '50%', background: '#e6f4f2', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0e756c', textDecoration: 'none' }}>
                        {PHONE_SVG}
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="table-view">
            <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: 760 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: '#7a9994', fontSize: 12, letterSpacing: '.05em', textTransform: 'uppercase' }}>
                      <th style={{ padding: '12px 20px', fontWeight: 700 }}>Patient</th>
                      <th style={{ padding: '12px 12px', fontWeight: 700 }}>Patient ID</th>
                      <th style={{ padding: '12px 12px', fontWeight: 700 }}>Mobile</th>
                      <th style={{ padding: '12px 12px', fontWeight: 700 }}>Last visit</th>
                      <th style={{ padding: '12px 12px', fontWeight: 700 }}>Visits</th>
                      <th style={{ padding: '12px 12px', fontWeight: 700 }}>Outstanding</th>
                      <th style={{ padding: '12px 12px', fontWeight: 700 }}>Payment</th>
                      <th style={{ padding: '12px 20px', fontWeight: 700 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((p) => {
                      const [stBg, stInk] = PAY_MAP[p.status] || ['#eef4f3', '#8aa8a3'];
                      return (
                        <tr key={p.patientId} onClick={() => onOpenPatient(p.patientId)} style={{ borderTop: '1px solid #eef4f3', cursor: 'pointer' }}>
                          <td style={{ padding: '13px 20px' }}>
                            <span style={{ fontWeight: 700, color: '#0e3b39' }}>{p.name}</span>
                            <span style={{ color: '#98b0ab' }}> · {p.ageGender}</span>
                          </td>
                          <td style={{ padding: '13px 12px', fontFamily: 'ui-monospace,monospace', fontSize: 12.5, color: '#0e756c', fontWeight: 600 }}>{p.patientId}</td>
                          <td style={{ padding: '13px 12px', color: '#5c7a76' }}>{p.mobile}</td>
                          <td style={{ padding: '13px 12px', color: '#5c7a76' }}>{p.lastLabel}</td>
                          <td style={{ padding: '13px 12px', color: '#5c7a76' }}>{p.visitCount}</td>
                          <td style={{ padding: '13px 12px', fontWeight: 700, color: stInk }}>{p.outstanding > 0 ? inr(p.outstanding) : '—'}</td>
                          <td style={{ padding: '13px 12px' }}>
                            <span style={{ display: 'inline-block', padding: '4px 11px', borderRadius: 100, fontSize: 12, fontWeight: 700, background: stBg, color: stInk }}>{p.status}</span>
                          </td>
                          <td style={{ padding: '13px 20px', textAlign: 'right' }}>
                            <a href={'tel:' + p.mobile} onClick={(e) => e.stopPropagation()} title="Call patient"
                              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: '50%', background: '#e6f4f2', color: '#0e756c', textDecoration: 'none' }}>
                              <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                <path d="M6.62 10.79a15.53 15.53 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02l-2.2 2.2z" />
                              </svg>
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {showPager && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 20 }}>
              <button onClick={() => setPage(Math.max(1, safePage - 1))} disabled={safePage <= 1}
                style={{ padding: '9px 16px', borderRadius: 9, border: '1px solid #cfe3df', background: '#fff', color: '#0e756c', fontWeight: 700, fontSize: 13.5, cursor: safePage <= 1 ? 'default' : 'pointer', opacity: safePage <= 1 ? 0.5 : 1 }}>
                ← Prev
              </button>
              <span style={{ fontSize: 13.5, color: '#5c7a76', fontWeight: 600 }}>Page {safePage} of {totalPages}</span>
              <button onClick={() => setPage(Math.min(totalPages, safePage + 1))} disabled={safePage >= totalPages}
                style={{ padding: '9px 16px', borderRadius: 9, border: '1px solid #cfe3df', background: '#fff', color: '#0e756c', fontWeight: 700, fontSize: 13.5, cursor: safePage >= totalPages ? 'default' : 'pointer', opacity: safePage >= totalPages ? 0.5 : 1 }}>
                Next →
              </button>
            </div>
          )}
        </>
      )}

      {filtered.length === 0 && (
        <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, padding: '54px 20px', textAlign: 'center', color: '#8aa8a3' }}>
          <p style={{ fontSize: 16, fontWeight: 600, color: '#5c7a76' }}>No patients found.</p>
          <p style={{ fontSize: 14, marginTop: 6 }}>Try a different search or date range.</p>
        </div>
      )}
    </div>
  );
}
