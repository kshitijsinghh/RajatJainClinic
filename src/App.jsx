import { useEffect, useState } from 'react';
import Header from './components/Header';
import Dashboard from './views/Dashboard';
import Intake from './views/Intake';
import Clinical from './views/Clinical';
import Appointments from './views/Appointments';
import AppointmentsCalendar from './views/AppointmentsCalendar';
import Messages from './views/Messages';
import Patients from './views/Patients';
import PatientDetail from './views/PatientDetail';
import { fetchList, saveIntake, saveClinical, uploadQr, getCachedList, fetchOrg, getRxTemplateUrl, generatePrescriptionPdf, updatePatient, logEvent } from './api';
import { WaProvider, useWa } from './whatsapp/WaContext';
import { upsertAppointment, cancelAppointment } from './whatsapp/waApi';
import { useIsPhone } from './whatsapp/ui';

// The old Appointments list and the new calendar are two components, not one
// component with a flag inside it. A clinic that is not part of the WhatsApp
// rollout renders exactly the code it rendered yesterday.
function AppointmentsSwitch({ legacy, onOpenVisit }) {
  const wa = useWa();
  if (!wa.ready) return null;
  return wa.enabled ? <AppointmentsCalendar onOpenVisit={onOpenVisit} /> : <Appointments {...legacy} />;
}

// The floating "New Visit" button.
//
// It used to hide on the appointments tab only when `showApptCal` was set —
// but that flag belongs to the LEGACY appointments view. A clinic with
// WhatsApp on renders AppointmentsCalendar instead and never sets it, so the
// button stayed, floating over the calendar. On a phone it covers the grid
// outright, which is where it was reported.
//
// Lives in its own component because useWa() cannot be called by App, which
// is what renders the provider.
function NewVisitFab({ view, showApptCal, onClick }) {
  const wa = useWa();
  const isPhone = useIsPhone();
  if (view !== 'dashboard' && view !== 'appointments' && view !== 'patients') return null;
  if (view === 'appointments' && (showApptCal || (wa.enabled && isPhone))) return null;
  return (
    <button
      onClick={onClick}
      title="New visit"
      aria-label="New visit"
      style={{
        position: 'fixed', right: 22, bottom: 22, zIndex: 70, height: 58, padding: '0 24px',
        border: 0, borderRadius: 100, background: '#ef5a3c', color: '#fff', fontWeight: 700,
        fontSize: 15.5, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9,
        boxShadow: '0 14px 30px -8px rgba(239,90,60,.55)',
      }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
      New Visit
    </button>
  );
}

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function firstOfMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
}
function normMobile(m) {
  return (m || '').replace(/\D/g, '');
}
function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return d;
  }
}
function num(x) {
  const n = parseFloat(x);
  return isNaN(n) ? 0 : n;
}
function inr(n) {
  return '₹' + Math.round(n).toLocaleString('en-IN');
}
function fmtTime(t) {
  if (!t) return '—';
  if (/AM|PM/i.test(t)) return t;
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 || 12;
  return hr + ':' + String(m).padStart(2, '0') + ' ' + ampm;
}

// Show the doctor what actually failed. Apps Script returns readable messages
// ("Visit not found: P0027_1", "Service invoked too many times"), and a real
// message is something they can report; "Something went wrong" is not.
function errText(err, fallback) {
  const m = String((err && err.message) || '').trim();
  if (!m) return fallback;
  return m.length > 160 ? m.slice(0, 160) + '…' : m;
}
function blankClinical() {
  return {
    chiefComplaint: [], chiefDescription: '', medicalHistory: '',
    // Written by the patient at check-in, never by the doctor. Kept apart
    // from medicalHistory above, which is the doctor's own clinical note.
    patientProblem: '', patientMedicalHistory: '', patientAllergies: '', patientDentalHistory: '',
    diagnosis: '', investigation: '',
    toothNumber: [], treatmentTeeth: {}, advisedTeeth: {},
    treatmentGroup: [], treatment: [], treatmentOther: '',
    advisedTreatment: [], medicines: [], documents: [], paySplits: [],
    labName: '', labToothNumber: '', labDescription: '',
    treatmentCost: '', amountPaid: '', balanceDue: '', paymentMode: '', paymentStatus: '',
    treatmentStage: '', googleReviewTaken: '', nextAppointment: '', nextAppointmentTime: '', comments: '',
  };
}
function tryParseJson(v) {
  if (typeof v === 'string' && v.startsWith('[')) {
    try { const p = JSON.parse(v); if (Array.isArray(p)) return p; } catch {}
  }
  return v;
}
function tryParseObj(v) {
  if (typeof v === 'string' && v.startsWith('{')) {
    try { const p = JSON.parse(v); if (p && typeof p === 'object' && !Array.isArray(p)) return p; } catch {}
  }
  return v;
}
function normalizeClinical(c) {
  const out = { ...blankClinical(), ...c };
  ['chiefComplaint', 'treatmentGroup', 'treatment', 'advisedTreatment', 'toothNumber'].forEach(k => {
    let v = tryParseJson(out[k]);
    out[k] = Array.isArray(v) ? v : (v ? [v] : []);
  });
  // Legacy records predate per-treatment tooth tagging — normalize to {}.
  ['treatmentTeeth', 'advisedTeeth'].forEach(k => {
    const v = tryParseObj(out[k]);
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  });
  out.medicines = Array.isArray(out.medicines) ? out.medicines : tryParseJson(out.medicines) || [];
  out.paySplits = Array.isArray(out.paySplits) ? out.paySplits : tryParseJson(out.paySplits) || [];
  out.documents = Array.isArray(out.documents) ? out.documents : tryParseJson(out.documents) || [];
  return out;
}
function findAllByMobile(db, mobile) {
  const mm = normMobile(mobile);
  if (!mm || !db) return [];
  const result = [];
  for (const id of db.order) {
    if (db.patients[id].mobile === mm) result.push(db.patients[id]);
  }
  return result;
}

