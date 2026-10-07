// The calendar grid: a time axis, one column per day, and event blocks
// positioned by start time and duration.

import { useEffect, useRef, useState } from 'react';
import { apptLook, apptStatus } from '../statusModel';
import { fmtMin, parseYmd, todayYmd } from '../ui';

export const DAY_START_MIN = 9 * 60;   // 9 AM
// 10 PM, not 8. Evening sessions at these clinics run to 9:30, and a grid
// that ends at the last appointment's start time clips the block drawn for
// it — the slot has to fit, not just begin.
export const DAY_END_MIN = 22 * 60;    // 10 PM
export const PX_PER_HOUR = 60;
const AXIS_W = 54;

const PX_PER_MIN = PX_PER_HOUR / 60;
const GRID_H = (DAY_END_MIN - DAY_START_MIN) * PX_PER_MIN;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Side-by-side placement for overlapping appointments, as Google Calendar
// does it: events are swept in start order into clusters that share any
// overlap, and inside a cluster each one takes the first lane whose previous
// occupant has already ended. Every event in a cluster is then widened to the
// same lane count, so a 2-deep overlap does not look different from a 3-deep
// one in the same column.
export function layoutLanes(events) {
  const sorted = events.slice().sort((a, b) => (a.startMin - b.startMin) || (a.endMin - b.endMin));
  const placed = [];
  let cluster = [];
  let clusterEnd = -1;

  const flush = () => {
    if (!cluster.length) return;
    const laneEnds = [];
    cluster.forEach((ev) => {
      let i = 0;
      while (i < laneEnds.length && laneEnds[i] > ev.startMin) i += 1;
      laneEnds[i] = ev.endMin;
      ev.lane = i;
    });
    cluster.forEach((ev) => { ev.lanes = laneEnds.length; });
    placed.push(...cluster);
    cluster = [];
    clusterEnd = -1;
  };

  sorted.forEach((ev) => {
    if (cluster.length && ev.startMin >= clusterEnd) flush();
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.endMin);
  });
  flush();
  return placed;
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function EventBlock({ ev, onOpen, narrow }) {
  const look = apptLook(ev.status);
  // Clamped so a 7 AM or 9 PM appointment is still reachable rather than
  // drawn off the top or bottom of the grid.
  const top = Math.max(0, (ev.startMin - DAY_START_MIN) * PX_PER_MIN);
  const rawH = (ev.endMin - ev.startMin) * PX_PER_MIN;
  const height = Math.max(26, Math.min(rawH, GRID_H - top));
  const widthPct = 100 / (ev.lanes || 1);

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onOpen(ev, e.currentTarget); }}
      title={ev.name + ' · ' + fmtMin(ev.startMin) + ' · ' + (ev.treatment || '')}
      style={{
        position: 'absolute', top, height,
        left: 'calc(' + (widthPct * (ev.lane || 0)) + '% + 2px)',
        width: 'calc(' + widthPct + '% - 4px)',
        background: look.bg, border: '1px solid ' + look.bd, borderLeft: '4px solid ' + look.bar,
        borderRadius: 8, padding: narrow ? '3px 5px' : '4px 8px', cursor: 'pointer',
        textAlign: 'left', overflow: 'hidden', color: look.ink,
        display: 'flex', flexDirection: 'column', gap: 1, lineHeight: 1.2,
      }}
    >
      <span style={{ fontWeight: 700, fontSize: narrow ? 11 : 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {ev.name}
      </span>
      {height >= 40 && (
        <span style={{ fontSize: narrow ? 10 : 11, opacity: .85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {fmtMin(ev.startMin)}
        </span>
      )}
      {height >= 58 && ev.treatment && (
        <span style={{ fontSize: narrow ? 10 : 11, opacity: .75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {ev.treatment}
        </span>
      )}
    </button>
  );
}

export function Legend({ counts }) {
  const items = [
    { label: 'Not sent', n: counts.white, swatch: apptLook('notsent') },
    { label: 'Awaiting reply', n: counts.yellow, swatch: apptLook('sent') },
    { label: 'Coming', n: counts.green, swatch: apptLook('coming') },
    { label: "Can't come", n: counts.red, swatch: apptLook('cant') },
  ];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', marginBottom: 10 }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#5c7a76' }}>
          <span style={{
            width: 12, height: 12, borderRadius: 4,
            background: it.swatch.bg, border: '1px solid ' + it.swatch.bd, borderLeft: '3px solid ' + it.swatch.bar,
            display: 'inline-block',
          }} />
          {it.label}
          <strong style={{ color: '#0e3b39' }}>{it.n}</strong>
        </span>
      ))}
    </div>
  );
}

