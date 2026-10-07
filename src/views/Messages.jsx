// The Messages tab: a log of everything sent, and an overview of how much of
// it arrived.
//
// Desktop only. The table has seven columns and the overview has a chart;
// neither survives a phone, and reception already sees per-appointment status
// on the Appointments tab, which is the thing they need in the chair.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MessageDrawer from '../whatsapp/messages/MessageDrawer';
import { MSG_FILTERS, TRIGGERS, failureReason, msgLook, msgStatus, triggerLook } from '../whatsapp/statusModel';
import { addDays, fmtClock, fmtDay, fmtDayOf, fmtPhone, parseYmd, Toast, todayYmd, ymd } from '../whatsapp/ui';
import { listMessages, messageStats, sendMessage } from '../whatsapp/waApi';

const PAGE_SIZE = 12;
const DESKTOP_MIN = 900;

function firstOfMonth() {
  const d = new Date();
  return ymd(new Date(d.getFullYear(), d.getMonth(), 1));
}

const PRESETS = [
  { key: 'today', label: 'Today', range: () => [todayYmd(), todayYmd()] },
  { key: 'week', label: 'Last 7 days', range: () => [addDays(todayYmd(), -6), todayYmd()] },
  { key: 'month', label: 'This month', range: () => [firstOfMonth(), todayYmd()] },
  { key: 'd30', label: 'Last 30 days', range: () => [addDays(todayYmd(), -29), todayYmd()] },
];