export default function App({ user, onLogout }) {
  const [view, setView] = useState('dashboard');
  const [db, setDbState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [q, setQ] = useState('');
  const [dateFrom, setDateFrom] = useState(firstOfMonth());
  const [dateTo, setDateTo] = useState(today());
  const [apptDate, setApptDate] = useState(today());
  const [showApptCal, setShowApptCal] = useState(false);

  const [form, setForm] = useState({ mobile: '', name: '', age: '', gender: '', address: '', email: '', date: today() });
  const [lookupState, setLookupState] = useState('');
  const [existingPatientId, setExistingPatientId] = useState('');
  const [mobilePatients, setMobilePatients] = useState([]);
  const [addAnother, setAddAnother] = useState(false);
  const [intakeMode, setIntakeMode] = useState('new');
  const [intakeSearch, setIntakeSearch] = useState('');
  const [intakeError, setIntakeError] = useState('');
  const [savingIntake, setSavingIntake] = useState(false);

  const [curPatientId, setCurPatientId] = useState('');
  const [curVisitId, setCurVisitId] = useState('');
  const [detailPid, setDetailPid] = useState('');
  const [cform, setCform] = useState(blankClinical());
  const [savedFlash, setSavedFlash] = useState(false);
  const [savingClinical, setSavingClinical] = useState(false);
  const [clinicalError, setClinicalError] = useState('');
  const [showQr, setShowQr] = useState(false);
  const [clinicalReadOnly, setClinicalReadOnly] = useState(false);
  const [org, setOrg] = useState(null);
  const [orgLoaded, setOrgLoaded] = useState(false);
  const [rxTemplateUrl, setRxTemplateUrl] = useState(null);

  function applySnapshot(res) {
    setDbState({ patients: res.patients, order: res.order, seq: res.seq, upiQr: res.upiQr, labNames: res.labNames || [] });
  }

  function applyClinicalLocally(patientId, visitId, savedForm, serverRes) {
    setDbState(prev => {
      const p = prev.patients[patientId];
      if (!p) return prev;
      const visits = p.visits.map(v => {
        if (v.visitId !== visitId) return v;
        return { ...v, done: true, clinical: {
          ...v.clinical,
          patientType: savedForm.patientType || '',
          medicalHistory: savedForm.medicalHistory || '',
          chiefComplaint: savedForm.chiefComplaint || '',
          chiefDescription: savedForm.chiefDescription || '',
          diagnosis: savedForm.diagnosis || '',
          investigation: savedForm.investigation || '',
          treatmentTeeth: savedForm.treatmentTeeth || {},
          advisedTeeth: savedForm.advisedTeeth || {},
          treatmentGroup: savedForm.treatmentGroup || '',
          treatment: savedForm.treatment || '',
          advisedTreatment: savedForm.advisedTreatment || '',
          advisedTreatmentOther: savedForm.advisedTreatmentOther || '',
          toothNumber: savedForm.toothNumber || '',
          treatmentOther: savedForm.treatmentOther || '',
          treatmentCost: savedForm.treatmentCost === '' ? '' : String(savedForm.treatmentCost),
          amountPaid: savedForm.amountPaid === '' ? '' : String(savedForm.amountPaid),
          balanceDue: serverRes.balanceDue || savedForm.balanceDue || '',
          paymentMode: savedForm.paymentMode || '',
          paymentStatus: serverRes.paymentStatus || savedForm.paymentStatus || '',
          treatmentStage: savedForm.treatmentStage || '',
          googleReviewTaken: savedForm.googleReviewTaken || '',
          nextAppointment: savedForm.nextAppointment || '',
          nextAppointmentTime: savedForm.nextAppointmentTime || '',
          comments: savedForm.comments || '',
          labName: savedForm.labName || '',
          labToothNumber: savedForm.labToothNumber || '',
          labDescription: savedForm.labDescription || '',
          patientProblem: savedForm.patientProblem || v.clinical?.patientProblem || '',
          patientMedicalHistory: savedForm.patientMedicalHistory || v.clinical?.patientMedicalHistory || '',
          patientAllergies: savedForm.patientAllergies || v.clinical?.patientAllergies || '',
          patientDentalHistory: savedForm.patientDentalHistory || v.clinical?.patientDentalHistory || '',
          medicines: savedForm.medicines || [],
          paySplits: savedForm.paySplits || [],
          documents: savedForm.documents || [],
        }};
      });
      return { ...prev, patients: { ...prev.patients, [patientId]: { ...p, visits } } };
    });
  }

  // Applied locally on success: the server returns only a small ack, and the
  // name is denormalised nowhere in the client model (views read patient.name).
  async function onRenamePatient(patientId, name) {
    const res = await updatePatient({ patientId, name });
    setDbState(prev => {
      const p = prev.patients[patientId];
      if (!p) return prev;
      return { ...prev, patients: { ...prev.patients, [patientId]: { ...p, name: res.name || name } } };
    });
    return res;
  }

  // The appointment is mirrored into DynamoDB after the Sheet write succeeds.
  //
  // The Sheet stays the record of the visit; DynamoDB becomes the record of
  // the appointment, because that is what the reminder scheduler reads, what
  // reschedule and cancel update, and what has to be authoritative when a
  // slot is given away. The mirror is deliberately after the save and
  // deliberately swallowed: a failed mirror must never make a doctor think
  // their clinical notes were lost.
  function syncAppointment(saveForm) {
    if (!org || !org.waEnabled) return;
    const p = db && db.patients && db.patients[curPatientId];
    if (!p) return;

    // The doctor cleared the next appointment. That has to cancel the
    // mirrored row, not just skip it — otherwise the slot stays SCHEDULED
    // in DynamoDB and the scheduler reminds the patient about a visit that
    // is no longer happening, which is worse than never having sent one.
    //
    // A 404 is the ordinary case: this visit never had an appointment.
    if (!saveForm.nextAppointment) {
      cancelAppointment({ appointmentId: curVisitId }).catch((err) => {
        if (/not found/i.test(String((err && err.message) || ''))) return;
        logEvent({ kind: 'wa_request', op: 'cancelAppointment', outcome: 'api_error',
          serverError: String((err && err.message) || ''), visitId: curVisitId });
      });
      return;
    }
    const tr = Array.isArray(saveForm.treatment) ? saveForm.treatment.join(', ') : (saveForm.treatment || '');
    upsertAppointment({
      patientId: curPatientId,
      visitId: curVisitId,
      name: p.name,
      mobile: p.mobile,
      date: saveForm.nextAppointment,
      time: saveForm.nextAppointmentTime || '',
      treatment: tr || saveForm.treatmentOther || '',
    }).catch((err) => {
      logEvent({ kind: 'wa_request', op: 'upsertAppointment', outcome: 'api_error',
        serverError: String((err && err.message) || ''), visitId: curVisitId });
    });
  }

  async function loadList(isRefresh) {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const res = await fetchList();
      applySnapshot(res);
      setLoadError('');
    } catch (err) {
      setLoadError(errText(err, 'Something went wrong, please try again'));
    } finally {
      if (isRefresh) setRefreshing(false); else setLoading(false);
    }
  }

  useEffect(() => {
    const cached = getCachedList();
    if (cached) {
      applySnapshot(cached);
      setLoading(false);
      loadList(true);
    } else {
      loadList(false);
    }
    fetchOrg().then(o => {
      if (o) setOrg(o);
      if (o?.rxTemplateKey && !o.rxTemplateKey.endsWith('.docx')) {
        getRxTemplateUrl().then(u => { if (u) setRxTemplateUrl(u); });
      }
    // fetchOrg swallows its own errors and resolves null, so this fires
    // either way — the WhatsApp provider must not wait forever on a clinic
    // whose org record failed to load.
    }).finally(() => setOrgLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    window.history.replaceState({ view: 'dashboard' }, '');
    const onPop = (e) => {
      setView(e.state?.view || 'dashboard');
      setDetailPid(e.state?.detailPid || '');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function pushView(v) {
    window.history.pushState({ view: v }, '');
    setView(v);
  }
  function replaceView(v) {
    window.history.replaceState({ view: v }, '');
    setView(v);
  }
  function goBack() {
    window.history.back();
  }

  function goDash() {
    pushView('dashboard');
  }
  function goAppts() {
    pushView('appointments');
  }
  function goIntake() {
    pushView('intake');
    setForm({ mobile: '', name: '', age: '', gender: '', address: '', email: '', date: today() });
    setLookupState('');
    setExistingPatientId('');
    setMobilePatients([]);
    setAddAnother(false);
    setIntakeError('');
    setIntakeMode('new');
    setIntakeSearch('');
  }
  function goPatients() {
    pushView('patients');
  }
  function goMessages() {
    pushView('messages');
  }
  function openPatientDetail(pid) {
    setDetailPid(pid);
    window.history.pushState({ view: 'patientDetail', detailPid: pid }, '');
    setView('patientDetail');
  }

  function onLookup(mobile) {
    const m = mobile || form.mobile;
    const matches = findAllByMobile(db, m);
    setMobilePatients(matches);
    setAddAnother(false);
    if (matches.length > 0) {
      const p = matches[0];
      setLookupState('existing');
      setExistingPatientId(p.patientId);
      setIntakeError('');
      setForm((f) => ({ ...f, name: p.name, age: p.age, gender: p.gender }));
    } else if (normMobile(m)) {
      setLookupState('new');
      setExistingPatientId('');
      setIntakeError('');
    }
  }

  function onSelectPatient(pid) {
    const p = mobilePatients.find((x) => x.patientId === pid);
    if (!p) return;
    setExistingPatientId(p.patientId);
    setAddAnother(false);
    setIntakeError('');
    setForm((f) => ({ ...f, name: p.name, age: p.age, gender: p.gender }));
  }

  function onAddAnother() {
    setAddAnother(true);
    setExistingPatientId('');
    setIntakeError('');
    setForm((f) => ({ ...f, name: '', age: '', gender: '' }));
  }

  function onCancelAddAnother() {
    setAddAnother(false);
    const p = mobilePatients[0];
    if (p) {
      setExistingPatientId(p.patientId);
      setForm((f) => ({ ...f, name: p.name, age: p.age, gender: p.gender }));
    }
  }

  async function startVisitForExisting(pid) {
    const p = db.patients[pid];
    if (!p) return;
    // patientId is explicit: this is a new visit for a patient the user
    // picked by name, and on a shared family number the server cannot
    // work that out from the mobile alone.
    const intakeData = { mobile: p.mobile, name: p.name, age: p.age, gender: p.gender, address: p.address || '', email: p.email || '', date: today(), patientId: pid };
    const optNo = p.visits.length + 1;
    const optVid = pid + '_' + optNo;
    const optVisit = { visitId: optVid, no: optNo, date: today(), done: false, clinical: null, createdAt: new Date().toISOString() };
    const optDb = { ...db, patients: { ...db.patients } };
    optDb.patients[pid] = { ...p, visits: [...p.visits, optVisit] };
    setDbState(optDb);
    setCurPatientId(pid);
    setCurVisitId(optVid);
    setCform(blankClinical());
    setSavedFlash(false);
    setClinicalError('');
    setClinicalReadOnly(false);
    setForm({ mobile: '', name: '', age: '', gender: '', address: '', email: '', date: today() });
    setLookupState('');
    setExistingPatientId('');
    setMobilePatients([]);
    setAddAnother(false);
    setIntakeMode('new');
    setIntakeSearch('');
    replaceView('clinical');
    try {
      const res = await saveIntake(intakeData);
      applySnapshot(res);
      if (res.patientId !== pid) setCurPatientId(res.patientId);
      if (res.visitId !== optVid) setCurVisitId(res.visitId);
    } catch {
      setClinicalError('Visit creation failed — please go back and try again.');
    }
  }

  async function onSaveIntake() {
    const mm = normMobile(form.mobile);
    if (!mm) return setIntakeError('Please enter a mobile number.');
    if (mm.length !== 10) return setIntakeError('Mobile number must be exactly 10 digits.');
    if (!form.name.trim() || !String(form.age).trim() || !form.gender || !form.date) {
      return setIntakeError('Name, age, gender and date are required.');
    }
    if (addAnother) {
      const dupName = mobilePatients.some((p) => p.name.toLowerCase() === form.name.trim().toLowerCase());
      if (dupName) {
        return setIntakeError('Another patient with this name already exists on this number. Please use a different name.');
      }
    }
    setIntakeError('');

    const allOnMobile = findAllByMobile(db, mm);
    const existingP = addAnother ? null : allOnMobile.find((p) => p.name.toLowerCase() === form.name.trim().toLowerCase());
    // The screen already knows whether this is a returning patient, which one,
    // or a new person on a number someone else already uses. Telling the
    // server is what makes the second patient on a family phone a second
    // record rather than an edit of the first.
    const intakeData = {
      mobile: mm, name: form.name.trim(), age: form.age, gender: form.gender,
      address: (form.address || '').trim(), email: (form.email || '').trim(), date: form.date,
      patientId: existingP ? existingP.patientId : '',
      newPatient: !existingP,
    };
    const optPid = existingP ? existingP.patientId : 'P' + String(db.seq + 1).padStart(4, '0');
    const optNo = existingP ? existingP.visits.length + 1 : 1;
    const optVid = optPid + '_' + optNo;

    const optVisit = { visitId: optVid, no: optNo, date: form.date, done: false, clinical: null, createdAt: new Date().toISOString() };
    const optDb = { ...db, patients: { ...db.patients } };
    if (existingP) {
      optDb.patients[optPid] = { ...existingP, visits: [...existingP.visits, optVisit] };
    } else {
      optDb.patients[optPid] = { patientId: optPid, name: intakeData.name, age: intakeData.age, gender: intakeData.gender, address: intakeData.address, email: intakeData.email, mobile: mm, visits: [optVisit] };
      optDb.order = [optPid, ...db.order];
      optDb.seq = db.seq + 1;
    }

    setDbState(optDb);
    setCurPatientId(optPid);
    setCurVisitId(optVid);
    const autoType = Number(form.age) <= 12 ? 'Kid' : 'Adult';
    setCform({ ...blankClinical(), patientType: autoType });
    setSavedFlash(false);
    setClinicalError('');
    setClinicalReadOnly(false);
    setForm({ mobile: '', name: '', age: '', gender: '', address: '', email: '', date: today() });
    setLookupState('');
    setExistingPatientId('');
    setMobilePatients([]);
    setAddAnother(false);
    replaceView('clinical');

    try {
      const res = await saveIntake(intakeData);
      applySnapshot(res);
      if (res.patientId !== optPid) setCurPatientId(res.patientId);
      if (res.visitId !== optVid) setCurVisitId(res.visitId);
    } catch {
      setClinicalError('Visit creation failed — please go back and try again.');
    }
  }

  function openVisit(pid, visitId, readOnly) {
    const p = db.patients[pid];
    setCurPatientId(pid);
    setCurVisitId(visitId);
    const v = p && p.visits.find((x) => x.visitId === visitId);
    const base = v && v.clinical ? normalizeClinical(v.clinical) : blankClinical();
    if (!base.patientType && p) {
      base.patientType = Number(p.age) <= 12 ? 'Kid' : 'Adult';
    }
    setCform(base);
    setSavedFlash(false);
    setClinicalError('');
    setClinicalReadOnly(!!readOnly);
    pushView('clinical');
  }

  function onCreateNewVisitFromAppt(pid) {
    const p = db.patients[pid];
    if (!p) return;
    setForm({ mobile: p.mobile, name: p.name, age: p.age, gender: p.gender, address: p.address || '', email: p.email || '', date: today() });
    setLookupState('existing');
    setExistingPatientId(pid);
    setMobilePatients(findAllByMobile(db, p.mobile));
    setAddAnother(false);
    setIntakeError('');
    setClinicalReadOnly(false);
    pushView('intake');
  }

  async function onSaveAndNext() {
    setSavingClinical(true);
    setClinicalError('');
    try {
      const saveForm = { ...cform };
      if (!saveForm.labToothNumber && saveForm.toothNumber && (saveForm.labName || saveForm.labDescription)) {
        saveForm.labToothNumber = Array.isArray(saveForm.toothNumber) ? saveForm.toothNumber.join(', ') : saveForm.toothNumber;
      }
      const remaining = num(saveForm.treatmentCost) + prevPending - num(saveForm.amountPaid);
      saveForm.paymentStatus = remaining <= 0 ? 'Fully Paid' : (num(saveForm.amountPaid) > 0 ? 'Partially paid' : 'Not paid');
      saveForm.balanceDue = String(Math.max(0, remaining));
      // Strip base64 dataUrl — too large for Sheet cells (50K char limit); files go to S3 later
      saveForm.documents = (saveForm.documents || []).map(({ dataUrl, ...rest }) => rest);
      const res = await saveClinical({ patientId: curPatientId, visitId: curVisitId, cform: saveForm });
      if (res.patients) applySnapshot(res);
      else applyClinicalLocally(curPatientId, curVisitId, saveForm, res);
      syncAppointment(saveForm);
    } catch (err) {
      setClinicalError(errText(err, 'Auto-save failed — your data is still in the form.'));
    } finally {
      setSavingClinical(false);
    }
  }

  async function onSaveClinical() {
    setSavingClinical(true);
    setClinicalError('');
    try {
      const saveForm = { ...cform };
      if (!saveForm.labToothNumber && saveForm.toothNumber && (saveForm.labName || saveForm.labDescription)) {
        saveForm.labToothNumber = Array.isArray(saveForm.toothNumber) ? saveForm.toothNumber.join(', ') : saveForm.toothNumber;
      }
      const remaining = num(saveForm.treatmentCost) + prevPending - num(saveForm.amountPaid);
      saveForm.paymentStatus = remaining <= 0 ? 'Fully Paid' : (num(saveForm.amountPaid) > 0 ? 'Partially paid' : 'Not paid');
      saveForm.balanceDue = String(Math.max(0, remaining));
      // Strip base64 dataUrl — too large for Sheet cells (50K char limit); files go to S3 later
      saveForm.documents = (saveForm.documents || []).map(({ dataUrl, ...rest }) => rest);
      const res = await saveClinical({ patientId: curPatientId, visitId: curVisitId, cform: saveForm });
      if (res.patients) applySnapshot(res);
      else applyClinicalLocally(curPatientId, curVisitId, saveForm, res);
      syncAppointment(saveForm);
      setSavedFlash(true);
      setTimeout(() => {
        setSavedFlash(false);
        replaceView('dashboard');
      }, 900);
    } catch (err) {
      setClinicalError(errText(err, 'Something went wrong, please try again'));
    } finally {
      setSavingClinical(false);
    }
  }

  function onUploadQr(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await uploadQr({ dataUrl: reader.result, filename: file.name });
        applySnapshot(res);
      } catch (err) {
        setClinicalError(errText(err, 'Something went wrong, please try again'));
      }
    };
    reader.readAsDataURL(file);
  }

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 16, background: '#eef4f3',
      }}>
        <div style={{
          width: 44, height: 44, border: '3.5px solid #d6e7e3',
          borderTopColor: '#12a094', borderRadius: '50%',
          animation: 'spin .7s linear infinite',
        }} />
        <span style={{ fontSize: 15, color: '#5c7a76', fontWeight: 600 }}>Loading, please wait...</span>
      </div>
    );
  }
  if (loadError && !db) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ maxWidth: 480, background: '#fff', border: '1px solid #f6d3c8', borderRadius: 16, padding: 24, textAlign: 'center' }}>
          <p style={{ color: '#c0392b', fontWeight: 700, fontSize: 16 }}>Something went wrong, please try again</p>
          <button
            onClick={() => loadList(false)}
            style={{ marginTop: 16, padding: '11px 20px', borderRadius: 10, border: 0, background: '#0e3b39', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const inRange = (d) => {
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
  };

  const rows = [];
  for (const pid of db.order) {
    const p = db.patients[pid];
    for (const v of p.visits) {
      const ps = (v.clinical && v.clinical.paymentStatus) || '';
      const rawTr = v.clinical ? (Array.isArray(v.clinical.treatment) ? v.clinical.treatment : (v.clinical.treatment ? [v.clinical.treatment] : [])) : [];
      const hasOther = rawTr.some(t => /Other/.test(t));
      const tr = hasOther && v.clinical.treatmentOther ? [...rawTr.filter(t => !/Other/.test(t)), v.clinical.treatmentOther].join(', ') : rawTr.join(', ');
      const payMap = { 'Fully Paid': ['#e3f5ec', '#12805a'], 'Partially paid': ['#fdf0dc', '#a9741a'], 'Not paid': ['#fdecea', '#c0392b'] };
      const pm = payMap[ps] || ['#eef4f3', '#8aa8a3'];
      rows.push({
        pid, visitId: v.visitId, no: v.no, ts: Date.parse(v.createdAt) || 0, date: v.date,
        dateLabel: fmtDate(v.date), name: p.name, ageGender: (p.age || '?') + ' · ' + (p.gender || '—'),
        mobile: p.mobile, treatmentLabel: tr || '—', done: v.done,
        payLabel: ps || 'Pending', payBg: pm[0], payInk: pm[1],
        actionLabel: v.done ? 'View / Edit' : 'Doctor form',
        open: () => openVisit(pid, v.visitId),
      });
    }
  }
  rows.sort((a, b) => b.ts - a.ts);
  const rangeRows = rows.filter((r) => inRange(r.date));
  const qq = q.trim().toLowerCase();
  const visitRows = qq ? rangeRows.filter((r) => (r.name + ' ' + r.mobile + ' ' + r.visitId + ' ' + r.pid).toLowerCase().includes(qq)) : rangeRows;

  const rangePatientIds = Array.from(new Set(rangeRows.map((r) => r.pid)));
  let pendingAmount = 0;
  let pendingPatients = 0;
  rangePatientIds.forEach((pid) => {
    const sorted = db.patients[pid].visits.slice().sort((a, b) => (a.no || 0) - (b.no || 0));
    let bal = 0;
    sorted.forEach((v) => {
      bal += num(v.clinical && v.clinical.treatmentCost) - num(v.clinical && v.clinical.amountPaid);
      if (bal < 0) bal = 0;
    });
    if (bal > 0) { pendingPatients++; pendingAmount += bal; }
  });
  const pendingVisits = rangeRows.filter((r) => !r.done).length;
  const stats = [
    { label: 'Patients', value: rangePatientIds.length, color: '#0e756c' },
    { label: 'Visits', value: rangeRows.length, color: '#0e756c' },
    { label: 'Pending visits', value: pendingVisits, color: '#ef5a3c' },
    { label: 'Pending amount', value: inr(pendingAmount), color: '#ef5a3c' },
  ];

  // Appointments: collect all dates with appointments + filter by selected date
  const appts = [];
  const apptDatesMap = {};
  for (const pid of db.order) {
    const p = db.patients[pid];
    for (const v of p.visits) {
      const na = v.clinical && v.clinical.nextAppointment;
      if (!na) continue;
      apptDatesMap[na] = (apptDatesMap[na] || 0) + 1;
      if (na === apptDate) {
        const rawTrr = v.clinical ? (Array.isArray(v.clinical.treatment) ? v.clinical.treatment : (v.clinical.treatment ? [v.clinical.treatment] : [])) : [];
        const hasOtherA = rawTrr.some(t => /Other/.test(t));
        const trr = hasOtherA && v.clinical.treatmentOther ? [...rawTrr.filter(t => !/Other/.test(t)), v.clinical.treatmentOther].join(', ') : rawTrr.join(', ');
        const nat = (v.clinical && v.clinical.nextAppointmentTime) || '';
        appts.push({
          date: na, time: nat, timeLabel: fmtTime(nat), name: p.name, mobile: p.mobile,
          patientId: pid, visitId: v.visitId, treatmentLabel: trr || '—',
          stage: (v.clinical.treatmentStage || '—'),
          open: () => openVisit(pid, v.visitId, true),
        });
      }
    }
  }
  appts.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const apptDateLabel = fmtDate(apptDate);

  const allPatients = db.order.map((pid) => {
    const p = db.patients[pid];
    const sorted = p.visits.slice().sort((a, b) => (a.no || 0) - (b.no || 0));
    let bal = 0;
    let totalP = 0;
    sorted.forEach((v) => {
      bal += num(v.clinical && v.clinical.treatmentCost) - num(v.clinical && v.clinical.amountPaid);
      totalP += num(v.clinical && v.clinical.amountPaid);
      if (bal < 0) bal = 0;
    });
    const lastVisit = sorted.length > 0 ? sorted[sorted.length - 1] : null;
    const lastTs = p.visits.reduce((mx, v) => {
      const t = Date.parse(v.createdAt) || 0;
      return t > mx ? t : mx;
    }, 0);
    let st;
    if (bal > 0 && totalP > 0) st = 'Partially paid';
    else if (bal > 0) st = 'Not paid';
    else st = 'Fully Paid';
    return {
      patientId: pid, name: p.name, age: p.age, gender: p.gender, mobile: p.mobile,
      ageGender: (p.age || '?') + '/' + (p.gender || '—'),
      lastDate: lastVisit ? lastVisit.date : '',
      lastLabel: lastVisit ? fmtDate(lastVisit.date) : '—',
      lastTimestamp: lastTs,
      visitCount: p.visits.length,
      outstanding: bal, status: st,
    };
  });
  const outstandingTotal = allPatients.reduce((s, p) => s + p.outstanding, 0);

  const allOnMobile = findAllByMobile(db, form.mobile);
  const matchedPatient = addAnother ? null : allOnMobile.find((p) => p.name.toLowerCase() === form.name.trim().toLowerCase());
  const previewPatientId = matchedPatient ? matchedPatient.patientId : 'P' + String(db.seq + 1).padStart(4, '0');
  const nextVisitNo = matchedPatient ? matchedPatient.visits.length + 1 : 1;
  const previewVisitId = previewPatientId + '_' + nextVisitNo;

  const intakeSearchQ = intakeSearch.trim().toLowerCase();
  const intakeResults = [];
  if (intakeSearchQ) {
    for (const pid of db.order) {
      if (intakeResults.length >= 20) break;
      const p = db.patients[pid];
      if ((p.name + ' ' + p.mobile + ' ' + pid).toLowerCase().includes(intakeSearchQ)) {
        const sorted = p.visits.slice().sort((a, b) => (a.no || 0) - (b.no || 0));
        const lastVisit = sorted.length > 0 ? sorted[sorted.length - 1] : null;
        intakeResults.push({
          patientId: pid, name: p.name, mobile: p.mobile,
          ageGender: (p.age || '?') + ' · ' + (p.gender || '—'),
          initial: (p.name || '?')[0].toUpperCase(),
          lastLabel: lastVisit ? fmtDate(lastVisit.date) : '—',
          nextVisitNo: p.visits.length + 1,
          open: () => startVisitForExisting(pid),
        });
      }
    }
  }

  const curP = db.patients[curPatientId];
  const curV = curP && curP.visits.find((x) => x.visitId === curVisitId);
  const cur = {
    name: curP ? curP.name : '', patientId: curPatientId, visitId: curVisitId,
    mobile: curP ? curP.mobile : '', ageGender: curP ? (curP.age || '?') + ' yrs · ' + (curP.gender || '—') : '',
    dateLabel: curV ? fmtDate(curV.date) : '',
  };
  const history = [];
  const pendingList = [];
  let pendingTotal = 0;
  if (curP) {
    const sorted = curP.visits.slice().sort((a, b) => (a.no || 0) - (b.no || 0));
    let runBal = 0;
    let lastReset = -1;
    sorted.forEach((v, i) => {
      const isCur = v.visitId === curVisitId;
      const cost = isCur ? num(cform.treatmentCost) : num(v.clinical && v.clinical.treatmentCost);
      const paid = isCur ? num(cform.amountPaid) : num(v.clinical && v.clinical.amountPaid);
      runBal += cost - paid;
      if (runBal < 0) { runBal = 0; lastReset = i; }
    });
    pendingTotal = runBal;
    const rawPending = [];
    sorted.forEach((v, i) => {
      const isCur = v.visitId === curVisitId;
      const cost = isCur ? num(cform.treatmentCost) : num(v.clinical && v.clinical.treatmentCost);
      const paid = isCur ? num(cform.amountPaid) : num(v.clinical && v.clinical.amountPaid);
      const visitOwes = cost - paid;
      const rawTrH = v.clinical ? (Array.isArray(v.clinical.treatment) ? v.clinical.treatment : (v.clinical.treatment ? [v.clinical.treatment] : [])) : [];
      const hasOtherH = rawTrH.some(t => /Other/.test(t));
      const trrH = hasOtherH && v.clinical && v.clinical.treatmentOther ? [...rawTrH.filter(t => !/Other/.test(t)), v.clinical.treatmentOther].join(', ') : rawTrH.join(', ');
      if (i > lastReset && visitOwes > 0) {
        rawPending.push({ visitId: v.visitId, dateLabel: fmtDate(v.date), rawAmount: visitOwes, current: isCur });
      }
      const bal = num(v.clinical && v.clinical.balanceDue);
      history.push({
        visitId: v.visitId, dateLabel: fmtDate(v.date), treatmentLabel: trrH || '—',
        cost: cost ? inr(cost) : '—', balance: bal ? inr(bal) : '—',
        status: (v.clinical && v.clinical.paymentStatus) || '—', current: isCur, rowBg: isCur ? '#eef7f6' : '#fff',
      });
    });
    let credit = rawPending.reduce((s, p) => s + p.rawAmount, 0) - pendingTotal;
    for (const p of rawPending) {
      if (credit <= 0) break;
      const absorb = Math.min(credit, p.rawAmount);
      p.rawAmount -= absorb;
      credit -= absorb;
    }
    for (const p of rawPending) {
      if (p.rawAmount > 0) {
        pendingList.push({ visitId: p.visitId, dateLabel: p.dateLabel, amount: inr(p.rawAmount), current: p.current });
      }
    }
  }
  cur.history = history;
  let prevPending = 0;
  if (curP) {
    const prevSorted = curP.visits.filter((v) => v.visitId !== curVisitId).slice().sort((a, b) => (a.no || 0) - (b.no || 0));
    prevSorted.forEach((v) => {
      prevPending += num(v.clinical && v.clinical.treatmentCost) - num(v.clinical && v.clinical.amountPaid);
      if (prevPending < 0) prevPending = 0;
    });
  }
  const computedBalance = num(cform.treatmentCost) + prevPending - num(cform.amountPaid);

  // Appointment count for the selected next date in clinical form
  let apptCount = 0;
  if (cform.nextAppointment) {
    for (const pid of db.order) {
      for (const v of db.patients[pid].visits) {
        if (v.visitId === curVisitId) continue;
        if (v.clinical && v.clinical.nextAppointment === cform.nextAppointment) apptCount++;
      }
    }
  }
  const apptCountText = apptCount === 0
    ? 'No other appointments booked on this day.'
    : apptCount === 1
      ? '1 appointment already booked on this day.'
      : apptCount + ' appointments already booked on this day.';

  return (
    <WaProvider org={org} orgLoaded={orgLoaded}>
    <div style={{ minHeight: '100vh' }}>
      <Header view={view} onGoDash={goDash} onGoAppts={goAppts} onGoPatients={goPatients} onGoMessages={goMessages} user={user} onLogout={onLogout} />
      <main style={{ maxWidth: 1180, margin: '0 auto', padding: '26px 22px 60px' }}>
        {loadError && (
          <p style={{ color: '#c0392b', fontSize: 13, fontWeight: 600, marginBottom: 12 }}>{loadError}</p>
        )}

        {view === 'dashboard' && (
          <Dashboard
            dateFrom={dateFrom} dateTo={dateTo}
            onSetRange={(from, to) => { setDateFrom(from); setDateTo(to); }}
            onRefresh={() => loadList(true)} refreshing={refreshing}
            stats={stats} q={q} onSetQ={setQ}
            visitRows={visitRows} hasVisits={visitRows.length > 0} noVisits={rows.length === 0}
          />
        )}

        {view === 'appointments' && (
          <AppointmentsSwitch
            onOpenVisit={(pid, visitId) => openVisit(pid, visitId, true)}
            legacy={{
              appts, hasAppts: appts.length > 0, noAppts: appts.length === 0,
              apptDate, onSetApptDate: setApptDate,
              onApptToday: () => setApptDate(today()), apptDateLabel,
              apptDatesMap,
              showCal: showApptCal, onSetShowCal: setShowApptCal,
            }}
          />
        )}

        {view === 'messages' && <Messages />}

        {view === 'patients' && (
          <Patients
            allPatients={allPatients} outstandingTotal={outstandingTotal}
            onOpenPatient={openPatientDetail}
          />
        )}

        {view === 'patientDetail' && detailPid && db.patients[detailPid] && (
          <PatientDetail
            patient={db.patients[detailPid]} patientId={detailPid}
            onGoBack={goBack} onRenamePatient={onRenamePatient}
            clinicName={org?.clinicName} clinicAddress={org ? [org.clinicAddress, ...(org.contactNumbers || []).map(n => '+91 ' + n)].filter(Boolean).join(' · ') : ''}
            doctorName={org?.doctorName} doctorQualification={org?.doctorQualification}
            rxTemplateUrl={rxTemplateUrl}
            hasDocxTemplate={!!org?.rxTemplateKey?.endsWith('.docx')}
            hasReceiptTemplate={!!org?.receiptTemplateKey?.endsWith('.docx')}
          />
        )}

        {view === 'intake' && (
          <Intake
            form={form} onSetField={(k, v) => setForm((f) => ({ ...f, [k]: v }))}
            onLookup={onLookup} lookupState={lookupState} existingPatientId={existingPatientId} nextVisitNo={nextVisitNo}
            previewPatientId={previewPatientId} previewVisitId={previewVisitId}
            mobilePatients={mobilePatients} addAnother={addAnother}
            onSelectPatient={onSelectPatient} onAddAnother={onAddAnother} onCancelAddAnother={onCancelAddAnother}
            intakeError={intakeError} onGoBack={goBack} onSaveIntake={onSaveIntake} saving={savingIntake}
            intakeMode={intakeMode} onSetIntakeMode={setIntakeMode}
            intakeSearch={intakeSearch} onSetIntakeSearch={setIntakeSearch}
            intakeResults={intakeResults} hasIntakeResults={intakeResults.length > 0}
            showIntakeEmpty={!!intakeSearchQ && intakeResults.length === 0}
          />
        )}

        {view === 'clinical' && curP && (
          <Clinical
            cur={cur} hasHistory={history.length > 0}
            cform={cform} onSetField={(k, v) => setCform((f) => ({ ...f, [k]: v }))}
            prevPending={prevPending} prevPendingLabel={inr(prevPending)}
            amountToCollect={num(cform.treatmentCost) + prevPending}
            amountToCollectLabel={inr(num(cform.treatmentCost) + prevPending)}
            computedBalance={computedBalance}
            computedBalanceLabel={inr(computedBalance)}
            balanceColor={computedBalance > 0 ? '#c0392b' : '#12805a'}
            hasPending={pendingList.length > 0} noPending={pendingList.length === 0}
            pendingTotalLabel={inr(pendingTotal)} pendingList={pendingList}
            hasQr={!!db.upiQr} noQr={!db.upiQr} qrUrl={db.upiQr}
            qrUploadLabel={db.upiQr ? 'Replace scanner' : 'Upload scanner'} onUploadQr={onUploadQr}
            showQr={showQr} onOpenQr={() => setShowQr(true)} onCloseQr={() => setShowQr(false)}
            savedFlash={savedFlash} onGoBack={goBack} onSaveClinical={onSaveClinical} onSaveAndNext={onSaveAndNext} saving={savingClinical}
            error={clinicalError}
            apptCountText={apptCountText} showApptCount={!!cform.nextAppointment}
            db={db} curPatientId={curPatientId}
            labNames={db.labNames || []}
            readOnly={clinicalReadOnly}
            onCreateNewVisit={() => onCreateNewVisitFromAppt(curPatientId)}
            clinicName={org?.clinicName} clinicAddress={org ? [org.clinicAddress, ...(org.contactNumbers || []).map(n => '+91 ' + n)].filter(Boolean).join(' · ') : ''}
            doctorName={org?.doctorName} doctorQualification={org?.doctorQualification}
            rxTemplateUrl={rxTemplateUrl}
            hasDocxTemplate={!!org?.rxTemplateKey?.endsWith('.docx')}
            hasReceiptTemplate={!!org?.receiptTemplateKey?.endsWith('.docx')}
            onPaymentSaved={() => loadList(true)}
          />
        )}
      </main>

      <NewVisitFab view={view} showApptCal={showApptCal} onClick={goIntake} />

      {(savingIntake || savingClinical) && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 100,
          background: 'rgba(238,244,243,.88)', backdropFilter: 'blur(2px)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 16,
        }}>
          <div style={{
            width: 44, height: 44, border: '3.5px solid #d6e7e3',
            borderTopColor: '#12a094', borderRadius: '50%',
            animation: 'spin .7s linear infinite',
          }} />
          <span style={{ fontSize: 15, color: '#5c7a76', fontWeight: 600 }}>
            Loading, please wait...
          </span>
        </div>
      )}
    </div>
    </WaProvider>
  );
}
