// One line under the next-appointment date and time, saying what saving the
// form will send.
//
// Render-only, by design. It adds no dialog, no confirmation step and no
// await to Save and Next — the doctor is mid-consultation and the cost of
// interrupting them is higher than the cost of a wrong message, which the
// Appointments tab can fix in two clicks anyway.

import { firstName } from './statusModel';
import { fmtDay, fmtMin, toMinutes } from './ui';
import { useWa } from './WaContext';

export default function NextAppointmentNotice({ patientName, mobile, date, time, prevDate, prevTime }) {
  const wa = useWa();
  if (!wa.enabled || !date) return null;

  const name = (patientName || '').trim() || 'The patient';
  const first = firstName(name);
  const min = toMinutes(time);
  const when = fmtDay(date, { weekday: 'short', day: 'numeric', month: 'short' })
    + (min == null ? '' : ', ' + fmtMin(min));

  let text;
  let tone = '#5c7a76';
  let bg = '#f7fbfa';
  let bd = '#e2efec';

  if (wa.isOptedOut(mobile)) {
    text = name + ' has WhatsApp turned off — please tell them the date before they leave.';
  } else if (min == null) {
    text = name + ' will get a WhatsApp confirmation for ' + when
      + ' when you save. Add a time and the reminder can go out the day before.';
  } else if (prevDate && (prevDate !== date || toMinutes(prevTime) !== min)) {
    // Amber: this is not a new appointment, it is a correction, and a patient
    // has already been told something else.
    const prevMin = toMinutes(prevTime);
    text = first + ' was told ' + fmtDay(prevDate, { weekday: 'short', day: 'numeric', month: 'short' })
      + (prevMin == null ? '' : ', ' + fmtMin(prevMin))
      + '. Saving cancels that reminder and sends the new time: ' + when + '.';
    tone = '#8a4f0b'; bg = '#fff8ec'; bd = '#f0dcb8';
  } else {
    text = name + ' will get a WhatsApp confirmation for ' + when
      + ' when you save, and a reminder the day before.';
  }

  return (
    <p style={{
      display: 'block', marginTop: 8, padding: '9px 12px', borderRadius: 10,
      background: bg, border: '1px solid ' + bd, fontSize: 12.5, color: tone, lineHeight: 1.5,
    }}>
      {text}
    </p>
  );
}