export default function WeekGrid({ days, eventsByDay, onOpenEvent, onPickDay, narrow }) {
  const [now, setNow] = useState(nowMinutes());
  const scroller = useRef(null);
  const today = todayYmd();

  // The red line is only honest if it moves. A minute is plenty — the grid is
  // 60px/hour, so a minute is one pixel.
  useEffect(() => {
    const t = setInterval(() => setNow(nowMinutes()), 60000);
    return () => clearInterval(t);
  }, []);

  // Open on the working day rather than at 9 AM sharp, so the first thing on
  // screen is the part of the day that is still ahead.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const target = Math.max(0, (Math.max(now, DAY_START_MIN) - DAY_START_MIN) * PX_PER_MIN - 120);
    el.scrollTop = target;
    // Only on mount: scrolling the grid out from under someone every minute
    // would make it unusable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hours = [];
  for (let m = DAY_START_MIN; m < DAY_END_MIN; m += 60) hours.push(m);

  const showNow = days.includes(today) && now >= DAY_START_MIN && now <= DAY_END_MIN;
  const nowTop = (now - DAY_START_MIN) * PX_PER_MIN;

  return (
    <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, overflow: 'hidden' }}>
      {/* Column headers, outside the scroller so they stay put */}
      <div style={{ display: 'flex', borderBottom: '1px solid #eef4f3', background: '#f7fbfa' }}>
        <div style={{ width: AXIS_W, flexShrink: 0 }} />
        {days.map((d) => {
          const dt = parseYmd(d);
          const isToday = d === today;
          return (
            <button
              key={d}
              onClick={() => onPickDay && onPickDay(d)}
              style={{
                flex: 1, minWidth: 0, border: 0, background: 'transparent', cursor: onPickDay ? 'pointer' : 'default',
                padding: '9px 2px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#7a9994' }}>
                {DOW[dt.getDay()]}
              </span>
              <span style={{
                width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13.5, fontWeight: 700,
                background: isToday ? '#0e756c' : 'transparent', color: isToday ? '#fff' : '#0e3b39',
              }}>
                {dt.getDate()}
              </span>
            </button>
          );
        })}
      </div>

      <div ref={scroller} style={{ position: 'relative', maxHeight: 560, overflowY: 'auto' }}>
        <div style={{ display: 'flex', position: 'relative', height: GRID_H }}>
          {/* Time axis */}
          <div style={{ width: AXIS_W, flexShrink: 0, position: 'relative', borderRight: '1px solid #eef4f3' }}>
            {hours.map((m) => (
              <div key={m} style={{
                position: 'absolute', top: (m - DAY_START_MIN) * PX_PER_MIN, right: 6,
                fontSize: 10.5, color: '#98b0ab', transform: 'translateY(-6px)', whiteSpace: 'nowrap',
              }}>
                {fmtMin(m)}
              </div>
            ))}
          </div>

          {days.map((d) => (
            <div key={d} style={{
              flex: 1, minWidth: 0, position: 'relative',
              borderRight: '1px solid #f3f8f7',
              background: d === today ? '#fbfefe' : '#fff',
            }}>
              {hours.map((m) => (
                <div key={m} style={{
                  position: 'absolute', left: 0, right: 0, top: (m - DAY_START_MIN) * PX_PER_MIN,
                  borderTop: '1px solid #f1f7f6',
                }} />
              ))}
              {layoutLanes((eventsByDay[d] || []).map((e) => ({ ...e }))).map((ev) => (
                <EventBlock key={ev.appointmentId} ev={ev} onOpen={onOpenEvent} narrow={narrow} />
              ))}
              {showNow && d === today && (
                <div style={{ position: 'absolute', left: 0, right: 0, top: nowTop, zIndex: 3, pointerEvents: 'none' }}>
                  <div style={{ height: 2, background: '#e1443a' }} />
                  <div style={{
                    position: 'absolute', left: -4, top: -3, width: 8, height: 8,
                    borderRadius: '50%', background: '#e1443a',
                  }} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Shared by the grid and the table so a day's events are shaped once.
export function toEvent(appt) {
  const startMin = appt.startMin;
  const dur = Number(appt.durationMin) || 30;
  return {
    ...appt,
    startMin,
    endMin: startMin + dur,
    status: apptStatus(appt),
  };
}
