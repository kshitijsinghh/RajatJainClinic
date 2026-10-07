import { useState } from 'react';

import { TOUCH_BTN } from '../styles';
import FailedMessagesBanner from '../whatsapp/FailedMessagesBanner';

function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(dt) { return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate()); }
function parseYmd(s) { const a = s.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]); }
function addDays(s, n) { const dt = parseYmd(s); dt.setDate(dt.getDate() + n); return ymd(dt); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function fmtDateShort(d) {
  if (!d) return '—';
  try { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return d; }
}

export default function Dashboard({
  dateFrom, dateTo, onSetRange, onRefresh, refreshing,
  stats, q, onSetQ, visitRows, hasVisits, noVisits,
}) {
  const [showRange, setShowRange] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [calMonth, setCalMonth] = useState((dateFrom || todayStr()).slice(0, 7));
  const [tmpStart, setTmpStart] = useState(dateFrom);
  const [tmpEnd, setTmpEnd] = useState(dateTo);

  function openRange() {
    setTmpStart(dateFrom);
    setTmpEnd(dateTo);
    setCalMonth((dateFrom || todayStr()).slice(0, 7));
    setShowCustom(false);
    setShowRange(true);
  }
  function selectDay(d) {
    if (!tmpStart || (tmpStart && tmpEnd)) { setTmpStart(d); setTmpEnd(''); }
    else if (d >= tmpStart) { setTmpEnd(d); }
    else { setTmpStart(d); setTmpEnd(''); }
  }
  function applyRange() {
    onSetRange(tmpStart, tmpEnd || tmpStart);
    setShowRange(false);
  }
  function applyPreset(kind) {
    const t = todayStr();
    let s = t, e = t;
    if (kind === 'today') { s = t; e = t; }
    else if (kind === 'week') { const dow = parseYmd(t).getDay(); s = addDays(t, -dow); e = t; }
    else if (kind === 'month') { s = t.slice(0, 8) + '01'; e = t; }
    else if (kind === 'last30') { s = addDays(t, -29); e = t; }
    else if (kind === 'last7') { s = addDays(t, -6); e = t; }
    onSetRange(s, e);
    setTmpStart(s);
    setTmpEnd(e);
    setShowRange(false);
  }

  const rangeLabel = (dateFrom || dateTo)
    ? (fmtDateShort(dateFrom) + ' – ' + fmtDateShort(dateTo || dateFrom))
    : 'All time';

  const cm = calMonth.split('-').map(Number);
  const calY = cm[0], calM = cm[1];
  const calTitle = new Date(calY, calM - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const firstDow = new Date(calY, calM - 1, 1).getDay();
  const daysInMonth = new Date(calY, calM, 0).getDate();
  const today = todayStr();

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push({ key: 'b' + i, blank: true });
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = calY + '-' + pad2(calM) + '-' + pad2(d);
    const isStart = ds === tmpStart, isEnd = ds === tmpEnd;
    const inSel = tmpStart && tmpEnd && ds >= tmpStart && ds <= tmpEnd;
    const edge = isStart || isEnd;
    const isToday = ds === today;
    let bg = 'transparent', col = '#33534f', fw = '500';
    if (inSel && !edge) { bg = '#e6f4f2'; }
    if (edge) { bg = '#0e756c'; col = '#fff'; fw = '700'; }
    const border = (isToday && !edge) ? '1px solid #12a094' : '1px solid transparent';
    cells.push({ key: ds, blank: false, label: String(d), date: ds, bg, col, fw, border });
  }
  while (cells.length % 7 !== 0) cells.push({ key: 'e' + cells.length, blank: true });

  const calWeeks = [];
  for (let i = 0; i < cells.length; i += 7) calWeeks.push(cells.slice(i, i + 7));

  return (
    <div>
      <FailedMessagesBanner />
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            onClick={openRange}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '11px 15px',
              border: '1px solid #cfe3df', borderRadius: 11, background: '#fff', cursor: 'pointer',
              fontWeight: 700, fontSize: 14, color: '#0e3b39', boxShadow: '0 1px 2px rgba(14,59,57,.04)',
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#0e756c" strokeWidth="1.9" strokeLinecap="round">
              <rect x="3" y="4.5" width="18" height="16" rx="2.5" /><path d="M3 9h18M8 2.5v4M16 2.5v4" />
            </svg>
            {rangeLabel}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8aa8a3" strokeWidth="2.4" strokeLinecap="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </div>
          <button
            onClick={onRefresh} title="Refresh" disabled={refreshing}
            style={{
              ...TOUCH_BTN, width: 42, height: 42, border: '1px solid #cfe3df', borderRadius: 11,
              background: '#fff', cursor: refreshing ? 'default' : 'pointer', color: '#0e756c',
              opacity: refreshing ? 0.6 : 1,
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5" />
            </svg>
          </button>
          {showRange && (
            <div
              style={{
                position: 'absolute', top: 52, left: 0, zIndex: 30, background: '#fff',
                border: '1px solid #dfece9', borderRadius: 16,
                boxShadow: '0 24px 60px -18px rgba(14,59,57,.4)', padding: 16,
                width: showCustom ? 'min(320px,86vw)' : 'min(220px,72vw)',
              }}
            >
              {!showCustom ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {[
                    ['Today', 'today'],
                    ['Week till date', 'week'],
                    ['Month till date', 'month'],
                    ['Last 30 days', 'last30'],
                    ['Last 7 days', 'last7'],
                  ].map(([label, key]) => (
                    <button key={key} onClick={() => applyPreset(key)}
                      style={{ textAlign: 'left', padding: '11px 14px', borderRadius: 10, border: 0, background: '#fff', color: '#33534f', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = '#f2f9f8'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}
                    >{label}</button>
                  ))}
                  <button onClick={() => { setShowCustom(true); setCalMonth((dateFrom || todayStr()).slice(0, 7)); }}
                    style={{ textAlign: 'left', padding: '11px 14px', borderRadius: 10, border: 0, background: '#fff', color: '#0e756c', fontWeight: 700, fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = '#f2f9f8'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <rect x="3" y="4.5" width="18" height="16" rx="2.5" /><path d="M3 9h18M8 2.5v4M16 2.5v4" />
                    </svg>
                    Custom
                  </button>
                </div>
              ) : (
                <div>
                  <button onClick={() => setShowCustom(false)}
                    style={{ border: 0, background: 'none', color: '#0e756c', fontWeight: 700, fontSize: 13, cursor: 'pointer', padding: '0 0 10px', display: 'flex', alignItems: 'center', gap: 4 }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
                    Back
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <button
                      onClick={() => { const dt = new Date(calY, calM - 2, 1); setCalMonth(dt.getFullYear() + '-' + pad2(dt.getMonth() + 1)); }}
                      style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid #e2efec', background: '#f7fbfa', cursor: 'pointer', color: '#0e756c', fontSize: 15 }}
                    >&#8249;</button>
                    <span style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 15, color: '#0e3b39' }}>{calTitle}</span>
                    <button
                      onClick={() => { const dt = new Date(calY, calM, 1); setCalMonth(dt.getFullYear() + '-' + pad2(dt.getMonth() + 1)); }}
                      style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid #e2efec', background: '#f7fbfa', cursor: 'pointer', color: '#0e756c', fontSize: 15 }}
                    >&#8250;</button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2, color: '#98b0ab', fontSize: 11, fontWeight: 700, textAlign: 'center', marginBottom: 4 }}>
                    {['S','M','T','W','T','F','S'].map((d, i) => <span key={i}>{d}</span>)}
                  </div>
                  {calWeeks.map((week, wi) => (
                    <div key={wi} style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2 }}>
                      {week.map((cell) => (
                        cell.blank
                          ? <div key={cell.key} style={{ padding: 0 }} />
                          : <div
                              key={cell.key}
                              onClick={() => selectDay(cell.date)}
                              style={{
                                cursor: 'pointer', textAlign: 'center', padding: '9px 0', borderRadius: 9,
                                fontSize: 13.5, fontWeight: cell.fw, background: cell.bg, color: cell.col,
                                border: cell.border,
                              }}
                            >
                              {cell.label}
                            </div>
                      ))}
                    </div>
                  ))}
                  {tmpStart && (
                    <p style={{ fontSize: 12.5, color: '#5c7a76', marginTop: 10, textAlign: 'center' }}>
                      {fmtDateShort(tmpStart)}{tmpEnd && tmpEnd !== tmpStart ? ' – ' + fmtDateShort(tmpEnd) : ''}
                    </p>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button onClick={() => setShowRange(false)} style={{ flex: 1, padding: 10, borderRadius: 9, border: '1px solid #d6e7e3', background: '#fff', color: '#5c7a76', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
                    <button onClick={applyRange} disabled={!tmpStart} style={{ flex: 1, padding: 10, borderRadius: 9, border: 0, background: '#0e756c', color: '#fff', fontWeight: 700, fontSize: 13, cursor: tmpStart ? 'pointer' : 'default', opacity: tmpStart ? 1 : 0.5 }}>Apply</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 14, marginBottom: 22 }}>
        {stats.map((st) => (
          <div key={st.label} style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 16, padding: '18px 20px' }}>
            <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#8aa8a3' }}>
              {st.label}
            </span>
            <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 32, color: st.color, marginTop: 4 }}>
              {st.value}
            </span>
          </div>
        ))}
      </div>

      <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, overflow: 'hidden' }}>
        <div
          style={{
            padding: '16px 20px', borderBottom: '1px solid #eef4f3', display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', gap: 14, flexWrap: 'wrap',
          }}
        >
          <h2 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 19, color: '#0e3b39' }}>Visit records</h2>
          <input
            className="fld" value={q} onChange={(e) => onSetQ(e.target.value)} placeholder="Search by name, mobile or ID…"
            style={{ minHeight: 44, flex: '0 1 320px', minWidth: 200, padding: '10px 14px', border: '1px solid #d6e7e3', borderRadius: 10, fontSize: 15, background: '#f7fbfa' }}
          />
        </div>

        {hasVisits && (
          <>
            <div className="table-view" style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: 820 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#7a9994', fontSize: 12, letterSpacing: '.05em', textTransform: 'uppercase' }}>
                    <th style={{ padding: '12px 20px', fontWeight: 700 }}>Visit ID</th>
                    <th style={{ padding: '12px 12px', fontWeight: 700 }}>Date</th>
                    <th style={{ padding: '12px 12px', fontWeight: 700 }}>Patient</th>
                    <th style={{ padding: '12px 12px', fontWeight: 700 }}>Mobile</th>
                    <th style={{ padding: '12px 12px', fontWeight: 700 }}>Treatment</th>
                    <th style={{ padding: '12px 12px', fontWeight: 700 }}>Payment</th>
                    <th style={{ padding: '12px 20px', fontWeight: 700 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {visitRows.map((v) => (
                    <tr key={v.visitId} style={{ borderTop: '1px solid #eef4f3' }}>
                      <td style={{ padding: '13px 20px', fontFamily: 'ui-monospace,monospace', fontSize: 12.5, color: '#0e756c', fontWeight: 600 }}>
                        {v.visitId}
                      </td>
                      <td style={{ padding: '13px 12px', color: '#5c7a76' }}>{v.dateLabel}</td>
                      <td style={{ padding: '13px 12px' }}>
                        <span style={{ fontWeight: 700, color: '#0e3b39' }}>{v.name}</span>
                        <span style={{ color: '#98b0ab' }}> · {v.ageGender}</span>
                      </td>
                      <td style={{ padding: '13px 12px', color: '#5c7a76' }}>{v.mobile}</td>
                      <td style={{ padding: '13px 12px', color: '#5c7a76' }}>{v.treatmentLabel}</td>
                      <td style={{ padding: '13px 12px' }}>
                        <span style={{ display: 'inline-block', padding: '4px 11px', borderRadius: 100, fontSize: 12, fontWeight: 700, background: v.payBg, color: v.payInk }}>
                          {v.payLabel}
                        </span>
                      </td>
                      <td style={{ padding: '13px 20px', textAlign: 'right' }}>
                        <button
                          onClick={v.open}
                          className="action-btn"
                          style={{
                            ...TOUCH_BTN, padding: '8px 14px', borderRadius: 9, border: '1px solid #cfe3df',
                            background: '#f2f9f8', color: '#0e756c', fontWeight: 700, fontSize: 13,
                            cursor: 'pointer', gap: 7,
                          }}
                        >
                          {v.actionLabel}
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M5 12h14M13 6l6 6-6 6" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card-view">
              {visitRows.map((v) => (
                <div key={v.visitId} style={{ padding: '14px 18px', borderTop: '1px solid #eef4f3', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                    <div>
                      <span style={{ fontWeight: 700, fontSize: 15, color: '#0e3b39' }}>{v.name}</span>
                      <span style={{ color: '#98b0ab', fontSize: 13.5 }}> · {v.ageGender}</span>
                    </div>
                    <span style={{ flexShrink: 0, display: 'inline-block', padding: '4px 11px', borderRadius: 100, fontSize: 12, fontWeight: 700, background: v.payBg, color: v.payInk }}>
                      {v.payLabel}
                    </span>
                  </div>
                  <div style={{ fontFamily: 'ui-monospace,monospace', fontSize: 12.5, color: '#0e756c', fontWeight: 600 }}>
                    {v.visitId} · {v.dateLabel}
                  </div>
                  <div style={{ fontSize: 13.5, color: '#5c7a76' }}>{v.mobile}</div>
                  <div style={{ fontSize: 13.5, color: '#5c7a76' }}>{v.treatmentLabel}</div>
                  <button
                    onClick={v.open}
                    className="action-btn"
                    style={{
                      ...TOUCH_BTN, marginTop: 6, alignSelf: 'stretch', padding: '10px 14px', borderRadius: 9,
                      border: '1px solid #cfe3df', background: '#f2f9f8', color: '#0e756c', fontWeight: 700,
                      fontSize: 13.5, cursor: 'pointer', gap: 7,
                    }}
                  >
                    {v.actionLabel}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {noVisits && (
          <div style={{ padding: '54px 20px', textAlign: 'center', color: '#8aa8a3' }}>
            <p style={{ fontSize: 16, fontWeight: 600, color: '#5c7a76' }}>No records yet.</p>
            <p style={{ fontSize: 14, marginTop: 6 }}>
              Click <strong>+ New Visit</strong> to register the first patient.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
