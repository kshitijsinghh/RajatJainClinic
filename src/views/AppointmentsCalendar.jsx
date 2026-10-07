// The Appointments tab, for clinics with WhatsApp switched on.
//
// Clinics without it keep the old views/Appointments.jsx untouched — see
// App.jsx. That is deliberate: the safest way not to break a clinic that is
// not part of this rollout is to leave its code path exactly where it was,
// rather than making the new one degrade gracefully and hoping.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WeekGrid, { Legend, toEvent } from '../whatsapp/appointments/WeekGrid';
import EventPopover, { CancelModal } from '../whatsapp/appointments/EventPopover';
import AppointmentsTable from '../whatsapp/appointments/AppointmentsTable';
import FailedMessagesBanner from '../whatsapp/FailedMessagesBanner';
import { apptBucket, firstName } from '../whatsapp/statusModel';
import { Toast, addDays, fmtDay, fmtMin, parseYmd, todayYmd, toMinutes } from '../whatsapp/ui';
import { cancelAppointment, listAppointments, rescheduleAppointment, sendMessage } from '../whatsapp/waApi';
import { setAppointment } from '../api';
import { useWa } from '../whatsapp/WaContext';

const POLL_MS = 30000;

function startOfWeek(d) {
  const dt = parseYmd(d);
  dt.setDate(dt.getDate() - dt.getDay()); // Sunday
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

function Segmented({ options, value, onChange, small }) {
  return (
    <div style={{ display: 'inline-flex', background: '#eef4f3', borderRadius: 10, padding: 3, gap: 2 }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            minHeight: small ? 32 : 36, padding: small ? '0 11px' : '0 14px', borderRadius: 8, border: 0,
            background: value === o.value ? '#fff' : 'transparent',
            color: value === o.value ? '#0e3b39' : '#5c7a76',
            fontWeight: 700, fontSize: small ? 12.5 : 13, cursor: 'pointer',
            boxShadow: value === o.value ? '0 1px 3px rgba(14,59,57,.14)' : 'none',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function AppointmentsCalendar({ onOpenVisit }) {
  const wa = useWa();
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' ? window.innerWidth < 760 : false);
  const [range, setRange] = useState('week');     // 'day' | 'week'
  const [mode, setMode] = useState('calendar');   // 'calendar' | 'table'
  const [anchorDate, setAnchorDate] = useState(todayYmd());
  const [appts, setAppts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [sel, setSel] = useState(null);           // { ev, anchor }
  const [cancelFor, setCancelFor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);

  useEffect(() => {
    const onResize = () => setIsMobile((m) => (window.innerWidth < 760) !== m ? window.innerWidth < 760 : m);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  function say(msg) {
    clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(''), 3600);
  }

  // A phone has no room for seven columns at 60px an hour, so the Day/Week
  // switch is not offered there and the range is forced to a single day.
  const effRange = isMobile ? 'day' : range;

  const days = useMemo(() => {
    if (effRange === 'day') return [anchorDate];
    const s = startOfWeek(anchorDate);
    return Array.from({ length: 7 }, (_, i) => addDays(s, i));
  }, [effRange, anchorDate]);

  const from = days[0];
  const to = days[days.length - 1];

  // Always fetch the whole week, even in day mode. The phone's day strip
  // spans seven days and puts a dot on the ones that have appointments, so
  // fetching only the selected day left every other dot blank — the data to
  // draw them had never been asked for. eventsByDay and inView are both
  // scoped to `days`, so the extra rows change nothing that is rendered, and
  // moving between days within a week no longer refetches.
  const fetchFrom = useMemo(() => startOfWeek(anchorDate), [anchorDate]);
  const fetchTo = useMemo(() => addDays(startOfWeek(anchorDate), 6), [anchorDate]);

  const load = useCallback(async (quiet) => {
    if (!quiet) setLoading(true);
    try {
      const rows = await listAppointments({ from: fetchFrom, to: fetchTo });
      setAppts(rows);
      setLoadError('');
    } catch (err) {
      // A failed refresh must not blank a calendar the staff are reading.
      if (!quiet) setLoadError(String((err && err.message) || 'Could not load appointments.'));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [fetchFrom, fetchTo]);

  useEffect(() => { load(false); }, [load]);

  // Replies and delivery receipts arrive by webhook, so the only way the
  // screen learns about them is to ask again. Paused when the tab is hidden —
  // polling a backgrounded tab every 30s for hours is just a bill.
  useEffect(() => {
    const tick = () => { if (!document.hidden) load(true); };
    const t = setInterval(tick, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const events = useMemo(() => appts.map((a) => toEvent({
    ...a,
    startMin: toMinutes(a.time) == null ? 9 * 60 : toMinutes(a.time),
    whatsappOff: a.whatsappOff || wa.isOptedOut(a.mobile),
  })).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.startMin - y.startMin)), [appts, wa]);

  const eventsByDay = useMemo(() => {
    const map = {};
    days.forEach((d) => { map[d] = []; });
    events.forEach((e) => { if (map[e.date]) map[e.date].push(e); });
    return map;
  }, [events, days]);

  const inView = useMemo(() => events.filter((e) => e.date >= from && e.date <= to), [events, from, to]);

  const counts = useMemo(() => {
    const c = { white: 0, yellow: 0, green: 0, red: 0 };
    inView.forEach((e) => { c[apptBucket(e.status)] += 1; });
    return c;
  }, [inView]);

  const title = effRange === 'day'
    ? fmtDay(anchorDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : fmtDay(from, { day: 'numeric', month: 'short' }) + ' – ' + fmtDay(to, { day: 'numeric', month: 'short', year: 'numeric' });

  const step = effRange === 'day' ? 1 : 7;

  function openEvent(ev, el) {
    const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    setActionError('');
    setSel({ ev, anchor: r ? { left: r.right + 10, top: r.top } : null });
  }

  // The pop-up holds a snapshot of the event it was opened with; after a
  // reload that snapshot is stale. Re-reading it from the fresh list keeps a
  // reply that landed during a poll visible without closing the pop-up.
  const selEvent = sel ? (events.find((e) => e.appointmentId === sel.ev.appointmentId) || sel.ev) : null;

  async function doSendNow(ev) {
    setBusy(true); setActionError('');
    try {
      await sendMessage({
        useCase: 'APPOINTMENT_CONFIRMATION',
        patientId: ev.patientId, visitId: ev.visitId, mobile: ev.mobile, name: ev.name,
        params: { appointment_date: fmtDay(ev.date, { weekday: 'long', day: 'numeric', month: 'long' }), appointment_time: fmtMin(ev.startMin) },
        docVersion: ev.appointmentId,
      });
      await load(true);
      say('Confirmation sent to ' + firstName(ev.name) + ' on WhatsApp');
    } catch (err) {
      setActionError(String((err && err.message) || 'Could not send.'));
    } finally {
      setBusy(false);
    }
  }

  // The toast reports what ACTUALLY happened to the message, not what was
  // attempted. The appointment is saved either way — the server returns ok
  // even when the send fails, because a booked slot must survive a failed
  // message — so a toast that always says "sent on WhatsApp" would be
  // telling reception the patient knows, when they may not.
  function saidToast(verb, ev, notified) {
    const first = firstName(ev.name);
    if (ev.whatsappOff) return verb + ' — call ' + first + ' with the details';
    if (notified && notified.sent) {
      return verb === 'Rescheduled'
        ? 'Rescheduled — new time sent to ' + first + ' on WhatsApp'
        : 'Appointment cancelled — ' + first + ' has been told on WhatsApp';
    }
    return verb + " — the WhatsApp message didn't go. Call " + first + '.';
  }

  // The WhatsApp service owns the appointment and the patient's message; the
  // sheet and the clinic's Google Calendar are a separate system that knows
  // nothing about either. Run second and deliberately not awaited into the
  // failure path: the patient has already been told, so a calendar that did
  // not follow is worth reporting but must not read as "the cancellation
  // failed" and invite a second attempt.
  async function syncSheetAndCalendar(ev, date, time) {
    if (!ev || !ev.visitId) return '';
    try {
      const r = await setAppointment({ visitId: ev.visitId, date: date || '', time: time || '' });
      if (r && r.calendarError) return ' Google Calendar was not updated — check it.';
      return '';
    } catch {
      return ' Google Calendar was not updated — check it.';
    }
  }

  async function doReschedule(ev, date, time) {
    setBusy(true); setActionError('');
    try {
      const r = await rescheduleAppointment({ appointmentId: ev.appointmentId, date, time });
      const calNote = await syncSheetAndCalendar(ev, date, time);
      await load(true);
      setSel(null);
      say(saidToast('Rescheduled', ev, r && r.notified) + calNote);
    } catch (err) {
      setActionError(String((err && err.message) || 'Could not reschedule.'));
    } finally {
      setBusy(false);
    }
  }

  async function doCancel(ev) {
    setBusy(true); setActionError('');
    try {
      const r = await cancelAppointment({ appointmentId: ev.appointmentId });
      const calNote = await syncSheetAndCalendar(ev, '', '');
      await load(true);
      setCancelFor(null);
      setSel(null);
      say(saidToast('Appointment cancelled', ev, r && r.notified) + calNote);
    } catch (err) {
      setActionError(String((err && err.message) || 'Could not cancel.'));
      setCancelFor(null);
    } finally {
      setBusy(false);
    }
  }

  const navBtn = {
    width: 36, height: 36, borderRadius: 10, border: '1px solid #cfe3df', background: '#fff',
    color: '#0e756c', fontSize: 17, cursor: 'pointer', display: 'flex', alignItems: 'center',
    justifyContent: 'center', padding: 0, flexShrink: 0,
  };

  return (
    <div>
      <FailedMessagesBanner />

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <button
          onClick={() => setAnchorDate(todayYmd())}
          style={{ ...navBtn, width: 'auto', padding: '0 14px', fontSize: 13, fontWeight: 700 }}
        >
          Today
        </button>
        <button onClick={() => setAnchorDate(addDays(anchorDate, -step))} style={navBtn} aria-label="Previous">‹</button>
        <button onClick={() => setAnchorDate(addDays(anchorDate, step))} style={navBtn} aria-label="Next">›</button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{
            fontFamily: "'Bricolage Grotesque'", fontWeight: 700, color: '#0e3b39',
            fontSize: 'clamp(15px, 4vw, 20px)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {title}
          </h2>
          <p style={{ fontSize: 13, color: '#5c7a76' }}>
            {inView.length} {inView.length === 1 ? 'appointment' : 'appointments'}
            {loading && <span style={{ color: '#98b0ab' }}> · loading…</span>}
          </p>
        </div>

        {!isMobile && (
          <Segmented
            options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }]}
            value={range} onChange={setRange}
          />
        )}
        <Segmented
          options={[{ value: 'calendar', label: 'Calendar' }, { value: 'table', label: 'Table' }]}
          value={mode} onChange={setMode}
        />
      </div>

      {/* Phone day strip */}
      {isMobile && mode === 'calendar' && (
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 10, marginBottom: 4 }}>
          {Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchorDate), i)).map((d) => {
            const dt = parseYmd(d);
            const on = d === anchorDate;
            const n = events.filter((e) => e.date === d).length;
            return (
              <button
                key={d}
                onClick={() => setAnchorDate(d)}
                style={{
                  flex: '0 0 auto', minWidth: 52, padding: '8px 4px', borderRadius: 12,
                  border: '1px solid ' + (on ? '#0e756c' : '#dfece9'),
                  background: on ? '#0e756c' : '#fff', color: on ? '#fff' : '#0e3b39',
                  cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                }}
              >
                <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', opacity: .8 }}>
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()]}
                </span>
                <span style={{ fontSize: 15, fontWeight: 700 }}>{dt.getDate()}</span>
                <span style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: n ? (on ? '#ffd666' : '#e8a912') : 'transparent',
                }} />
              </button>
            );
          })}
        </div>
      )}

      {loadError && (
        <div style={{ background: '#fdecea', border: '1px solid #f6d3c8', borderRadius: 12, padding: '11px 14px', marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: '#c0392b', fontWeight: 600 }}>{loadError}</span>
          <button
            onClick={() => load(false)}
            style={{ marginLeft: 12, padding: '5px 12px', borderRadius: 8, border: 0, background: '#c0392b', color: '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      )}

      {mode === 'calendar' && <Legend counts={counts} />}

      {mode === 'calendar' ? (
        <WeekGrid
          days={days}
          eventsByDay={eventsByDay}
          onOpenEvent={openEvent}
          onPickDay={effRange === 'week' ? (d) => { setAnchorDate(d); setRange('day'); } : null}
          narrow={isMobile}
        />
      ) : (
        <AppointmentsTable events={inView} onOpenEvent={openEvent} isMobile={isMobile} />
      )}

      {selEvent && (
        <EventPopover
          ev={selEvent}
          anchor={sel.anchor}
          isMobile={isMobile}
          optedOut={!!selEvent.whatsappOff}
          busy={busy}
          error={actionError}
          onClose={() => setSel(null)}
          onSendNow={doSendNow}
          onReschedule={doReschedule}
          onAskCancel={(ev) => setCancelFor(ev)}
          onOpenVisit={onOpenVisit ? (ev) => { setSel(null); onOpenVisit(ev.patientId, ev.visitId); } : null}
        />
      )}

      <CancelModal
        ev={cancelFor}
        optedOut={!!(cancelFor && cancelFor.whatsappOff)}
        busy={busy}
        onKeep={() => (busy ? null : setCancelFor(null))}
        onConfirm={() => doCancel(cancelFor)}
      />

      <Toast message={toast} />
    </div>
  );
}