function Card({ label, value, sub, tone, onClick }) {
  const ink = tone === 'bad' ? '#b8690f' : '#0e756c';
  return (
    <button
      onClick={onClick}
      style={{
        flex: '1 1 170px', textAlign: 'left', background: '#fff', border: '1px solid #dfece9',
        borderRadius: 16, padding: '15px 17px', cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <span style={{ display: 'block', fontSize: 12, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#7a9994' }}>
        {label}
      </span>
      <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 28, color: ink, marginTop: 5, lineHeight: 1.1 }}>
        {value}
      </span>
      {sub && <span style={{ display: 'block', fontSize: 12.5, color: '#98b0ab', marginTop: 3 }}>{sub}</span>}
    </button>
  );
}

function pct(a, b) { return b ? Math.round((a / b) * 100) + '%' : '—'; }

function PerDayChart({ series }) {
  if (!series.length) return <p style={{ fontSize: 13.5, color: '#98b0ab' }}>Nothing sent in this range.</p>;

  const H = 170;
  const max = Math.max(1, ...series.map((d) => d.triggered));
  const barW = Math.max(6, Math.min(34, Math.floor(760 / series.length) - 6));
  const gap = 6;
  const W = series.length * (barW + gap);
  // With 30 days and a 760px box the labels collide, so only every nth is
  // drawn. The tooltip carries the exact day for the rest.
  const labelEvery = Math.ceil(series.length / 12);

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={Math.max(W, 300)} height={H + 28} role="img" aria-label="Messages per day">
        {series.map((d, i) => {
          const x = i * (barW + gap);
          const seenH = Math.round((d.seen / max) * H);
          const delH = Math.round((Math.max(0, d.delivered - d.seen) / max) * H);
          const failH = Math.round((d.failed / max) * H);
          let y = H;
          const parts = [
            { h: failH, fill: '#e7a33e' },
            { h: delH, fill: '#9fd6cd' },
            { h: seenH, fill: '#0e756c' },
          ];
          return (
            <g key={d.date}>
              <title>
                {fmtDay(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}
                {' — ' + d.triggered + ' sent, ' + d.delivered + ' delivered, ' + d.seen + ' seen, ' + d.failed + ' not delivered'}
              </title>
              {parts.map((p, k) => {
                if (p.h <= 0) return null;
                y -= p.h;
                return <rect key={k} x={x} y={y} width={barW} height={p.h} fill={p.fill} rx={k === 2 ? 3 : 0} />;
              })}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={H + 16} textAnchor="middle" fontSize="10" fill="#98b0ab">
                  {parseYmd(d.date).getDate()}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
        {[['Seen', '#0e756c'], ['Delivered, not seen', '#9fd6cd'], ['Not delivered', '#e7a33e']].map(([l, c]) => (
          <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#5c7a76' }}>
            <span style={{ width: 11, height: 11, borderRadius: 3, background: c }} />{l}
          </span>
        ))}
      </div>
    </div>
  );
}

function Funnel({ triggered, delivered, seen }) {
  const rows = [
    { label: 'Triggered', n: triggered, color: '#0e3b39' },
    { label: 'Delivered', n: delivered, color: '#0e756c' },
    { label: 'Seen', n: seen, color: '#4fb3a6' },
  ];
  const max = Math.max(1, triggered);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {rows.map((r) => (
        <div key={r.label}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
            <span style={{ color: '#5c7a76' }}>{r.label}</span>
            <span style={{ color: '#0e3b39', fontWeight: 700 }}>{r.n} <span style={{ color: '#98b0ab', fontWeight: 400 }}>· {pct(r.n, triggered)}</span></span>
          </div>
          <div style={{ height: 11, borderRadius: 6, background: '#eef4f3', overflow: 'hidden' }}>
            <div style={{ width: Math.round((r.n / max) * 100) + '%', height: '100%', background: r.color, borderRadius: 6 }} />
          </div>
        </div>
      ))}
      <p style={{ fontSize: 12, color: '#98b0ab', lineHeight: 1.45 }}>
        "Seen" only counts patients who have read receipts turned on, so it will always read low.
      </p>
    </div>
  );
}

export default function Messages() {
  const [wide, setWide] = useState(typeof window !== 'undefined' ? window.innerWidth >= DESKTOP_MIN : true);
  const [tab, setTab] = useState('log');
  const [preset, setPreset] = useState('month');
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(todayYmd());
  const [q, setQ] = useState('');
  const [eventF, setEventF] = useState('');
  const [statusF, setStatusF] = useState('All');
  const [page, setPage] = useState(1);

  const [data, setData] = useState({ messages: [], total: 0, statusCounts: {} });
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sel, setSel] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= DESKTOP_MIN);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  function say(m) {
    clearTimeout(toastTimer.current);
    setToast(m);
    toastTimer.current = setTimeout(() => setToast(''), 3200);
  }

  function applyPreset(key) {
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    const [f, t] = p.range();
    setPreset(key); setFrom(f); setTo(t); setPage(1);
  }

  const loadLog = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listMessages({
        from, to, page,
        event: eventF || undefined,
        status: statusF === 'All' ? undefined : statusF,
        q: q.trim() || undefined,
      });
      setData({ messages: res.messages || [], total: res.total || 0, statusCounts: res.statusCounts || {} });
      setError('');
    } catch (err) {
      setError(String((err && err.message) || 'Could not load messages.'));
    } finally {
      setLoading(false);
    }
  }, [from, to, page, eventF, statusF, q]);

  const loadStats = useCallback(async () => {
    try { setStats(await messageStats({ from, to })); }
    catch { setStats(null); }
  }, [from, to]);

  // Debounced so typing in the search box does not fire a request per
  // keystroke against a table scan.
  useEffect(() => {
    if (!wide) return undefined;
    const t = setTimeout(() => { if (tab === 'log') loadLog(); }, 280);
    return () => clearTimeout(t);
  }, [wide, tab, loadLog]);

  useEffect(() => { if (wide && tab === 'overview') loadStats(); }, [wide, tab, loadStats]);

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const firstRow = data.total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastRow = Math.min(page * PAGE_SIZE, data.total);

  const eventOptions = useMemo(() => Object.keys(TRIGGERS), []);

  async function retry(msg) {
    setRetrying(true);
    try {
      await sendMessage({
        useCase: msg.useCase, patientId: msg.patientId, visitId: msg.visitId,
        mobile: msg.mobile, name: msg.name, params: msg.templateParams || {},
        // A retry is a new attempt, not a replay of the old one — the old key
        // would be deduplicated against the failed send and do nothing.
        docVersion: 'retry-' + Date.now(),
      });
      setSel(null);
      await loadLog();
      say('Sent again');
    } catch (err) {
      say(String((err && err.message) || 'Could not send.'));
    } finally {
      setRetrying(false);
    }
  }

  if (!wide) {
    return (
      <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, padding: '46px 24px', textAlign: 'center' }}>
        <p style={{ fontSize: 16, fontWeight: 700, color: '#0e3b39' }}>Messages is a desktop view</p>
        <p style={{ fontSize: 14, color: '#5c7a76', marginTop: 7, lineHeight: 1.5 }}>
          Open the console on a computer to see the message log and the monthly numbers.
          Appointments and visits still show their own message status here.
        </p>
      </div>
    );
  }

  const chipStyle = (on) => ({
    minHeight: 34, padding: '0 13px', borderRadius: 100, cursor: 'pointer',
    border: '1px solid ' + (on ? '#0e756c' : '#dfece9'),
    background: on ? '#0e756c' : '#fff', color: on ? '#fff' : '#5c7a76',
    fontWeight: 700, fontSize: 12.5,
  });

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 22, color: '#0e3b39' }}>Messages</h2>
        <p style={{ color: '#5c7a76', fontSize: 14.5, marginTop: 2 }}>
          Everything the clinic has sent patients on WhatsApp, and how much of it reached them.
        </p>
      </div>

      {/* Date range */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', marginBottom: 16 }}>
        {PRESETS.map((p) => (
          <button key={p.key} onClick={() => applyPreset(p.key)} style={chipStyle(preset === p.key)}>{p.label}</button>
        ))}
        <span style={{ width: 1, height: 24, background: '#e2efec' }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#7a9994' }}>
          From
          <input
            type="date" value={from}
            onChange={(e) => { setFrom(e.target.value); setPreset(''); setPage(1); }}
            style={{ minHeight: 34, padding: '0 9px', borderRadius: 9, border: '1px solid #cfe3df', fontSize: 13, color: '#0e3b39' }}
          />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#7a9994' }}>
          To
          <input
            type="date" value={to}
            onChange={(e) => { setTo(e.target.value); setPreset(''); setPage(1); }}
            style={{ minHeight: 34, padding: '0 9px', borderRadius: 9, border: '1px solid #cfe3df', fontSize: 13, color: '#0e3b39' }}
          />
        </label>
      </div>

      {/* View switch */}
      <div style={{ display: 'flex', gap: 22, borderBottom: '1px solid #e2efec', marginBottom: 18 }}>
        {[['log', 'Message log'], ['overview', 'Overview']].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            style={{
              background: 'transparent', border: 0, padding: '0 0 10px', cursor: 'pointer',
              fontWeight: 700, fontSize: 14.5, color: tab === k ? '#0e3b39' : '#8aa8a3',
              borderBottom: '2.5px solid ' + (tab === k ? '#0e756c' : 'transparent'), marginBottom: -1,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <p style={{ color: '#c0392b', fontSize: 13, fontWeight: 600, marginBottom: 12 }}>{error}</p>}

      {tab === 'log' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', marginBottom: 13 }}>
            <input
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(1); }}
              placeholder="Search patient name or number"
              style={{
                flex: '1 1 240px', minHeight: 38, padding: '0 13px', borderRadius: 10,
                border: '1px solid #cfe3df', fontSize: 13.5, color: '#0e3b39',
              }}
            />
            <select
              value={eventF}
              onChange={(e) => { setEventF(e.target.value); setPage(1); }}
              style={{ minHeight: 38, padding: '0 11px', borderRadius: 10, border: '1px solid #cfe3df', fontSize: 13.5, color: '#0e3b39', background: '#fff' }}
            >
              <option value="">All trigger events</option>
              {eventOptions.map((k) => <option key={k} value={k}>{TRIGGERS[k].event}</option>)}
            </select>
            <span style={{ fontSize: 13, color: '#98b0ab', marginLeft: 'auto' }}>
              {data.total} {data.total === 1 ? 'message' : 'messages'}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 14 }}>
            {MSG_FILTERS.map((f) => {
              const n = f === 'All' ? data.total : (data.statusCounts[f] || 0);
              return (
                <button key={f} onClick={() => { setStatusF(f); setPage(1); }} style={chipStyle(statusF === f)}>
                  {f} <span style={{ opacity: .75 }}>{n}</span>
                </button>
              );
            })}
          </div>

          <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, overflow: 'hidden' }}>
            {data.messages.length === 0 && !loading && (
              <div style={{ padding: '50px 20px', textAlign: 'center' }}>
                <p style={{ fontSize: 15.5, fontWeight: 600, color: '#5c7a76' }}>No messages match these filters.</p>
              </div>
            )}
            {data.messages.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, minWidth: 900 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: '#7a9994', fontSize: 11.5, letterSpacing: '.05em', textTransform: 'uppercase' }}>
                      <th style={{ padding: '12px 10px 12px 20px', fontWeight: 700 }}>Sent</th>
                      <th style={{ padding: '12px 10px', fontWeight: 700 }}>Patient</th>
                      <th style={{ padding: '12px 10px', fontWeight: 700 }}>WhatsApp number</th>
                      <th style={{ padding: '12px 10px', fontWeight: 700 }}>Trigger event</th>
                      <th style={{ padding: '12px 10px', fontWeight: 700 }}>Template</th>
                      <th style={{ padding: '12px 10px', fontWeight: 700 }}>Status</th>
                      <th style={{ padding: '12px 20px 12px 10px', fontWeight: 700 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {data.messages.map((m) => {
                      const st = msgStatus(m.status, m.reply);
                      const look = msgLook(st);
                      const trig = triggerLook(m.useCase);
                      return (
                        <tr
                          key={m.messageId}
                          onClick={() => setSel(m)}
                          style={{ borderTop: '1px solid #eef4f3', cursor: 'pointer', background: st === 'failed' ? '#fffaf2' : '#fff' }}
                        >
                          <td style={{ padding: '12px 10px 12px 20px', whiteSpace: 'nowrap', color: '#33534f' }}>
                            {fmtDayOf(m.sentAt)}
                            <span style={{ display: 'block', fontSize: 12, color: '#98b0ab' }}>{fmtClock(m.sentAt)}</span>
                          </td>
                          <td style={{ padding: '12px 10px' }}>
                            <span style={{ display: 'block', color: '#0e3b39', fontWeight: 600 }}>{m.name}</span>
                            <span style={{ display: 'block', fontSize: 12, color: '#98b0ab' }}>{m.patientId}</span>
                          </td>
                          <td style={{ padding: '12px 10px', color: '#5c7a76', whiteSpace: 'nowrap' }}>{fmtPhone(m.mobile)}</td>
                          <td style={{ padding: '12px 10px', color: '#33534f', whiteSpace: 'nowrap' }}>
                            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: trig.color, marginRight: 7 }} />
                            {trig.event}
                          </td>
                          <td style={{ padding: '12px 10px' }}>
                            <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5, color: '#5c7a76' }}>
                              {m.templateName || '—'}
                            </code>
                          </td>
                          <td style={{ padding: '12px 10px' }}>
                            <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 100, fontWeight: 700, fontSize: 12, background: look.bg, color: look.ink }}>
                              {look.label}
                            </span>
                            <span style={{ display: 'block', fontSize: 11.5, color: st === 'failed' ? '#8a4f0b' : '#98b0ab', marginTop: 3 }}>
                              {st === 'failed'
                                ? failureReason(m.failureCode, m.failureReason)
                                : m.reply ? 'Replied ' + m.reply : ''}
                            </span>
                          </td>
                          <td style={{ padding: '12px 20px 12px 10px', textAlign: 'right', color: '#0e756c', fontWeight: 700, fontSize: 12.5, whiteSpace: 'nowrap' }}>
                            Details →
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {data.total > PAGE_SIZE && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 13 }}>
              <span style={{ fontSize: 13, color: '#98b0ab' }}>Showing {firstRow}–{lastRow} of {data.total}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  style={{ minHeight: 36, padding: '0 15px', borderRadius: 9, border: '1px solid #cfe3df', background: '#fff', color: page <= 1 ? '#b0c5c1' : '#0e756c', fontWeight: 700, fontSize: 13, cursor: page <= 1 ? 'default' : 'pointer' }}
                >
                  Prev
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  style={{ minHeight: 36, padding: '0 15px', borderRadius: 9, border: '1px solid #cfe3df', background: '#fff', color: page >= totalPages ? '#b0c5c1' : '#0e756c', fontWeight: 700, fontSize: 13, cursor: page >= totalPages ? 'default' : 'pointer' }}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'overview' && (
        <>
          {!stats && <p style={{ fontSize: 14, color: '#98b0ab' }}>Loading…</p>}
          {stats && (
            <>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
                <Card label="Triggered" value={stats.triggered} sub="messages sent" onClick={() => { setTab('log'); setStatusF('All'); setPage(1); }} />
                <Card label="Delivered" value={stats.delivered} sub={pct(stats.delivered, stats.triggered) + ' of triggered'} onClick={() => { setTab('log'); setStatusF('Delivered'); setPage(1); }} />
                <Card label="Seen" value={stats.seen} sub={pct(stats.seen, stats.delivered) + ' of delivered'} onClick={() => { setTab('log'); setStatusF('Seen'); setPage(1); }} />
                <Card label="Not delivered" value={stats.failed} sub="tap to see who" tone="bad" onClick={() => { setTab('log'); setStatusF('Not delivered'); setPage(1); }} />
              </div>

              <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, padding: '18px 20px', marginBottom: 16 }}>
                <h3 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 16, color: '#0e3b39', marginBottom: 14 }}>Messages per day</h3>
                <PerDayChart series={stats.perDay || []} />
              </div>

              <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, padding: '18px 20px', marginBottom: 16 }}>
                <h3 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 16, color: '#0e3b39', marginBottom: 14 }}>Triggered → delivered → seen</h3>
                <Funnel triggered={stats.triggered} delivered={stats.delivered} seen={stats.seen} />
              </div>

              <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, overflow: 'hidden' }}>
                <h3 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 16, color: '#0e3b39', padding: '18px 20px 12px' }}>By trigger event</h3>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, minWidth: 720 }}>
                    <thead>
                      <tr style={{ textAlign: 'left', color: '#7a9994', fontSize: 11.5, letterSpacing: '.05em', textTransform: 'uppercase' }}>
                        <th style={{ padding: '10px 10px 10px 20px', fontWeight: 700 }}>Event</th>
                        <th style={{ padding: '10px', fontWeight: 700 }}>Template</th>
                        <th style={{ padding: '10px', fontWeight: 700 }}>Triggered</th>
                        <th style={{ padding: '10px', fontWeight: 700 }}>Delivered</th>
                        <th style={{ padding: '10px', fontWeight: 700 }}>Seen</th>
                        <th style={{ padding: '10px', fontWeight: 700 }}>Failed</th>
                        <th style={{ padding: '10px 20px 10px 10px', fontWeight: 700 }}>Delivery rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(stats.byEvent || []).map((r) => {
                        const trig = triggerLook(r.useCase);
                        const rate = r.triggered ? Math.round((r.delivered / r.triggered) * 100) : 0;
                        return (
                          <tr
                            key={r.useCase}
                            onClick={() => { setTab('log'); setEventF(r.useCase); setStatusF('All'); setPage(1); }}
                            style={{ borderTop: '1px solid #eef4f3', cursor: 'pointer' }}
                          >
                            <td style={{ padding: '11px 10px 11px 20px', color: '#0e3b39', fontWeight: 600, whiteSpace: 'nowrap' }}>
                              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: trig.color, marginRight: 7 }} />
                              {trig.event}
                            </td>
                            <td style={{ padding: '11px 10px' }}>
                              <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5, color: '#5c7a76' }}>{r.templateName || '—'}</code>
                            </td>
                            <td style={{ padding: '11px 10px', color: '#33534f' }}>{r.triggered}</td>
                            <td style={{ padding: '11px 10px', color: '#33534f' }}>{r.delivered}</td>
                            <td style={{ padding: '11px 10px', color: '#33534f' }}>{r.seen}</td>
                            <td style={{ padding: '11px 10px', color: r.failed ? '#b8690f' : '#33534f', fontWeight: r.failed ? 700 : 400 }}>{r.failed}</td>
                            <td style={{ padding: '11px 20px 11px 10px', minWidth: 130 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <div style={{ flex: 1, height: 7, borderRadius: 4, background: '#eef4f3', overflow: 'hidden' }}>
                                  <div style={{ width: rate + '%', height: '100%', background: '#0e756c' }} />
                                </div>
                                <span style={{ fontSize: 12, color: '#5c7a76', minWidth: 32 }}>{rate}%</span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}

      <MessageDrawer msg={sel} retrying={retrying} onClose={() => setSel(null)} onRetry={retry} />
      <Toast message={toast} />
    </div>
  );
}
