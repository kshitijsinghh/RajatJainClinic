import { useEffect, useState, useCallback, useRef } from 'react';
import { fetchList, fetchPatientSnapshot, portalCheckin, savePatientProblem, getDocumentUrl, fetchOrg, generatePrescriptionPdf, generateReceiptPdf } from './api';
import { signInWithFirebaseToken, signInWithGooglePatientToken, requestPortalOtp, signInWithPortalOtp, hasLiveToken, clearSession as clearPortalSession } from './auth';
import { getFirebaseAuth, RecaptchaVerifier, signInWithPhoneNumber, signOut as firebaseSignOut } from './firebase';

/* ─── helpers ─── */
async function renderUrlToPdf(url) {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);
  const res = await fetch(url);
  const htmlText = await res.text();
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;background:#fff;z-index:-1;';
  const bodyMatch = htmlText.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const styleMatch = htmlText.match(/<style>([\s\S]*?)<\/style>/g);
  let inner = bodyMatch ? bodyMatch[1] : htmlText;
  inner = inner.replace(/<script[\s\S]*?<\/script>/gi, '');
  inner = inner.replace(/<div id="print-btn"[\s\S]*?<\/div>/i, '');
  if (styleMatch) wrapper.innerHTML = styleMatch.join('') + inner;
  else wrapper.innerHTML = inner;
  document.body.appendChild(wrapper);
  await new Promise(r => setTimeout(r, 300));
  const canvas = await html2canvas(wrapper, { scale: 2, useCORS: true, logging: false });
  document.body.removeChild(wrapper);
  const pdf = new jsPDF('p', 'mm', 'a4');
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const imgW = pageW - 10;
  const imgH = (canvas.height * imgW) / canvas.width;
  let y = 0;
  while (y < imgH) {
    if (y > 0) pdf.addPage();
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 5, -y + 5, imgW, imgH);
    y += pageH - 10;
  }
  return pdf;
}

async function downloadAsPdf(url, filename) {
  try {
    const pdf = await renderUrlToPdf(url);
    pdf.save(filename);
  } catch (e) {
    // Never fail silently — a dead-looking button is worse than a fallback.
    console.error('PDF download failed:', e);
    window.open(url, '_blank');
    alert('Could not build the PDF automatically, so the document was opened in a new tab.\nUse your browser\u2019s Print \u2192 "Save as PDF" from there.');
  }
}

// Print via a real PDF (MFP printers reliably print PDFs, not browser HTML jobs).
async function printAsPdf(url) {
  const win = window.open('', '_blank');
  try {
    const pdf = await renderUrlToPdf(url);
    pdf.autoPrint();
    const blobUrl = pdf.output('bloburl');
    if (win) win.location.href = blobUrl;
    else window.open(blobUrl, '_blank');
  } catch (e) {
    if (win) { try { win.close(); } catch (_) {} }
    window.open(url + '#print', '_blank');
  }
}

// Capture an already-rendered on-screen element to a PDF (inline HTML rx/receipt).
async function downloadElementAsPdf(elementId, filename) {
  const el = document.getElementById(elementId);
  if (!el) { window.print(); return; }
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);
  const canvas = await html2canvas(el, { scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff' });
  const pdf = new jsPDF('p', 'mm', 'a4');
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const imgW = pageW - 10;
  const imgH = (canvas.height * imgW) / canvas.width;
  let y = 0;
  while (y < imgH) {
    if (y > 0) pdf.addPage();
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 5, -y + 5, imgW, imgH);
    y += pageH - 10;
  }
  pdf.save(filename);
}

function localToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function normMobile(m) { return (m || '').replace(/\D/g, ''); }
function num(x) { const n = parseFloat(x); return isNaN(n) ? 0 : n; }
function inr(n) { return '₹' + Math.round(n).toLocaleString('en-IN'); }
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return d; }
}
function fmtTime(t) {
  if (!t) return '';
  if (/AM|PM/i.test(t)) return t;
  const [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + ' ' + ap;
}
function dateParts(d) {
  if (!d) return { day: '', mon: '', yr: '' };
  try {
    const dt = new Date(d + 'T00:00:00');
    return {
      day: String(dt.getDate()),
      mon: dt.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase(),
      yr: String(dt.getFullYear()),
    };
  } catch { return { day: '', mon: '', yr: '' }; }
}
function findAllByMobile(db, mobile) {
  const mm = normMobile(mobile);
  if (!mm || !db) return [];
  return db.order.map(id => db.patients[id]).filter(p => p.mobile === mm);
}
function treatmentLabel(c) {
  if (!c) return '—';
  return (/Other/.test(c.treatment || '') && c.treatmentOther) ? c.treatmentOther : (c.treatment || '—');
}

function asList(x) { return Array.isArray(x) ? x : (x ? [x] : []); }
function listLabel(x, fallback) { const a = asList(x); return a.length ? a.join(', ') : (fallback || ''); }
function trLabel(c) {
  if (!c) return '';
  return asList(c.treatment).map(t => (/Other/.test(t) && c.treatmentOther) ? c.treatmentOther : t).join(', ');
}
function medDoseText(m) {
  const parts = [];
  if (m.morning) parts.push('1 Morning');
  if (m.afternoon) parts.push('1 Afternoon');
  if (m.evening) parts.push('1 Evening');
  if (m.night) parts.push('1 Night');
  return parts.length ? parts.join(', ') : '—';
}
function medTotal(m) {
  const per = (m.morning ? 1 : 0) + (m.afternoon ? 1 : 0) + (m.evening ? 1 : 0) + (m.night ? 1 : 0);
  const d = parseFloat(m.duration);
  if (!per || isNaN(d) || d <= 0) return '';
  return '(Tot: ' + (per * d) + ' ' + (m.unit || '') + ')';
}
function splitLabel(sp) { return sp.category === 'Custom' ? (sp.custom || 'Custom') : sp.category; }

// Show the doctor what actually failed. Apps Script returns readable messages
// ("Visit not found: P0027_1", "Service invoked too many times"), and a real
// message is something they can report; "Something went wrong" is not.
function errText(err, fallback) {
  const m = String((err && err.message) || '').trim();
  if (!m) return fallback;
  return m.length > 160 ? m.slice(0, 160) + '…' : m;
}
function buildRx(cf, meta, clinicName) {
  return {
    dateLabel: meta.dateLabel, name: meta.name, ageGender: meta.ageGender, mobile: meta.mobile,
    patientId: meta.patientId, visitId: meta.visitId,
    // Empty fields stay '' so the prescription omits them entirely.
    medicalHistory: cf.medicalHistory || '',
    chiefComplaint: listLabel(cf.chiefComplaint, ''),
    description: cf.chiefDescription || '',
    treatmentGroup: listLabel(cf.treatmentGroup, ''),
    treatment: trLabel(cf) || '',
    advisedTreatment: listLabel(cf.advisedTreatment, ''),
    toothNumber: listLabel(cf.toothNumber, ''),
    meds: (cf.medicines || []).filter(m => m.name).map((m, i) => ({
      sn: i + 1, name: m.name, unit: m.unit, dose: medDoseText(m),
      food: m.food, duration: m.duration ? (m.duration + ' days') : '—', total: medTotal(m),
    })),
    hasMeds: (cf.medicines || []).some(m => m.name),
    noMeds: !(cf.medicines || []).some(m => m.name),
    clinicName: clinicName || 'PatientPad',
  };
}
function buildReceipt(cf, meta) {
  const splits = (cf.paySplits || []).filter(sp => splitLabel(sp) && num(sp.amount) > 0);
  let lines = [];
  if (splits.length) lines = splits.map(sp => ({ label: splitLabel(sp), amount: num(sp.amount) }));
  else {
    const fb = trLabel(cf) || listLabel(cf.treatmentGroup, '');
    if (fb) lines = [{ label: fb, amount: num(cf.amountPaid) }];
  }
  const total = lines.reduce((s, l) => s + l.amount, 0);
  const bal = num(cf.balanceDue);
  return {
    lines: lines.map((l, i) => ({ sn: i + 1, label: l.label, amountLabel: inr(l.amount) })),
    totalLabel: inr(total), paidLabel: inr(num(cf.amountPaid)),
    balanceLabel: inr(bal), balanceColor: bal > 0 ? '#c0392b' : '#12805a',
    mode: cf.paymentMode || '—', status: cf.paymentStatus || '—',
    receiptNo: 'R-' + (meta.visitId || ''), dateLabel: meta.dateLabel,
    name: meta.name, mobile: meta.mobile, patientId: meta.patientId,
  };
}
function fileTypeLabel(type) {
  if (/^image\//.test(type || '')) return 'Image';
  if (/pdf/i.test(type || '')) return 'PDF';
  return 'File';
}

function buildVisitData(me, v, myPatientId) {
  const c = v.clinical || {};
  const ageGender = (me.age || '?') + ' yrs / ' + (me.gender || '—');
  return {
    patientName: me.name, age_sex: ageGender, mobile: me.mobile || '',
    date: fmtDate(v.date), visitId: v.visitId,
    chiefComplaint: listLabel(c.chiefComplaint, ''),
    description: c.chiefDescription || '',
    treatmentGroup: listLabel(c.treatmentGroup, ''),
    toothNumber: listLabel(c.toothNumber, ''),
    treatment: trLabel(c) || '', advisedTreatment: listLabel(c.advisedTreatment, ''),
    medicalHistory: c.medicalHistory || '',
    comments: c.comments || '',
    medicines: (c.medicines || []).filter(m => m.name).map(m => ({
      name: m.name, unit: m.unit || '',
      dose: medDoseText(m), food: m.food || '', duration: m.duration ? (m.duration + ' days') : '',
    })),
    treatmentCost: c.treatmentCost || '',
    amountPaid: c.amountPaid || '', balanceDue: c.balanceDue || '',
    paymentMode: c.paymentMode || '', paymentStatus: c.paymentStatus || '',
    paySplits: c.paySplits || [],
  };
}

const SESSION_KEY = 'patient_session';
const GENDERS = ['Male', 'Female', 'Other'];
const CLINIC_NAME = 'PatientPad';

// SMS one-time codes are built, tested and working; they are simply switched
// off. Every clinic's patients are on WhatsApp, which costs the clinic less
// and needs no Twilio account, so offering both only asked patients to make a
// choice that has one sensible answer.
//
// Set VITE_PORTAL_SMS_OTP=true to bring the chooser back. Nothing else has to
// change: requestPortalOtp, the verify path and the Firebase phone flow are
// all left exactly as they are, and with the chooser hidden otpChannel simply
// stays on its 'whatsapp' default.
//
// Exactly the string "true" switches it on. A flag that also accepted "1",
// "yes" or "TRUE" would eventually be set to one of them somewhere and read as
// off, and silently leaving SMS disabled is the failure nobody notices.
export function smsOtpEnabled(env) {
  return String((env && env.VITE_PORTAL_SMS_OTP) || '') === 'true';
}

const SMS_OTP_ENABLED = smsOtpEnabled(import.meta.env);

// Extracted so the hidden case can be rendered on its own in a test: the
// sign-in screen itself sits behind `loading`, which never clears without a
// browser, so it cannot be reached by renderToString.
export function OtpChannelChooser({ enabled, value, onChange }) {
  if (!enabled) return null;
  return (
    <>
      <label style={{ display: 'block', fontWeight: 700, fontSize: '13.5px', marginBottom: 7, color: '#0e3b39' }}>Where should we send your code?</label>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {[['whatsapp', 'WhatsApp'], ['sms', 'SMS']].map(([val, label]) => (
          <button
            key={val}
            type="button"
            onClick={() => onChange(val)}
            style={{
              flex: 1, padding: '11px 10px', borderRadius: 11, cursor: 'pointer',
              fontWeight: 700, fontSize: '14px',
              border: value === val ? '1.5px solid #0e756c' : '1px solid #d6e7e3',
              background: value === val ? '#e6f4f2' : '#f7fbfa',
              color: value === val ? '#0e756c' : '#5c7a76',
            }}
          >{label}</button>
        ))}
      </div>
    </>
  );
}

/* ─── tiny SVGs used across the portal ─── */
const ClipboardIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="4" width="14" height="17" rx="2.5"/><path d="M9 4a3 3 0 0 1 6 0"/><path d="M9 12h6M9 16h4"/></svg>
);
const QrIcon = () => (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3M20 14v.01M14 20h.01M20 20v-3"/></svg>
);
const BackArrow = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>
);
const RefreshIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5"/></svg>
);
const CheckIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
);
const EditIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
);
const PlusIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
);
const HomeIcon = () => (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/></svg>
);
const HistoryIcon = () => (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8v4l3 2"/><path d="M3.05 11a9 9 0 1 1 .5 4"/><path d="M3 21v-6h6"/></svg>
);
const FamilyIcon = () => (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M15.5 11a3 3 0 1 0-1.6-5.5"/><path d="M3 19v-1.4A3.6 3.6 0 0 1 6.6 14h4.8a3.6 3.6 0 0 1 3.6 3.6V19M17 14h.6a3.4 3.4 0 0 1 3.4 3.4V19"/></svg>
);
const CalIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#0e756c" strokeWidth="1.9" strokeLinecap="round" style={{ flexShrink: 0 }}><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/></svg>
);
const PeopleAddIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19"/><circle cx="10" cy="8" r="3.2"/><path d="M18 11h4M20 9v4"/></svg>
);

const GoogleLogo = () => (
  <svg width="19" height="19" viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/><path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/><path fill="#FBBC05" d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/><path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/></svg>
);
const PhoneIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="1" width="14" height="22" rx="3"/><path d="M12 18h.01"/></svg>
);
const RxIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5M9 13h6M9 17h4"/></svg>
);
const ReceiptIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2z"/><path d="M9 8h6M9 12h6"/></svg>
);
const FolderIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>
);
const EyeIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>
);
const DocFileIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8aa8a3" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/></svg>
);
const ChevronRight = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#98b0ab" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M9 6l6 6-6 6"/></svg>
);
const BigCheckIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
);

/* ═══════════════════════════════════════════
   PortalApp — Patient Portal (all in one)
   ═══════════════════════════════════════════ */
const PORTAL_ENABLED = (import.meta.env.VITE_PORTAL_ENABLED || 'true').toLowerCase() !== 'false';

export default function PortalApp() {
  if (!PORTAL_ENABLED) {
    return (
      <div style={{
        minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#eef4f3', fontFamily: "'Hanken Grotesk', sans-serif", padding: 24,
      }}>
        <div style={{
          background: '#fff', borderRadius: 18, padding: '48px 32px', maxWidth: 380,
          width: '100%', textAlign: 'center', boxShadow: '0 2px 16px rgba(14,59,57,.08)',
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🏥</div>
          <h2 style={{
            fontFamily: "'Bricolage Grotesque', sans-serif", color: '#0e3b39',
            fontSize: 22, fontWeight: 700, margin: '0 0 8px',
          }}>Portal Unavailable</h2>
          <p style={{ color: '#5f7a78', fontSize: 15, lineHeight: 1.5, margin: 0 }}>
            The patient portal is currently not available for this clinic.
            Please contact the clinic directly for assistance.
          </p>
        </div>
      </div>
    );
  }

  /* ── data ── */
  const [db, setDb] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  /* ── org config (template keys) ── */
  const [org, setOrg] = useState(null);

  /* ── auth ── */
  const [authedMobile, setAuthedMobile] = useState('');
  const [authedEmail, setAuthedEmail] = useState('');
  const [authChecking, setAuthChecking] = useState(false);
  const [authError, setAuthError] = useState('');

  /* ── OTP state ── */
  const [loginMobile, setLoginMobile] = useState('');
  const [otpStep, setOtpStep] = useState(false);
  const [otpDigits, setOtpDigits] = useState(['', '', '', '', '', '']);
  const [sendingOtp, setSendingOtp] = useState(false);
  // WhatsApp is the default: it costs the clinic less than an SMS and the
  // patient almost certainly has it open already. SMS stays as the fallback
  // for a number with no WhatsApp account.
  const [otpChannel, setOtpChannel] = useState('whatsapp');
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [resendTimer, setResendTimer] = useState(0);
  const otpRefs = useRef([]);
  const confirmationRef = useRef(null);
  const recaptchaRef = useRef(null);

  /* ── navigation: login | register | home | records | family ── */
  const [view, setView] = useState('login');

  /* ── active patient ── */
  const [myPatientId, setMyPatientId] = useState('');

  /* ── registration form ── */
  const [reg, setReg] = useState({ mobile: '', name: '', age: '', gender: '', address: '', email: '' });
  const [regError, setRegError] = useState('');
  const [regPickedId, setRegPickedId] = useState('');
  const [regAddingMember, setRegAddingMember] = useState(false);
  const [isAddingForFamily, setIsAddingForFamily] = useState(false);
  const [savingReg, setSavingReg] = useState(false);

  /* ── problem form ── */
  const [problemDraft, setProblemDraft] = useState('');
  const [problemSaved, setProblemSaved] = useState(false);
  const [editingProblem, setEditingProblem] = useState(false);
  const [savingProblem, setSavingProblem] = useState(false);

  /* ── detail sheet ── */
  const [detailVisitId, setDetailVisitId] = useState('');

  /* ── member sheet ── */
  const [memberSheet, setMemberSheet] = useState(false);

  /* ── confirm-who sheet ── */
  const [confirmWho, setConfirmWho] = useState(false);

  /* ── document sheets + files popup ── */
  const [viewDoc, setViewDoc] = useState(null);
  const [filesVisit, setFilesVisit] = useState(null);

  /* ── DOCX template doc viewing ── */
  const [docxLoading, setDocxLoading] = useState(false);
  const [docxContent, setDocxContent] = useState(null);

  const hasDocxRxTemplate = !!(org?.rxTemplateKey?.endsWith('.docx'));
  const hasDocxReceiptTemplate = !!(org?.receiptTemplateKey?.endsWith('.docx'));

  /* ─── helpers for state ─── */
  function applySnapshot(res) {
    setDb({ patients: res.patients, order: res.order, seq: res.seq });
  }

  /* ─── load data ─── */
  const loadList = useCallback(async (isRefresh) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const res = await loadPortalData();
      applySnapshot(res);
      setLoadError('');
      return res;
    } catch (err) {
      setLoadError(errText(err, 'Something went wrong, please try again'));
      return null;
    } finally {
      if (isRefresh) setRefreshing(false); else setLoading(false);
    }
  }, []);

  /* ─── init: restore session, load data ─── */
  // Data is fetched ONLY once a token exists. Fetching first is what broke
  // the portal when the clinic switched authentication on: the scoped read
  // was refused, the unscoped fallback was refused too, and the error screen
  // rendered before the patient ever reached the login form.
  useEffect(() => {
    fetchOrg().then(o => { if (o) setOrg(o); });
    if (!hasLiveToken()) { setLoading(false); return; }
    (async () => {
      const snap = await loadList(false);
      if (snap) restoreFromSession(snap);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadList]);

  /* Route a returning patient whose token is still alive. */
  function restoreFromSession(data) {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (!s) return;

      if (s.mobile) {
        setAuthedMobile(s.mobile);
        const matches = findAllByMobile(data, s.mobile);
        if (matches.length > 0) {
          restorePatient(matches[0].patientId, data);
        } else {
          setView('register');
          setReg(r => ({ ...r, mobile: s.mobile }));
        }
        return;
      }

      if (s.email) {
        setAuthedEmail(s.email);
        const found = data.order.find(id => (data.patients[id].email || '').toLowerCase() === s.email.toLowerCase());
        if (found) {
          restorePatient(found, data);
        } else {
          setView('register');
        }
      }
    } catch { /* ignore */ }
  }

  function restorePatient(pid, data) {
    setMyPatientId(pid);
    setView('home');
    const p = (data || db).patients[pid];
    if (p) {
      const t = localToday();
      const openV = p.visits.filter(v => !v.done && v.date === t).sort((a, b) => (b.no || 0) - (a.no || 0))[0];
      if (openV && openV.clinical && openV.clinical.patientProblem) {
        setProblemDraft(openV.clinical.patientProblem);
        setProblemSaved(true);
      }
    }
  }

  /* ─── Google SSO auth ─── */
  function getClientId() {
    return import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
  }

  function handleGoogleSignIn() {
    const clientId = getClientId();
    if (!clientId) { setAuthError('Google Client ID not configured.'); return; }
    const redirectUri = window.location.origin + window.location.pathname;
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'token',
        scope: 'email profile',
        prompt: 'select_account',
      }).toString();
    window.location.href = authUrl;
  }

  async function onGoogleAuthComplete(userEmail) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ email: userEmail })); } catch { /* */ }
    setAuthedEmail(userEmail);
    setAuthChecking(false);
    const db = await loadList(false);
    if (!db) { setView('register'); return; }
    const found = db.order.find(id => (db.patients[id].email || '').toLowerCase() === userEmail.toLowerCase());
    if (found) {
      setMyPatientId(found);
      setView('home');
      const p = db.patients[found];
      const t = localToday();
      const openV = p.visits.filter(v => !v.done && v.date === t).sort((a, b) => (b.no || 0) - (a.no || 0))[0];
      if (openV && openV.clinical && openV.clinical.patientProblem) {
        setProblemDraft(openV.clinical.patientProblem);
        setProblemSaved(true);
      } else {
        setProblemDraft('');
        setProblemSaved(false);
      }
    } else {
      setMyPatientId('');
      setView('register');
      setReg({ mobile: '', name: '', age: '', gender: '', address: '', email: '' });
      setRegError('');
      setRegPickedId('');
      setRegAddingMember(false);
      setIsAddingForFamily(false);
    }
  }

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || !hash.includes('access_token')) return;
    setAuthChecking(true);
    const params = new URLSearchParams(hash.substring(1));
    const accessToken = params.get('access_token');
    window.history.replaceState(null, '', window.location.pathname);
    if (!accessToken) { setAuthChecking(false); return; }

    fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken },
    })
      .then(r => r.json())
      .then(async info => {
        const userEmail = (info.email || '').toLowerCase();
        if (!userEmail) {
          setAuthError('Could not get your email from Google.');
          setAuthChecking(false);
          return;
        }
        // Exchange Google's proof for a PatientPad token scoped to this
        // email, so the clinic server returns this patient's records only.
        try { await signInWithGooglePatientToken(accessToken); }
        catch { /* a clinic still running with authMode off needs no token */ }
        await onGoogleAuthComplete(userEmail);
      })
      .catch(() => { setAuthError('Something went wrong, please try again.'); setAuthChecking(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ─── OTP auth actions ─── */
  function startResendTimer() {
    setResendTimer(30);
    const iv = setInterval(() => {
      setResendTimer(t => {
        if (t <= 1) { clearInterval(iv); return 0; }
        return t - 1;
      });
    }, 1000);
  }

  function setupRecaptcha() {
    if (recaptchaRef.current) return recaptchaRef.current;
    recaptchaRef.current = new RecaptchaVerifier(getFirebaseAuth(), 'recaptcha-container', { size: 'invisible' });
    return recaptchaRef.current;
  }

  function clearRecaptcha() {
    if (recaptchaRef.current) {
      try { recaptchaRef.current.clear(); } catch {}
      recaptchaRef.current = null;
    }
  }

  async function handleSendOtp() {
    const m = normMobile(loginMobile);
    if (!m || m.length !== 10) { setAuthError('Please enter a valid 10-digit mobile number.'); return; }
    setAuthError('');
    setSendingOtp(true);

    if (otpChannel === 'whatsapp') {
      try {
        await requestPortalOtp(m);
        setOtpStep(true);
        setOtpDigits(['', '', '', '', '', '']);
        startResendTimer();
      } catch (err) {
        // The server's message is already patient-facing — it says whether
        // this is a rate limit or a delivery failure, and never whether the
        // number belongs to a patient here.
        // Not "try SMS instead" when SMS is switched off — pointing a patient
        // at a button that is not on their screen reads as a broken app.
        setAuthError(errText(err, SMS_OTP_ENABLED
          ? 'Could not send the code on WhatsApp. Try SMS instead.'
          : 'Could not send the code on WhatsApp. Please try again, or continue with Google below.'));
      } finally {
        setSendingOtp(false);
      }
      return;
    }

    try {
      clearRecaptcha();
      const verifier = setupRecaptcha();
      const result = await signInWithPhoneNumber(getFirebaseAuth(), '+91' + m, verifier);
      confirmationRef.current = result;
      setOtpStep(true);
      setOtpDigits(['', '', '', '', '', '']);
      startResendTimer();
    } catch (err) {
      clearRecaptcha();
      const code = err?.code || '';
      if (code === 'auth/invalid-phone-number') setAuthError('Invalid phone number format.');
      else if (code === 'auth/too-many-requests') setAuthError('Too many attempts. Please try again later.');
      else setAuthError('Failed to send OTP. Please try again.');
    } finally {
      setSendingOtp(false);
    }
  }

  async function handleResendOtp() {
    if (resendTimer > 0) return;
    setAuthError('');
    setSendingOtp(true);

    if (otpChannel === 'whatsapp') {
      try {
        await requestPortalOtp(normMobile(loginMobile));
        setOtpDigits(['', '', '', '', '', '']);
        startResendTimer();
      } catch (err) {
        setAuthError(errText(err, 'Could not resend the code. Please try again.'));
      } finally {
        setSendingOtp(false);
      }
      return;
    }

    try {
      clearRecaptcha();
      const verifier = setupRecaptcha();
      const result = await signInWithPhoneNumber(getFirebaseAuth(), '+91' + normMobile(loginMobile), verifier);
      confirmationRef.current = result;
      setOtpDigits(['', '', '', '', '', '']);
      startResendTimer();
    } catch {
      clearRecaptcha();
      setAuthError('Failed to resend OTP. Please try again.');
    } finally {
      setSendingOtp(false);
    }
  }

  function handleOtpChange(idx, val) {
    const d = val.replace(/\D/g, '').slice(-1);
    setOtpDigits(prev => {
      const next = [...prev];
      next[idx] = d;
      return next;
    });
    setAuthError('');
    if (d && idx < 5) {
      otpRefs.current[idx + 1]?.focus();
    }
  }

  function handleOtpKeyDown(idx, e) {
    if (e.key === 'Backspace' && !otpDigits[idx] && idx > 0) {
      otpRefs.current[idx - 1]?.focus();
    }
  }

  function handleOtpPaste(e) {
    const pasted = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (!pasted) return;
    e.preventDefault();
    const next = ['', '', '', '', '', ''];
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setOtpDigits(next);
    const focusIdx = Math.min(pasted.length, 5);
    otpRefs.current[focusIdx]?.focus();
  }

  async function handleVerifyOtp() {
    const code = otpDigits.join('');
    if (code.length !== 6) { setAuthError('Please enter the 6-digit code.'); return; }
    const m = normMobile(loginMobile);
    setAuthError('');
    setVerifyingOtp(true);

    if (otpChannel === 'whatsapp') {
      try {
        // The clinic server checks the code and returns the patient token in
        // one step — there is no Firebase credential in this path.
        await signInWithPortalOtp(m, code);
        await onOtpVerified(m);
      } catch (err) {
        setAuthError(errText(err, 'That code is not right, or it has expired.'));
      } finally {
        setVerifyingOtp(false);
      }
      return;
    }

    try {
      if (!confirmationRef.current) { setAuthError('Session expired. Please send OTP again.'); setVerifyingOtp(false); return; }
      const cred = await confirmationRef.current.confirm(code);
      // Firebase has now proven the phone number. Exchange that proof for a
      // PatientPad token scoped to it, so the clinic server returns this
      // patient's records and nothing else.
      try {
        const idToken = await cred.user.getIdToken();
        await signInWithFirebaseToken(idToken);
      } catch {
        // A clinic still running with authMode off needs no token; the read
        // below falls back and behaves exactly as before.
      }
      await onOtpVerified(m);
    } catch (err) {
      const errCode = err?.code || '';
      if (errCode === 'auth/invalid-verification-code') setAuthError('Invalid OTP. Please check and try again.');
      else if (errCode === 'auth/code-expired') setAuthError('OTP has expired. Please resend.');
      else setAuthError('Verification failed. Please try again.');
    } finally {
      setVerifyingOtp(false);
    }
  }

  // Scoped read. The unscoped fallback exists only for a clinic that has not
  // been migrated to authentication yet — there the Lambda issues no token at
  // all and the server has nothing to scope by. Once we DO hold a token, a
  // refusal is a real error and must surface rather than quietly pulling the
  // whole clinic down to the browser.
  async function loadPortalData() {
    try {
      return await fetchPatientSnapshot();
    } catch (err) {
      const refused = err && /requires a token|Not authorised/i.test(String(err.message || ''));
      if (refused && !hasLiveToken()) return await fetchList();
      throw err;
    }
  }

  async function onOtpVerified(mobile) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ mobile })); } catch { /* */ }
    setAuthedMobile(mobile);
    // The scoped snapshot can only be fetched now that a token exists.
    const db = await loadList(false);
    if (!db) { setView('register'); setReg(r => ({ ...r, mobile })); return; }
    const matches = findAllByMobile(db, mobile);
    if (matches.length > 0) {
      const found = matches[0].patientId;
      setMyPatientId(found);
      setView('home');
      const p = db.patients[found];
      const t = localToday();
      const openV = p.visits.filter(v => !v.done && v.date === t).sort((a, b) => (b.no || 0) - (a.no || 0))[0];
      if (openV && openV.clinical && openV.clinical.patientProblem) {
        setProblemDraft(openV.clinical.patientProblem);
        setProblemSaved(true);
      } else {
        setProblemDraft('');
        setProblemSaved(false);
      }
    } else {
      setMyPatientId('');
      setView('register');
      setReg({ mobile, name: '', age: '', gender: '', address: '', email: '' });
      setRegError('');
      setRegPickedId('');
      setRegAddingMember(false);
      setIsAddingForFamily(false);
    }
  }

  function signOut() {
    try { firebaseSignOut(getFirebaseAuth()); } catch {}
    try { clearPortalSession(); } catch {}
    try { localStorage.removeItem(SESSION_KEY); } catch { /* */ }
    clearRecaptcha();
    confirmationRef.current = null;
    setAuthedMobile('');
    setAuthedEmail('');
    setLoginMobile('');
    setOtpStep(false);
    setOtpDigits(['', '', '', '', '', '']);
    setMyPatientId('');
    setView('login');
    setProblemDraft('');
    setProblemSaved(false);
    setEditingProblem(false);
    setDetailVisitId('');
    setMemberSheet(false);
    setConfirmWho(false);
    setAuthError('');
    setAuthChecking(false);
  }

  /* ─── registration ─── */
  function onRegMobileChange(val) {
    const raw = val.replace(/\D/g, '').slice(0, 10);
    setReg(r => ({ ...r, mobile: raw }));
    setRegError('');
    setRegPickedId('');
    setRegAddingMember(false);
  }

  async function saveRegister() {
    const mobile = normMobile(reg.mobile);
    if (!mobile) return setRegError('Please enter your mobile number.');
    if (mobile.length !== 10) return setRegError('Please enter a valid 10-digit mobile number.');

    const existing = findAllByMobile(db, mobile);
    if (existing.length > 0 && !regPickedId && !regAddingMember) {
      return setRegError('Please select who is visiting, or add a new family member.');
    }

    const needsFields = !regPickedId || regAddingMember;
    if (needsFields) {
      if (!reg.name.trim() || !String(reg.age).trim() || !reg.gender) {
        return setRegError('Please fill your name, age and gender.');
      }
    }

    if (regAddingMember) {
      const nameKey = reg.name.trim().toLowerCase();
      const dup = existing.some(p => p.name.trim().toLowerCase() === nameKey);
      if (dup) return setRegError('Someone with this name is already registered on this number. Please use a different name or select them above.');
    }

    setRegError('');
    setSavingReg(true);

    const checkinName = regPickedId && db.patients[regPickedId] ? db.patients[regPickedId].name : reg.name.trim();
    const checkinAge = regPickedId && db.patients[regPickedId] ? db.patients[regPickedId].age : reg.age;
    const checkinGender = regPickedId && db.patients[regPickedId] ? db.patients[regPickedId].gender : reg.gender;
    // Optional, exactly as it is on the clinic console's intake form.
    const checkinAddress = regPickedId && db.patients[regPickedId]
      ? (db.patients[regPickedId].address || '') : (reg.address || '').trim();
    // A Google sign-in has already proved an address, so it wins over anything
    // typed — and the server overrides it to the token's address regardless.
    // The typed field only has an effect after an OTP sign-in, where nothing
    // has been proved and the patient is telling us where to reach them.
    const checkinEmail = authedEmail
      || (regPickedId && db.patients[regPickedId] ? (db.patients[regPickedId].email || '') : (reg.email || '').trim());

    try {
      const res = await portalCheckin({ mobile, name: checkinName, age: checkinAge, gender: checkinGender, address: checkinAddress, email: checkinEmail });
      applySnapshot(res);

      const pid = res.patientId || db.order.find(id => {
        const p = res.patients[id];
        return p.mobile === mobile && p.name.toLowerCase() === checkinName.toLowerCase();
      });

      if (pid && res.patients[pid]) {
        setMyPatientId(pid);
        setView('home');
        setProblemDraft('');
        setProblemSaved(false);
        setEditingProblem(false);
      }
      setReg({ mobile: '', name: '', age: '', gender: '', address: '', email: '' });
      setRegPickedId('');
      setRegAddingMember(false);
      setIsAddingForFamily(false);
    } catch (err) {
      setRegError(errText(err, 'Something went wrong, please try again.'));
    } finally {
      setSavingReg(false);
    }
  }

  /* ─── problem (what's troubling you) ─── */
  async function saveProblem() {
    if (!problemDraft.trim()) return;
    const me = db.patients[myPatientId];
    if (!me) return;
    const t = localToday();
    const openV = me.visits.filter(v => !v.done && v.date === t).sort((a, b) => (b.no || 0) - (a.no || 0))[0];
    if (!openV) return;

    setSavingProblem(true);
    try {
      const res = await savePatientProblem({
        patientId: myPatientId,
        visitId: openV.visitId,
        patientProblem: problemDraft.trim(),
      });
      applySnapshot(res);
      setProblemSaved(true);
      setEditingProblem(false);
    } catch {
      setProblemSaved(true);
      setEditingProblem(false);
    } finally {
      setSavingProblem(false);
    }
  }

  /* ─── navigation ─── */
  function goHome() {
    setView('home');
    setDetailVisitId('');
    setMemberSheet(false);
  }
  function goHistory() {
    setView('records');
    setDetailVisitId('');
  }
  function goFamily() {
    setView('family');
    setDetailVisitId('');
    setMemberSheet(false);
  }
  function goRegisterForFamily() {
    const me = db && db.patients[myPatientId];
    setView('register');
    setIsAddingForFamily(true);
    setRegAddingMember(true);
    setRegPickedId('');
    setRegError('');
    setReg({ mobile: authedMobile || (me ? me.mobile : ''), name: '', age: '', gender: '', address: '' });
    setMemberSheet(false);
  }

  /* ─── check in with confirm-who flow ─── */
  function handleCheckinCta() {
    if (!me || !db) return;
    const onMobile = findAllByMobile(db, me.mobile);
    if (onMobile.length > 1) {
      setConfirmWho(true);
    } else {
      doCheckinForMe();
    }
  }

  function doCheckinForMe() {
    setConfirmWho(false);
    setView('register');
    setIsAddingForFamily(false);
    setRegAddingMember(false);
    setRegPickedId(myPatientId);
    setRegError('');
    setReg({ mobile: authedMobile || me.mobile, name: me.name, age: me.age, gender: me.gender, address: me.address || '' });
  }

  /* ─── switch to another family member ─── */
  function switchToMember(pid) {
    setMyPatientId(pid);
    setView('home');
    setMemberSheet(false);
    setDetailVisitId('');
    const p = db.patients[pid];
    if (p) {
      const t = localToday();
      const openV = p.visits.filter(v => !v.done && v.date === t).sort((a, b) => (b.no || 0) - (a.no || 0))[0];
      if (openV && openV.clinical && openV.clinical.patientProblem) {
        setProblemDraft(openV.clinical.patientProblem);
        setProblemSaved(true);
      } else {
        setProblemDraft('');
        setProblemSaved(false);
      }
      setEditingProblem(false);
    }
  }
  function viewMemberRecords(pid) {
    setMyPatientId(pid);
    setView('records');
    setMemberSheet(false);
    setDetailVisitId('');
  }

  /* ─── refresh queue ─── */
  async function refreshQueue() {
    setRefreshing(true);
    try {
      const res = await loadPortalData();
      applySnapshot(res);
    } catch { /* ignore */ }
    setRefreshing(false);
  }

  /* ─── open DOCX-template prescription/receipt ─── */
  async function openDocxRx(visitId) {
    const v = me.visits.find(x => x.visitId === visitId);
    if (!v) return;
    setDocxLoading(true);
    setDocxContent(null);
    setViewDoc({ visitId, kind: 'rx' });
    try {
      const vd = buildVisitData(me, v, myPatientId);
      const res = await generatePrescriptionPdf(vd);
      if (res.format === 'html' && res.url) {
        setDocxContent({ format: 'html', url: res.url });
      } else if (res.url) {
        setDocxContent({ format: 'docx', url: res.url });
      }
    } catch { /* fall through, viewDoc stays open with standard view */ }
    setDocxLoading(false);
  }

  async function openDocxReceipt(visitId) {
    const v = me.visits.find(x => x.visitId === visitId);
    if (!v) return;
    setDocxLoading(true);
    setDocxContent(null);
    setViewDoc({ visitId, kind: 'receipt' });
    try {
      const vd = buildVisitData(me, v, myPatientId);
      const res = await generateReceiptPdf(vd);
      if (res.format === 'html' && res.url) {
        setDocxContent({ format: 'html', url: res.url });
      } else if (res.url) {
        setDocxContent({ format: 'docx', url: res.url });
      }
    } catch { /* fall through */ }
    setDocxLoading(false);
  }

  function handleOpenRx(visitId) {
    if (hasDocxRxTemplate) {
      openDocxRx(visitId);
    } else {
      setDocxContent(null);
      setViewDoc({ visitId, kind: 'rx' });
    }
  }

  function handleOpenReceipt(visitId) {
    if (hasDocxReceiptTemplate) {
      openDocxReceipt(visitId);
    } else {
      setDocxContent(null);
      setViewDoc({ visitId, kind: 'receipt' });
    }
  }

  /* ═══════════════════════════════════════
     RENDER
     ═══════════════════════════════════════ */

  /* ── loading / error states ── */
  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: '#eef4f3' }}>
        <div style={{ width: 44, height: 44, border: '3.5px solid #d6e7e3', borderTopColor: '#12a094', borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
        <span style={{ fontSize: 15, color: '#5c7a76', fontWeight: 600 }}>Loading, please wait...</span>
      </div>
    );
  }
  if (loadError && !db) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#eef4f3' }}>
        <div style={{ maxWidth: 460, background: '#fff', border: '1px solid #f6d3c8', borderRadius: 16, padding: 24, textAlign: 'center' }}>
          <p style={{ color: '#c0392b', fontWeight: 700, fontSize: 16 }}>Something went wrong, please try again</p>
          <button onClick={() => loadList(false)} style={{ marginTop: 16, padding: '11px 20px', borderRadius: 10, border: 0, background: '#0e3b39', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Retry</button>
        </div>
      </div>
    );
  }

  /* ── derived data ── */
  const signedIn = !!(authedMobile || authedEmail);
  const me = db && myPatientId ? db.patients[myPatientId] : null;
  const today = localToday();

  // Queue info
  let queueNo = null;
  let aheadCount = 0;
  if (me && db) {
    const todayVisit = me.visits.find(v => v.date === today);
    if (todayVisit) {
      const todayPatientIds = [];
      for (const pid of db.order) {
        const p = db.patients[pid];
        if (p.visits.some(v => v.date === today)) {
          todayPatientIds.push(pid);
        }
      }
      if (todayVisit.queueNumber) {
        queueNo = todayVisit.queueNumber;
        for (const pid of db.order) {
          if (pid === myPatientId) continue;
          const p = db.patients[pid];
          const tv = p.visits.find(v => v.date === today && v.queueNumber && v.queueNumber < queueNo);
          if (tv && !tv.done) aheadCount++;
        }
      } else {
        let idx = 1;
        for (const pid of db.order) {
          const p = db.patients[pid];
          if (p.visits.some(v => v.date === today)) {
            if (pid === myPatientId) { queueNo = idx; break; }
            idx++;
          }
        }
        if (queueNo) {
          let qi = 0;
          for (const pid of db.order) {
            const p = db.patients[pid];
            const tv = p.visits.find(v => v.date === today);
            if (tv) {
              qi++;
              if (qi < queueNo && !tv.done && pid !== myPatientId) aheadCount++;
            }
          }
        }
      }
    }
  }

  const aheadText = aheadCount === 0 ? "You're next — please be seated."
    : aheadCount === 1 ? '1 patient ahead of you'
    : aheadCount + ' patients ahead of you';

  // Active visit (today) — find both pending and done
  let activeVisit = null;
  let visitPending = false;
  let visitDone = false;
  let canStartVisit = false;
  if (me) {
    const openToday = me.visits.filter(v => !v.done && v.date === today).sort((a, b) => (b.no || 0) - (a.no || 0))[0];
    const doneToday = me.visits.filter(v => v.done && v.date === today).sort((a, b) => (b.no || 0) - (a.no || 0))[0];
    activeVisit = openToday || doneToday || null;
    visitPending = !!openToday;
    visitDone = !openToday && !!doneToday;
    canStartVisit = !openToday;
  }

  // Active visit doc flags
  const activeC = activeVisit?.clinical || {};
  const activeHasRx = !!(activeVisit?.done && (activeC.medicines || []).some(m => m.name));
  const activeHasReceipt = !!(activeVisit?.done && num(activeC.amountPaid) > 0);
  const activeDocs = activeC.documents || [];
  const activeHasFiles = activeDocs.length > 0;
  const activeHasAnyDoc = activeHasRx || activeHasReceipt || activeHasFiles;

  // Show queue card only when visit is pending (not done)
  const showQueueCard = visitPending && queueNo !== null;
  // Checked-in strip only when pending
  const showCheckedIn = visitPending;
  // Done strip only when done
  const showDoneStrip = visitDone;

  // Upcoming appointments — show when no visit today OR visit is done (hide when pending)
  let upcoming = [];
  if (me && (!activeVisit || visitDone)) {
    for (const v of me.visits) {
      const na = v.clinical && v.clinical.nextAppointment;
      if (na && na >= today) {
        const parts = dateParts(na);
        upcoming.push({
          key: v.visitId + '_appt',
          day: parts.day, mon: parts.mon,
          timeLabel: v.clinical.nextAppointmentTime ? fmtTime(v.clinical.nextAppointmentTime) : 'No time set',
          forLabel: treatmentLabel(v.clinical),
          dateLabel: fmtDate(na),
          isToday: na === today,
        });
      }
    }
    upcoming.sort((a, b) => {
      if (a.dateLabel < b.dateLabel) return -1;
      if (a.dateLabel > b.dateLabel) return 1;
      return 0;
    });
  }

  // Records view — all visits with lifetime stats
  let allVisits = [];
  let totalPaid = 0;
  let totalPending = 0;
  if (me) {
    const sorted = me.visits.slice().sort((a, b) => (a.no || 0) - (b.no || 0));
    let runBal = 0;
    sorted.forEach(v => {
      const cost = num(v.clinical && v.clinical.treatmentCost);
      const paid = num(v.clinical && v.clinical.amountPaid);
      totalPaid += paid;
      runBal += cost - paid;
      if (runBal < 0) runBal = 0;
    });
    totalPending = runBal;

    const payMap = { 'Fully Paid': ['#e3f5ec', '#12805a'], 'Partially paid': ['#fdf0dc', '#a9741a'], 'Not paid': ['#fdecea', '#c0392b'] };
    allVisits = me.visits
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.no || 0) - (a.no || 0)))
      .map(v => {
        const c = v.clinical || {};
        const cols = payMap[c.paymentStatus] || ['#eef4f3', '#8aa8a3'];
        const bal = num(c.balanceDue);
        const docs = (c.documents || []);
        const hasRx = !!(v.done && (c.medicines || []).some(m => m.name));
        const hasReceipt = !!(v.done && num(c.amountPaid) > 0);
        const hasFiles = docs.length > 0;
        return {
          visitId: v.visitId, date: v.date,
          treatmentLbl: treatmentLabel(c) || (v.done ? '—' : 'Awaiting consultation'),
          status: v.done ? (c.paymentStatus || 'Completed') : (v.date === today ? 'In progress' : 'Awaiting doctor'),
          stBg: v.done ? cols[0] : '#fdf0dc', stInk: v.done ? cols[1] : '#a9741a',
          costLabel: v.done ? inr(num(c.treatmentCost)) : '',
          balanceLabel: inr(bal),
          hasBalance: !!v.done && bal > 0,
          showCharges: !!v.done,
          pendingVisit: !v.done,
          done: v.done,
          hasRx, hasReceipt, hasFiles, filesCount: docs.length,
          hasAnyDoc: hasRx || hasReceipt || hasFiles,
        };
      });
  }

  // Family members
  let familyMembers = [];
  if (me && db) {
    const onMobile = findAllByMobile(db, me.mobile);
    familyMembers = onMobile.map(p => {
      const isMe = p.patientId === myPatientId;
      const sorted = p.visits.slice().sort((a, b) => (a.no || 0) - (b.no || 0));
      let bal = 0;
      sorted.forEach(v => {
        bal += num(v.clinical && v.clinical.treatmentCost) - num(v.clinical && v.clinical.amountPaid);
        if (bal < 0) bal = 0;
      });
      const lastV = sorted.length > 0 ? sorted[sorted.length - 1] : null;
      return {
        patientId: p.patientId, name: p.name,
        initial: (p.name || '?').trim().charAt(0).toUpperCase(),
        meta: (p.age || '?') + ' yrs · ' + (p.gender || '—') + ' · ' + p.patientId,
        lastLabel: lastV ? 'Last visit ' + fmtDate(lastV.date) : 'No visits yet',
        isMe,
        hasPending: bal > 0,
        pendingLabel: inr(bal),
      };
    });
  }

  // Registration — matches on entered mobile
  const regMobile = normMobile(reg.mobile);
  const regMatches = regMobile.length === 10 ? findAllByMobile(db, regMobile) : [];
  const hasRegMatches = regMatches.length > 0 && !regAddingMember;
  const showRegFields = regMatches.length === 0 || regAddingMember || !!regPickedId;

  /* ── show bottom tabs when signed in and on home/records/family ── */
  const showTabs = signedIn && me && (view === 'home' || view === 'records' || view === 'family');

  /* ── doc chip renderer (shared between Today done visit and History) ── */
  const DocChips = ({ visitId, hasRx, hasReceipt, hasFiles, filesCount }) => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 11, paddingTop: 11, borderTop: '1px solid #f0f6f5' }}>
      {hasRx && (
        <button onClick={(e) => { e.stopPropagation(); handleOpenRx(visitId); }} style={{ padding: '8px 13px', borderRadius: 9, border: '1px solid #cfe3df', background: '#f2f9f8', color: '#0e756c', fontWeight: 700, fontSize: '12.5px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <RxIcon /> Prescription
        </button>
      )}
      {hasReceipt && (
        <button onClick={(e) => { e.stopPropagation(); handleOpenReceipt(visitId); }} style={{ padding: '8px 13px', borderRadius: 9, border: '1px solid #cfe3df', background: '#f2f9f8', color: '#0e756c', fontWeight: 700, fontSize: '12.5px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ReceiptIcon /> Payment receipt
        </button>
      )}
      {hasFiles && (
        <button onClick={(e) => { e.stopPropagation(); setFilesVisit(visitId); }} style={{ padding: '8px 13px', borderRadius: 9, border: '1px solid #cfe3df', background: '#f2f9f8', color: '#0e756c', fontWeight: 700, fontSize: '12.5px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FolderIcon /> Documents ({filesCount})
        </button>
      )}
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: '100%', maxWidth: 460, minHeight: '100vh', background: '#eef4f3', display: 'flex', flexDirection: 'column' }}>

        {/* ── HEADER ── */}
        <header style={{ background: '#0e3b39', color: '#fff', padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span style={{ width: 34, height: 34, flexShrink: 0, borderRadius: 10, background: 'linear-gradient(135deg,#12a094,#0e756c)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
              <ClipboardIcon />
            </span>
            <span style={{ lineHeight: 1.1, minWidth: 0 }}>
              <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: '15.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{CLINIC_NAME}</span>
              <span style={{ display: 'block', fontSize: '9.5px', letterSpacing: '.16em', textTransform: 'uppercase', color: '#7fd4c9', fontWeight: 600 }}>{org?.clinicName || 'Patient check-in'}</span>
            </span>
          </div>
          {signedIn && (
            <button onClick={signOut} style={{ flexShrink: 0, padding: '7px 12px', borderRadius: 9, border: '1px solid rgba(255,255,255,.3)', background: 'rgba(255,255,255,.1)', color: '#fff', fontWeight: 700, fontSize: '12.5px', cursor: 'pointer' }}>Sign out</button>
          )}
        </header>

        <main style={{ flex: 1, padding: '18px 16px 40px' }}>

          {/* ═══ 1. LOGIN (OTP + Google SSO) ═══ */}
          {view === 'login' && (
            <div>
              <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 20, padding: '28px 22px', textAlign: 'center', marginTop: 12 }}>
                <span style={{ display: 'inline-flex', width: 64, height: 64, borderRadius: 20, background: '#e6f4f2', alignItems: 'center', justifyContent: 'center', color: '#0e756c' }}>
                  {otpStep ? <PhoneIcon /> : <QrIcon />}
                </span>
                <h1 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 23, color: '#0e3b39', marginTop: 16, textWrap: 'balance' }}>
                  {otpStep ? 'Enter verification code' : 'Welcome to the clinic'}
                </h1>
                <p style={{ color: '#5c7a76', fontSize: 15, marginTop: 8, textWrap: 'pretty' }}>
                  {otpStep
                    ? <>We sent a 6-digit code {otpChannel === 'whatsapp' ? 'on WhatsApp' : 'by SMS'} to <strong>+91 {loginMobile}</strong></>
                    : 'Sign in to check in for your visit, get your queue number and see your treatment details.'}
                </p>

                {authChecking ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '18px 0' }}>
                    <div style={{ width: 40, height: 40, border: '3.5px solid #d6e7e3', borderTopColor: '#12a094', borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
                    <span style={{ color: '#5c7a76', fontSize: 14, fontWeight: 600 }}>Signing in...</span>
                  </div>
                ) : !otpStep ? (
                  <div style={{ marginTop: 20 }}>
                    <div style={{ textAlign: 'left' }}>
                      {/* With SMS off there is only one place a code can go,
                          so the question is not worth asking. */}
                      <OtpChannelChooser
                        enabled={SMS_OTP_ENABLED}
                        value={otpChannel}
                        onChange={(val) => { setOtpChannel(val); setAuthError(''); }}
                      />
                      <label style={{ display: 'block', fontWeight: 700, fontSize: '13.5px', marginBottom: 7, color: '#0e3b39' }}>Mobile number</label>
                      <input
                        value={loginMobile}
                        onChange={e => { setLoginMobile(e.target.value.replace(/\D/g, '').slice(0, 10)); setAuthError(''); }}
                        inputMode="numeric"
                        placeholder="10-digit mobile number"
                        style={{ width: '100%', padding: '14px 14px', border: '1px solid #d6e7e3', borderRadius: 11, fontSize: 17, background: '#f7fbfa', textAlign: 'center', letterSpacing: '0.12em', fontWeight: 600 }}
                      />
                      <button onClick={handleSendOtp} disabled={sendingOtp} style={{
                        width: '100%', marginTop: 14, padding: 15, borderRadius: 12, border: 0,
                        background: sendingOtp ? '#8aa8a3' : '#ef5a3c', color: '#fff',
                        fontWeight: 700, fontSize: 16, cursor: sendingOtp ? 'default' : 'pointer',
                      }}>
                        {sendingOtp ? 'Sending code...' : (otpChannel === 'whatsapp' ? 'Send code on WhatsApp' : 'Send code by SMS')}
                      </button>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '20px 0' }}>
                      <div style={{ flex: 1, height: 1, background: '#dbe6e4' }} />
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#98b0ab', letterSpacing: '.08em' }}>OR</span>
                      <div style={{ flex: 1, height: 1, background: '#dbe6e4' }} />
                    </div>

                    <button onClick={handleGoogleSignIn} style={{
                      width: '100%', padding: 14, borderRadius: 12,
                      border: '1px solid #dbe6e4', background: '#fff', color: '#33534f',
                      fontWeight: 700, fontSize: '15.5px', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 11,
                      boxShadow: '0 2px 6px rgba(14,59,57,.07)',
                    }}>
                      <GoogleLogo />
                      Continue with Google
                    </button>
                  </div>
                ) : (
                  <div style={{ marginTop: 20 }}>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }} onPaste={handleOtpPaste}>
                      {otpDigits.map((d, i) => (
                        <input
                          key={i}
                          ref={el => otpRefs.current[i] = el}
                          value={d}
                          onChange={e => handleOtpChange(i, e.target.value)}
                          onKeyDown={e => handleOtpKeyDown(i, e)}
                          inputMode="numeric"
                          maxLength={1}
                          style={{
                            width: 44, height: 52, textAlign: 'center', fontSize: 22, fontWeight: 700,
                            border: d ? '2px solid #12a094' : '1.5px solid #d6e7e3',
                            borderRadius: 11, background: d ? '#eef7f6' : '#f7fbfa', color: '#0e3b39',
                          }}
                        />
                      ))}
                    </div>
                    <button onClick={handleVerifyOtp} disabled={verifyingOtp} style={{
                      width: '100%', marginTop: 18, padding: 15, borderRadius: 12, border: 0,
                      background: verifyingOtp ? '#8aa8a3' : '#ef5a3c', color: '#fff',
                      fontWeight: 700, fontSize: 16, cursor: verifyingOtp ? 'default' : 'pointer',
                    }}>
                      {verifyingOtp ? 'Verifying...' : 'Verify & continue'}
                    </button>
                    <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {resendTimer > 0 ? (
                        <span style={{ color: '#98b0ab', fontSize: 13, fontWeight: 600 }}>Resend in {resendTimer}s</span>
                      ) : (
                        <button onClick={handleResendOtp} disabled={sendingOtp} style={{ border: 0, background: 'none', color: '#0e756c', fontWeight: 700, fontSize: 13, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: '2px' }}>
                          Resend OTP
                        </button>
                      )}
                      <span style={{ color: '#d6e7e3' }}>|</span>
                      <button onClick={() => { setOtpStep(false); setAuthError(''); setOtpDigits(['', '', '', '', '', '']); }} style={{ border: 0, background: 'none', color: '#5c7a76', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                        Change number
                      </button>
                    </div>
                  </div>
                )}

                {authError && <p style={{ color: '#c0392b', fontSize: 13, fontWeight: 600, marginTop: 14 }}>{authError}</p>}
                <p style={{ color: '#98b0ab', fontSize: 12, marginTop: 14 }}>We only use this to identify your records.</p>
              </div>
            </div>
          )}

          {/* ═══ 2. REGISTER ═══ */}
          {view === 'register' && (
            <div>
              {isAddingForFamily && (
                <button onClick={goFamily} style={{ border: 0, background: 'none', color: '#0e756c', fontWeight: 700, fontSize: 14, cursor: 'pointer', padding: 0, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <BackArrow /> Back to family
                </button>
              )}
              <p style={{ color: '#12a094', fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', fontSize: 12 }}>
                {isAddingForFamily ? 'FAMILY' : 'STEP 1'}
              </p>
              <h1 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 24, color: '#0e3b39', marginTop: 4 }}>
                {isAddingForFamily ? 'Add a family member' : 'Check in for your visit'}
              </h1>
              <p style={{ color: '#5c7a76', fontSize: '14.5px', marginTop: 4 }}>
                {isAddingForFamily ? 'Register someone on the same mobile number.' : 'Enter your details to get started.'}
              </p>

              <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, padding: 20, marginTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label style={{ display: 'block', fontWeight: 700, fontSize: '13.5px', marginBottom: 7 }}>Mobile number <span style={{ color: '#ef5a3c' }}>*</span>{authedMobile && <span style={{ color: '#12a094', fontWeight: 600, fontSize: 11.5, marginLeft: 6 }}>verified</span>}</label>
                  <input
                    className="fld" value={reg.mobile} onChange={e => onRegMobileChange(e.target.value)}
                    inputMode="numeric" placeholder="10-digit number"
                    readOnly={!!authedMobile || isAddingForFamily}
                    style={{ width: '100%', padding: '13px 14px', border: '1px solid #d6e7e3', borderRadius: 11, fontSize: 16, background: (authedMobile || isAddingForFamily) ? '#f0f6f5' : '#f7fbfa' }}
                  />
                </div>

                {hasRegMatches && (
                  <div>
                    <p style={{ fontSize: '13.5px', fontWeight: 700, color: '#0e3b39', marginBottom: 4 }}>Who is visiting today?</p>
                    <p style={{ fontSize: '12.5px', color: '#98b0ab', marginBottom: 10 }}>We found existing records on this number.</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {regMatches.map(m => {
                        const selected = regPickedId === m.patientId;
                        return (
                          <button key={m.patientId} onClick={() => {
                            setRegPickedId(m.patientId);
                            setRegAddingMember(false);
                            setRegError('');
                            setReg(r => ({ ...r, name: m.name, age: m.age, gender: m.gender, address: m.address || '' }));
                          }} style={{
                            textAlign: 'left', width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                            padding: 13, border: selected ? '2px solid #12a094' : '1px solid #e2efec',
                            borderRadius: 13, background: selected ? '#eef7f6' : '#fff', cursor: 'pointer',
                          }}>
                            <span style={{ flex: '0 0 auto', width: 38, height: 38, borderRadius: '50%', background: '#e6f4f2', color: '#0e756c', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontFamily: "'Bricolage Grotesque'" }}>
                              {(m.name || '?').charAt(0).toUpperCase()}
                            </span>
                            <span style={{ flex: 1, minWidth: 0, lineHeight: 1.25 }}>
                              <span style={{ display: 'block', fontWeight: 700, color: '#0e3b39', fontSize: 15 }}>{m.name}</span>
                              <span style={{ display: 'block', fontSize: '12.5px', color: '#98b0ab' }}>{(m.age || '?') + ' yrs · ' + (m.gender || '—')}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {regAddingMember && regMatches.length > 0 && (
                  <div style={{ background: '#eef4fb', border: '1px solid #cfe0f0', borderRadius: 12, padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '13.5px', color: '#2f5580' }}>Adding a new family member on this number.</span>
                    <button onClick={() => {
                      if (isAddingForFamily) { goFamily(); return; }
                      setRegAddingMember(false);
                      setRegPickedId('');
                      setRegError('');
                      setReg(r => ({ ...r, name: '', age: '', gender: '', email: '' }));
                    }} style={{ border: '1px solid #cfe0f0', background: '#fff', color: '#3d6fb0', fontWeight: 700, fontSize: '12.5px', borderRadius: 8, padding: '7px 12px', cursor: 'pointer' }}>Cancel</button>
                  </div>
                )}

                {showRegFields && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div>
                      <label style={{ display: 'block', fontWeight: 700, fontSize: '13.5px', marginBottom: 7 }}>Full name <span style={{ color: '#ef5a3c' }}>*</span></label>
                      <input
                        className="fld" value={reg.name} onChange={e => setReg(r => ({ ...r, name: e.target.value }))}
                        placeholder="Your name" readOnly={!!regPickedId}
                        style={{ width: '100%', padding: '13px 14px', border: '1px solid #d6e7e3', borderRadius: 11, fontSize: 16, background: regPickedId ? '#f0f6f5' : '#f7fbfa' }}
                      />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <div>
                        <label style={{ display: 'block', fontWeight: 700, fontSize: '13.5px', marginBottom: 7 }}>Age <span style={{ color: '#ef5a3c' }}>*</span></label>
                        <input
                          className="fld" value={reg.age} onChange={e => setReg(r => ({ ...r, age: e.target.value }))}
                          type="number" min="0" max="120" placeholder="Years" readOnly={!!regPickedId}
                          style={{ width: '100%', padding: '13px 14px', border: '1px solid #d6e7e3', borderRadius: 11, fontSize: 16, background: regPickedId ? '#f0f6f5' : '#f7fbfa' }}
                        />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontWeight: 700, fontSize: '13.5px', marginBottom: 7 }}>Gender <span style={{ color: '#ef5a3c' }}>*</span></label>
                        <select
                          value={reg.gender} onChange={e => setReg(r => ({ ...r, gender: e.target.value }))}
                          disabled={!!regPickedId}
                          style={{ width: '100%', padding: '13px 14px', border: '1px solid #d6e7e3', borderRadius: 11, fontSize: 16, background: regPickedId ? '#f0f6f5' : '#f7fbfa' }}
                        >
                          <option value="">Select...</option>
                          {GENDERS.map(g => <option key={g} value={g}>{g}</option>)}
                        </select>
                      </div>
                    </div>
                    <div>
                      <label style={{ display: 'block', fontWeight: 700, fontSize: '13.5px', marginBottom: 7 }}>Address</label>
                      <textarea
                        className="fld" value={reg.address}
                        onChange={e => setReg(r => ({ ...r, address: e.target.value }))}
                        placeholder="House / street, area, city" rows={2} readOnly={!!regPickedId}
                        style={{ width: '100%', padding: '13px 14px', border: '1px solid #d6e7e3', borderRadius: 11, fontSize: 16, background: regPickedId ? '#f0f6f5' : '#f7fbfa', fontFamily: 'inherit', resize: 'vertical' }}
                      />
                    </div>
                    {/* After a Google sign-in the address is already known and
                        proved, so it is shown rather than asked for. After an
                        OTP sign-in the box is empty and optional. */}
                    <div>
                      <label style={{ display: 'block', fontWeight: 700, fontSize: '13.5px', marginBottom: 7 }}>Email</label>
                      <input
                        className="fld" value={authedEmail || reg.email}
                        onChange={e => setReg(r => ({ ...r, email: e.target.value }))}
                        type="email" inputMode="email" autoComplete="email"
                        placeholder="name@example.com (optional)"
                        readOnly={!!regPickedId || !!authedEmail}
                        style={{ width: '100%', padding: '13px 14px', border: '1px solid #d6e7e3', borderRadius: 11, fontSize: 16, background: (regPickedId || authedEmail) ? '#f0f6f5' : '#f7fbfa' }}
                      />
                      {!!authedEmail && (
                        <p style={{ margin: '6px 2px 0', fontSize: '12.5px', color: '#8aa8a3' }}>
                          From the Google account you signed in with.
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {hasRegMatches && !regAddingMember && (
                  <button onClick={() => {
                    setRegAddingMember(true);
                    setRegPickedId('');
                    setRegError('');
                    setReg(r => ({ ...r, name: '', age: '', gender: '', email: '' }));
                  }} style={{ border: 0, background: 'none', color: '#8aa8a3', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', padding: 0, textAlign: 'left', textDecoration: 'underline', textUnderlineOffset: '2px' }}>
                    None of these? Add a new family member
                  </button>
                )}

                {regError && <p style={{ color: '#c0392b', fontSize: '13.5px', fontWeight: 600 }}>{regError}</p>}

                <button onClick={saveRegister} disabled={savingReg} style={{
                  width: '100%', padding: 15, borderRadius: 12, border: 0,
                  background: savingReg ? '#8aa8a3' : '#ef5a3c', color: '#fff',
                  fontWeight: 700, fontSize: 16, cursor: savingReg ? 'default' : 'pointer',
                }}>
                  {savingReg ? 'Checking in...' : 'Check in & get queue number'}
                </button>
              </div>
            </div>
          )}

          {/* ═══ 3. HOME (Today tab) ═══ */}
          {view === 'home' && me && (
            <div>
              {/* Patient identity */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                <span style={{ width: 44, height: 44, borderRadius: '50%', background: '#0e756c', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 18, fontFamily: "'Bricolage Grotesque'" }}>
                  {(me.name || '?').trim().charAt(0).toUpperCase()}
                </span>
                <span style={{ lineHeight: 1.2, minWidth: 0 }}>
                  <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 19, color: '#0e3b39' }}>{me.name}</span>
                  <span style={{ display: 'block', fontSize: '12.5px', color: '#98b0ab' }}>
                    <span style={{ fontFamily: 'ui-monospace,monospace', color: '#0e756c', fontWeight: 600 }}>{myPatientId}</span> &middot; {(me.age || '?') + ' yrs · ' + (me.gender || '—')}
                  </span>
                </span>
              </div>

              {/* CHECKED-IN STRIP (pending only) */}
              {showCheckedIn && (
                <div style={{ marginTop: 16, borderRadius: 16, background: '#e9f7f0', border: '1px solid #c6e8d6', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ flex: '0 0 auto', width: 34, height: 34, borderRadius: '50%', background: '#12805a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <BigCheckIcon size={18} />
                  </span>
                  <span style={{ fontSize: 14, color: '#0e3b39', lineHeight: 1.35 }}>
                    {"You're checked in — your queue number is below."}
                  </span>
                </div>
              )}

              {/* QUEUE CARD (pending only) */}
              {showQueueCard && (
                <div style={{ marginTop: 10, borderRadius: 20, background: 'linear-gradient(135deg,#0e756c,#0e3b39)', color: '#fff', padding: 22, position: 'relative', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', right: -40, top: -40, width: 150, height: 150, borderRadius: '50%', background: 'rgba(127,212,201,.14)' }} />
                  <div style={{ position: 'relative' }}>
                    <span style={{ fontSize: '11.5px', letterSpacing: '.16em', textTransform: 'uppercase', color: '#7fd4c9', fontWeight: 700 }}>Your queue number today</span>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 6 }}>
                      <span style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 56, lineHeight: 1 }}>{queueNo}</span>
                      <span style={{ fontSize: 14, color: '#bfe3dd' }}>{fmtDate(today)}</span>
                    </div>
                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,.18)', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#7fd4c9', animation: 'pulseDot 1.6s ease-in-out infinite', flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: 15, fontWeight: 600 }}>{aheadText}</span>
                      <button onClick={refreshQueue} title="Refresh" aria-label="Refresh queue" style={{
                        flexShrink: 0, width: 34, height: 34, borderRadius: 10,
                        border: '1px solid rgba(255,255,255,.3)', background: 'rgba(255,255,255,.12)',
                        color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {refreshing ? (
                          <div style={{ width: 16, height: 16, border: '2px solid rgba(255,255,255,.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
                        ) : (
                          <RefreshIcon />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* VISIT DONE STRIP */}
              {showDoneStrip && (
                <div style={{ marginTop: 16, borderRadius: 16, background: '#e9f7f0', border: '1px solid #c6e8d6', padding: '15px 17px', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ flex: '0 0 auto', width: 38, height: 38, borderRadius: '50%', background: '#12805a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <BigCheckIcon size={20} />
                  </span>
                  <span style={{ lineHeight: 1.3 }}>
                    <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 17, color: '#0e3b39' }}>Visit done</span>
                    <span style={{ display: 'block', fontSize: 13, color: '#5c7a76' }}>Your consultation is complete. Details are below.</span>
                  </span>
                </div>
              )}

              {/* ACTIVE VISIT */}
              {activeVisit && (
                <div style={{ marginTop: 14, background: '#fff', border: '1px solid #dfece9', borderRadius: 18, padding: 18 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <h3 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: '16.5px', color: '#0e3b39' }}>Today&apos;s visit</h3>
                    {(() => {
                      const stLabel = activeVisit.done ? 'Visit done' : 'Waiting for doctor';
                      const stBg = activeVisit.done ? '#e3f5ec' : '#fdf0dc';
                      const stInk = activeVisit.done ? '#12805a' : '#a9741a';
                      return <span style={{ padding: '4px 11px', borderRadius: 100, fontSize: '11.5px', fontWeight: 700, background: stBg, color: stInk }}>{stLabel}</span>;
                    })()}
                  </div>
                  <p style={{ fontSize: '12.5px', color: '#98b0ab', marginTop: 2 }}>
                    <span style={{ fontFamily: 'ui-monospace,monospace', color: '#0e756c', fontWeight: 600 }}>{activeVisit.visitId}</span> &middot; {fmtDate(activeVisit.date)}
                  </p>

                  {/* Awaiting doctor (done=false) */}
                  {!activeVisit.done && (
                    <div style={{ marginTop: 14 }}>
                      {problemSaved && !editingProblem ? (
                        <div>
                          <div style={{ background: '#e6f4f2', border: '1px solid #c9e6e1', borderRadius: 12, padding: '13px 15px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: '11.5px', fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#0e756c' }}>
                                <CheckIcon /> Sent to the doctor
                              </span>
                              <button onClick={() => setEditingProblem(true)} style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, border: '1px solid #c9e6e1', background: '#fff', color: '#0e756c', fontWeight: 700, fontSize: 12, borderRadius: 8, padding: '6px 10px', cursor: 'pointer' }}>
                                <EditIcon /> Edit
                              </button>
                            </div>
                            <p style={{ fontSize: '14.5px', color: '#0e3b39', marginTop: 8, textWrap: 'pretty' }}>{problemDraft}</p>
                          </div>
                          <p style={{ color: '#98b0ab', fontSize: '12.5px', marginTop: 10, textAlign: 'center' }}>Treatment &amp; payment details will appear here once your consultation is complete.</p>
                        </div>
                      ) : (
                        <div>
                          <label style={{ display: 'block', fontWeight: 700, fontSize: '13.5px', marginBottom: 7 }}>
                            {editingProblem ? 'Edit your message' : "What's troubling you? (optional)"}
                          </label>
                          <textarea
                            value={problemDraft} onChange={e => setProblemDraft(e.target.value)}
                            placeholder="Describe your problem — pain, sensitivity, swelling, since when..."
                            style={{ width: '100%', minHeight: 96, padding: '13px 14px', border: '1px solid #d6e7e3', borderRadius: 11, fontSize: '15.5px', background: '#f7fbfa', resize: 'vertical' }}
                          />
                          <div style={{ display: 'flex', gap: 9, marginTop: 10 }}>
                            {editingProblem && (
                              <button onClick={() => {
                                setEditingProblem(false);
                                const openV = me.visits.filter(v => !v.done && v.date === today).sort((a, b) => (b.no || 0) - (a.no || 0))[0];
                                if (openV && openV.clinical && openV.clinical.patientProblem) {
                                  setProblemDraft(openV.clinical.patientProblem);
                                } else {
                                  setProblemDraft(problemDraft);
                                }
                              }} style={{ padding: '13px 18px', borderRadius: 11, border: '1px solid #d6e7e3', background: '#fff', color: '#5c7a76', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>
                                Cancel
                              </button>
                            )}
                            <button onClick={saveProblem} disabled={savingProblem || !problemDraft.trim()} style={{
                              flex: 1, padding: 13, borderRadius: 11, border: 0,
                              background: (!problemDraft.trim() || savingProblem) ? '#8aa8a3' : '#0e756c',
                              color: '#fff', fontWeight: 700, fontSize: 15,
                              cursor: (!problemDraft.trim() || savingProblem) ? 'default' : 'pointer',
                            }}>
                              {savingProblem ? 'Saving...' : editingProblem ? 'Save changes' : 'Send to doctor'}
                            </button>
                          </div>
                          <p style={{ color: '#98b0ab', fontSize: '12.5px', marginTop: 10, textAlign: 'center' }}>Optional — the doctor will see this before your consultation.</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Completed visit (done=true) */}
                  {activeVisit.done && (() => {
                    const c = activeVisit.clinical || {};
                    const cc = Array.isArray(c.chiefComplaint) ? c.chiefComplaint.join(', ') : (c.chiefComplaint || '');
                    const tr = treatmentLabel(c);
                    const rows = [
                      { k: 'Chief complaint', v: cc || '—' },
                      { k: 'Description', v: c.chiefDescription || '—' },
                      { k: 'Treatment group', v: c.treatmentGroup || '—' },
                      { k: 'Treatment', v: tr || '—' },
                    ];
                    if (c.patientProblem) rows.push({ k: 'What you told us', v: c.patientProblem });
                    const bal = num(c.balanceDue);
                    return (
                      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {rows.map(r => (
                          <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, paddingBottom: 9, borderBottom: '1px solid #f0f6f5' }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: '#8aa8a3', flex: '0 0 auto' }}>{r.k}</span>
                            <span style={{ fontSize: '14.5px', color: '#33534f', textAlign: 'right' }}>{r.v}</span>
                          </div>
                        ))}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginTop: 2 }}>
                          <div style={{ background: '#f7fbfa', border: '1px solid #e6f1ef', borderRadius: 12, padding: '11px 10px', textAlign: 'center' }}>
                            <span style={{ display: 'block', fontSize: '10.5px', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: '#8aa8a3' }}>Total</span>
                            <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 17, color: '#0e3b39', marginTop: 2 }}>{inr(num(c.treatmentCost))}</span>
                          </div>
                          <div style={{ background: '#f2faf6', border: '1px solid #d9eee4', borderRadius: 12, padding: '11px 10px', textAlign: 'center' }}>
                            <span style={{ display: 'block', fontSize: '10.5px', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: '#8aa8a3' }}>Paid</span>
                            <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 17, color: '#12805a', marginTop: 2 }}>{inr(num(c.amountPaid))}</span>
                          </div>
                          <div style={{ background: '#fdf6f4', border: '1px solid #f6d3c8', borderRadius: 12, padding: '11px 10px', textAlign: 'center' }}>
                            <span style={{ display: 'block', fontSize: '10.5px', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: '#8aa8a3' }}>Pending</span>
                            <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 17, color: '#c0392b', marginTop: 2 }}>{inr(bal)}</span>
                          </div>
                        </div>
                        {c.nextAppointment && (
                          <div style={{ background: '#e6f4f2', border: '1px solid #c9e6e1', borderRadius: 12, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 11 }}>
                            <CalIcon />
                            <span style={{ fontSize: 14, color: '#0e3b39' }}>
                              <strong>Next appointment</strong><br />
                              {fmtDate(c.nextAppointment)}{c.nextAppointmentTime ? ' · ' + fmtTime(c.nextAppointmentTime) : ''}
                            </span>
                          </div>
                        )}
                        {/* Doc chips on done today visit */}
                        {activeHasAnyDoc && (
                          <DocChips visitId={activeVisit.visitId} hasRx={activeHasRx} hasReceipt={activeHasReceipt} hasFiles={activeHasFiles} filesCount={activeDocs.length} />
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* NEW VISIT CTA — show when no pending visit, and (no visit at all OR visit done) */}
              {canStartVisit && (
                <button onClick={handleCheckinCta} style={{
                  width: '100%', marginTop: 14, padding: 15, borderRadius: 13, border: 0,
                  background: '#ef5a3c', color: '#fff', fontWeight: 700, fontSize: 16, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
                }}>
                  <PlusIcon /> Check in for a new visit
                </button>
              )}

              {/* UPCOMING APPOINTMENTS — show when no visit today or visit done */}
              {upcoming.length > 0 && (
                <div style={{ marginTop: 22 }}>
                  <h3 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: '16.5px', color: '#0e3b39', marginBottom: 10 }}>Upcoming appointments</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {upcoming.map(u => (
                      <div key={u.key} style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 16, padding: 14, display: 'flex', gap: 13, alignItems: 'center' }}>
                        <span style={{ flex: '0 0 auto', width: 52, borderRadius: 12, background: '#e6f4f2', padding: '8px 0', textAlign: 'center', lineHeight: 1.1 }}>
                          <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 19, color: '#0e756c' }}>{u.day}</span>
                          <span style={{ display: 'block', fontSize: 10, fontWeight: 700, letterSpacing: '.08em', color: '#0e756c' }}>{u.mon}</span>
                        </span>
                        <span style={{ flex: 1, minWidth: 0, lineHeight: 1.35 }}>
                          <span style={{ display: 'block', fontWeight: 700, color: '#0e3b39', fontSize: 15 }}>{u.timeLabel}</span>
                          <span style={{ display: 'block', fontSize: '12.5px', color: '#5c7a76' }}>{u.forLabel}</span>
                          <span style={{ display: 'block', fontSize: 12, color: '#98b0ab' }}>{u.dateLabel}</span>
                        </span>
                        {u.isToday && (
                          <span style={{ flex: '0 0 auto', padding: '4px 10px', borderRadius: 100, fontSize: 11, fontWeight: 700, background: '#e6f4f2', color: '#0e756c' }}>Today</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* CHECKING IN FOR SOMEONE ELSE — hide when visit is pending */}
              {!visitPending && familyMembers.length > 1 && (
                <button onClick={() => setMemberSheet(true)} style={{
                  width: '100%', marginTop: 12, padding: 13, borderRadius: 12,
                  border: '1px solid #dfece9', background: '#fff', color: '#0e756c',
                  fontWeight: 700, fontSize: 14, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
                }}>
                  <PeopleAddIcon /> Checking in for someone else?
                </button>
              )}
            </div>
          )}

          {/* ═══ 4. HISTORY (Records tab) ═══ */}
          {view === 'records' && me && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <h1 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 24, color: '#0e3b39' }}>Visit history</h1>
                  <p style={{ color: '#5c7a76', fontSize: '14.5px', marginTop: 2 }}>
                    {me.name} &middot; <span style={{ fontFamily: 'ui-monospace,monospace', color: '#0e756c', fontWeight: 600 }}>{myPatientId}</span>
                  </p>
                </div>
              </div>

              {/* Lifetime tiles */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginTop: 16 }}>
                <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 14, padding: '13px 10px', textAlign: 'center' }}>
                  <span style={{ display: 'block', fontSize: '10.5px', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: '#8aa8a3' }}>Visits</span>
                  <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 20, color: '#0e3b39', marginTop: 2 }}>{me.visits.length}</span>
                </div>
                <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 14, padding: '13px 10px', textAlign: 'center' }}>
                  <span style={{ display: 'block', fontSize: '10.5px', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: '#8aa8a3' }}>Paid</span>
                  <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 20, color: '#12805a', marginTop: 2 }}>{inr(totalPaid)}</span>
                </div>
                <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 14, padding: '13px 10px', textAlign: 'center' }}>
                  <span style={{ display: 'block', fontSize: '10.5px', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: '#8aa8a3' }}>Pending</span>
                  <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 20, color: '#c0392b', marginTop: 2 }}>{inr(totalPending)}</span>
                </div>
              </div>

              {totalPending > 0 && (
                <div style={{ marginTop: 12, background: '#fdf6f4', border: '1px solid #f6d3c8', borderRadius: 13, padding: '12px 14px', fontSize: '13.5px', color: '#b0442a' }}>
                  You have <strong>{inr(totalPending)}</strong> pending across your visits. You can settle this at the clinic reception.
                </div>
              )}

              {allVisits.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <h3 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: '16.5px', color: '#0e3b39', marginBottom: 4 }}>All visits</h3>
                  <p style={{ fontSize: '12.5px', color: '#98b0ab', marginBottom: 10 }}>Newest first &middot; tap any visit for full details.</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {allVisits.map(v => (
                      <div key={v.visitId} style={{ border: '1px solid #dfece9', borderRadius: 16, background: '#fff', padding: 14 }}>
                        <div onClick={() => setDetailVisitId(v.visitId)} style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                            <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 12, color: '#0e756c', fontWeight: 700 }}>{v.visitId}</span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ flexShrink: 0, padding: '3px 10px', borderRadius: 100, fontSize: '11.5px', fontWeight: 700, background: v.stBg, color: v.stInk }}>{v.status}</span>
                              <ChevronRight />
                            </span>
                          </div>
                          <span style={{ fontSize: 15, fontWeight: 600, color: '#0e3b39' }}>{v.treatmentLbl}</span>
                          <span style={{ fontSize: '12.5px', color: '#5c7a76' }}>
                            {fmtDate(v.date)}
                            {v.showCharges && <span> &middot; Cost {v.costLabel}</span>}
                            {v.pendingVisit && <span style={{ fontStyle: 'italic' }}> &middot; Not billed yet</span>}
                            {v.hasBalance && <span style={{ color: '#c0392b', fontWeight: 700 }}> &middot; Due {v.balanceLabel}</span>}
                          </span>
                        </div>
                        {v.hasAnyDoc && (
                          <DocChips visitId={v.visitId} hasRx={v.hasRx} hasReceipt={v.hasReceipt} hasFiles={v.hasFiles} filesCount={v.filesCount} />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {allVisits.length === 0 && (
                <div style={{ marginTop: 20, background: '#fff', border: '1px solid #dfece9', borderRadius: 18, padding: '44px 20px', textAlign: 'center' }}>
                  <p style={{ fontSize: '15.5px', fontWeight: 600, color: '#5c7a76' }}>No visits yet.</p>
                  <p style={{ fontSize: '13.5px', color: '#98b0ab', marginTop: 5 }}>Your treatment history will appear here after your first consultation.</p>
                </div>
              )}
            </div>
          )}

          {/* ═══ 5. FAMILY ═══ */}
          {view === 'family' && me && (
            <div>
              <h1 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 24, color: '#0e3b39' }}>Family</h1>
              <p style={{ color: '#5c7a76', fontSize: '14.5px', marginTop: 2 }}>Everyone registered on this mobile number. Tap anyone to view their visit history.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
                {familyMembers.map(f => {
                  const isMe = f.isMe;
                  return (
                    <button key={f.patientId} onClick={() => {
                      if (isMe) return;
                      viewMemberRecords(f.patientId);
                    }} style={{
                      textAlign: 'left', width: '100%', display: 'flex', alignItems: 'center', gap: 13,
                      padding: 14, border: isMe ? '2px solid #12a094' : '1px solid #dfece9',
                      borderRadius: 16, background: isMe ? '#eef7f6' : '#fff',
                      cursor: isMe ? 'default' : 'pointer',
                    }}>
                      <span style={{ flex: '0 0 auto', width: 44, height: 44, borderRadius: '50%', background: '#e6f4f2', color: '#0e756c', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 17, fontFamily: "'Bricolage Grotesque'" }}>
                        {f.initial}
                      </span>
                      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontWeight: 700, color: '#0e3b39', fontSize: 16 }}>{f.name}</span>
                          <span style={{ flexShrink: 0, fontSize: '11.5px', fontWeight: 700, color: '#0e756c' }}>{isMe ? 'Viewing' : 'View records →'}</span>
                        </span>
                        <span style={{ fontSize: '12.5px', color: '#98b0ab' }}>{f.meta}</span>
                        <span style={{ fontSize: '12.5px', color: '#5c7a76' }}>{f.lastLabel}</span>
                        {f.hasPending && (
                          <span style={{ fontSize: '12.5px', color: '#c0392b', fontWeight: 700 }}>Pending {f.pendingLabel}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
              <button onClick={goRegisterForFamily} style={{
                width: '100%', marginTop: 14, padding: 14, borderRadius: 13,
                border: '1px dashed #cfe3df', background: '#f7fbfa', color: '#0e756c',
                fontWeight: 700, fontSize: '14.5px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}>
                <PlusIcon /> Add a new family member
              </button>
            </div>
          )}

          {/* ═══ CONFIRM WHO SHEET ═══ */}
          {confirmWho && me && (
            <div onClick={() => setConfirmWho(false)} style={{ position: 'fixed', inset: 0, zIndex: 92, background: 'rgba(14,59,57,.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
              <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: '22px 22px 0 0', width: '100%', maxWidth: 460, padding: '22px 20px 26px' }}>
                <h3 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: '17.5px', color: '#0e3b39' }}>Confirm who is visiting</h3>
                <p style={{ color: '#5c7a76', fontSize: 14, marginTop: 5, textWrap: 'pretty' }}>This mobile number has more than one patient registered.</p>
                <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12, border: '1px solid #cfe3df', background: '#f2f9f8', borderRadius: 14, padding: '13px 15px' }}>
                  <span style={{ flex: '0 0 auto', width: 40, height: 40, borderRadius: '50%', background: '#12a094', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 16 }}>
                    {(me.name || '?').trim().charAt(0).toUpperCase()}
                  </span>
                  <span style={{ lineHeight: 1.25, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 700, color: '#0e3b39', fontSize: '15.5px' }}>{me.name}</span>
                    <span style={{ display: 'block', fontSize: '12.5px', color: '#5c7a76' }}>{(me.age || '?') + ' yrs · ' + (me.gender || '—')}</span>
                  </span>
                </div>
                <button onClick={doCheckinForMe} style={{ width: '100%', marginTop: 16, padding: 14, borderRadius: 12, border: 0, background: '#ef5a3c', color: '#fff', fontWeight: 700, fontSize: '15.5px', cursor: 'pointer' }}>
                  Yes, check in {me.name}
                </button>
                <button onClick={() => { setConfirmWho(false); setMemberSheet(true); }} style={{ width: '100%', marginTop: 9, padding: 13, borderRadius: 12, border: '1px solid #dfece9', background: '#fff', color: '#0e756c', fontWeight: 700, fontSize: '14.5px', cursor: 'pointer' }}>
                  Choose someone else
                </button>
                <button onClick={() => setConfirmWho(false)} style={{ width: '100%', marginTop: 6, padding: 11, borderRadius: 12, border: 0, background: 'none', color: '#8aa8a3', fontWeight: 700, fontSize: '13.5px', cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* ═══ MEMBER SHEET (checking in for someone else) ═══ */}
          {memberSheet && me && (
            <div onClick={() => setMemberSheet(false)} style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(14,59,57,.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
              <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: '22px 22px 0 0', width: '100%', maxWidth: 460, padding: '22px 20px 26px', maxHeight: '88vh', overflow: 'auto' }}>
                <h3 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: '17.5px', color: '#0e3b39' }}>Who needs to see the doctor?</h3>
                <p style={{ fontSize: 13, color: '#98b0ab', marginTop: 3 }}>Everyone registered on this mobile number.</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
                  {familyMembers.map(f => {
                    const isMe = f.isMe;
                    const hasTodayVisit = db.patients[f.patientId]?.visits.some(v => v.date === today && !v.done);
                    let actionLabel = 'Check in';
                    if (isMe) actionLabel = 'Viewing';
                    else if (hasTodayVisit) actionLabel = 'Open';
                    return (
                      <button key={f.patientId} onClick={() => {
                        if (isMe) { setMemberSheet(false); return; }
                        if (hasTodayVisit) { switchToMember(f.patientId); }
                        else { switchToMember(f.patientId); }
                      }} style={{
                        textAlign: 'left', width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                        padding: 13, border: isMe ? '2px solid #12a094' : '1px solid #e2efec',
                        borderRadius: 13, background: isMe ? '#eef7f6' : '#fff', cursor: 'pointer',
                      }}>
                        <span style={{ flex: '0 0 auto', width: 40, height: 40, borderRadius: '50%', background: '#e6f4f2', color: '#0e756c', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontFamily: "'Bricolage Grotesque'" }}>
                          {f.initial}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, lineHeight: 1.3 }}>
                          <span style={{ display: 'block', fontWeight: 700, color: '#0e3b39', fontSize: 15 }}>{f.name}</span>
                          <span style={{ display: 'block', fontSize: '12.5px', color: '#98b0ab' }}>{f.meta}</span>
                        </span>
                        <span style={{ flex: '0 0 auto', color: '#0e756c', fontWeight: 700, fontSize: 13 }}>{actionLabel}</span>
                      </button>
                    );
                  })}
                </div>
                <button onClick={goRegisterForFamily} style={{
                  width: '100%', marginTop: 14, padding: 13, borderRadius: 12,
                  border: '1px dashed #cfe3df', background: '#f7fbfa', color: '#0e756c',
                  fontWeight: 700, fontSize: 14, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}>
                  <PlusIcon /> Add a new family member
                </button>
                <button onClick={() => setMemberSheet(false)} style={{
                  width: '100%', marginTop: 8, padding: 12, borderRadius: 12, border: 0,
                  background: 'none', color: '#8aa8a3', fontWeight: 700, fontSize: '13.5px', cursor: 'pointer',
                }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* ═══ VISIT DETAIL SHEET ═══ */}
          {detailVisitId && me && (() => {
            const v = me.visits.find(x => x.visitId === detailVisitId);
            if (!v) return null;
            const c = v.clinical || {};
            const cc = Array.isArray(c.chiefComplaint) ? c.chiefComplaint.join(', ') : (c.chiefComplaint || '');
            const tr = treatmentLabel(c);
            const rows = [];
            if (v.done) {
              rows.push({ k: 'Chief complaint', v: cc || '—' });
              rows.push({ k: 'Description', v: c.chiefDescription || '—' });
              rows.push({ k: 'Treatment group', v: c.treatmentGroup || '—' });
              rows.push({ k: 'Treatment', v: tr || '—' });
              if (c.patientProblem) rows.push({ k: 'What you told us', v: c.patientProblem });
              rows.push({ k: 'Treatment cost', v: num(c.treatmentCost) ? inr(num(c.treatmentCost)) : '—' });
              rows.push({ k: 'Amount paid', v: num(c.amountPaid) ? inr(num(c.amountPaid)) : '—' });
              rows.push({ k: 'Balance due', v: num(c.balanceDue) ? inr(num(c.balanceDue)) : '—' });
              if (c.paymentStatus) rows.push({ k: 'Payment status', v: c.paymentStatus });
              if (c.nextAppointment) rows.push({ k: 'Next appointment', v: fmtDate(c.nextAppointment) + (c.nextAppointmentTime ? ' · ' + fmtTime(c.nextAppointmentTime) : '') });
              if (c.comments) rows.push({ k: 'Notes', v: c.comments });
            }
            return (
              <div onClick={() => setDetailVisitId('')} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(14,59,57,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 460, maxHeight: '82vh', overflow: 'auto' }}>
                  <div style={{ position: 'sticky', top: 0, background: '#0e3b39', color: '#fff', padding: '18px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, borderRadius: '20px 20px 0 0' }}>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: '12.5px', color: '#7fd4c9', fontWeight: 700 }}>{v.visitId}</span>
                      <h3 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 17 }}>{fmtDate(v.date)}</h3>
                    </div>
                    <button onClick={() => setDetailVisitId('')} style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 9, border: 0, background: 'rgba(255,255,255,.15)', color: '#fff', fontSize: 16, cursor: 'pointer' }}>{'✕'}</button>
                  </div>
                  <div style={{ padding: '6px 20px 26px' }}>
                    {!v.done && (
                      <div style={{ background: '#fdf6ec', border: '1px solid #f4dfc0', borderRadius: 13, padding: '13px 15px', marginTop: 12, fontSize: 14, color: '#8a6320', textWrap: 'pretty' }}>
                        Awaiting doctor &mdash; your treatment and payment details will appear here once your consultation is complete.
                      </div>
                    )}
                    {rows.map(r => (
                      <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, padding: '11px 0', borderBottom: '1px solid #f0f6f5' }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#8aa8a3', flex: '0 0 auto' }}>{r.k}</span>
                        <span style={{ fontSize: '14.5px', color: '#33534f', textAlign: 'right' }}>{r.v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })()}
        </main>

        {/* ═══ PRESCRIPTION / RECEIPT SHEET ═══ */}
        {viewDoc && me && (() => {
          const v = me.visits.find(x => x.visitId === viewDoc.visitId);
          if (!v) return null;
          const c = v.clinical || {};
          const meta = {
            visitId: v.visitId, dateLabel: fmtDate(v.date), name: me.name, mobile: me.mobile,
            patientId: myPatientId, ageGender: (me.age || '?') + ' yrs · ' + (me.gender || '—'),
          };
          const isRx = viewDoc.kind === 'rx';
          const title = isRx ? 'Prescription' : 'Payment Receipt';
          const useDocxView = isRx ? hasDocxRxTemplate : hasDocxReceiptTemplate;
          const rx = (!useDocxView && isRx) ? buildRx(c, meta, CLINIC_NAME) : null;
          const receipt = (!useDocxView && !isRx) ? buildReceipt(c, meta) : null;
          return (
            <div id="rx-overlay" style={{ position: 'fixed', inset: 0, zIndex: 95, background: 'rgba(14,59,57,.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 14, overflow: 'auto' }}>
              <div id="rx-sheet" onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 18, width: '100%', maxWidth: 560, overflow: 'hidden', margin: 'auto' }}>
                <div id="rx-chrome" style={{ background: '#0e3b39', color: '#fff', padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <span style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 16 }}>{title}</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {useDocxView && docxContent?.url && (
                      <button onClick={() => printAsPdf(docxContent.url)} style={{ padding: '8px 14px', borderRadius: 9, border: '1px solid rgba(255,255,255,.3)', background: 'transparent', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Print</button>
                    )}
                    {useDocxView && docxContent?.url && (
                      <button onClick={() => downloadAsPdf(docxContent.url, `${isRx ? 'Prescription' : 'Receipt'}_${viewDoc.visitId || 'doc'}.pdf`)} style={{ padding: '8px 14px', borderRadius: 9, border: 0, background: '#12a094', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Download</button>
                    )}
                    {!useDocxView && <button onClick={() => { try { window.print(); } catch {} }} style={{ padding: '8px 14px', borderRadius: 9, border: '1px solid rgba(255,255,255,.3)', background: 'transparent', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Print</button>}
                    {!useDocxView && <button onClick={() => downloadElementAsPdf('portal-print-body', `${isRx ? 'Prescription' : 'Receipt'}_${viewDoc.visitId || 'doc'}.pdf`)} style={{ padding: '8px 14px', borderRadius: 9, border: 0, background: '#12a094', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Download</button>}
                    <button onClick={() => { setViewDoc(null); setDocxContent(null); }} style={{ width: 32, height: 32, borderRadius: 9, border: 0, background: 'rgba(255,255,255,.15)', color: '#fff', fontSize: 15, cursor: 'pointer' }}>{'✕'}</button>
                  </div>
                </div>

                {/* DOCX template view */}
                {useDocxView && (
                  <div style={{ minHeight: 200 }}>
                    {docxLoading && (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 20px', gap: 14 }}>
                        <div style={{ width: 36, height: 36, border: '3px solid #d6e7e3', borderTopColor: '#12a094', borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
                        <span style={{ fontSize: 14, color: '#5c7a76', fontWeight: 600 }}>Generating {isRx ? 'prescription' : 'receipt'}...</span>
                      </div>
                    )}
                    {!docxLoading && docxContent?.format === 'html' && docxContent.url && (
                      <iframe src={docxContent.url} title={title} style={{ width: '100%', minHeight: 500, border: 0 }} />
                    )}
                    {!docxLoading && docxContent?.format === 'docx' && docxContent.url && (
                      <div style={{ padding: '40px 20px', textAlign: 'center' }}>
                        <p style={{ fontSize: 15, color: '#33534f', marginBottom: 16 }}>Your {isRx ? 'prescription' : 'receipt'} is ready.</p>
                        <a href={docxContent.url} target="_blank" rel="noopener noreferrer" style={{ padding: '12px 24px', borderRadius: 11, border: 0, background: '#0e756c', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer', textDecoration: 'none' }}>Download DOCX</a>
                      </div>
                    )}
                    {!docxLoading && !docxContent && (
                      <div style={{ padding: '40px 20px', textAlign: 'center' }}>
                        <p style={{ fontSize: 14, color: '#c0392b', fontWeight: 600 }}>Could not generate the document. Please try again later.</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Standard prescription view (no DOCX template) */}
                {!useDocxView && isRx && rx && (
                  <div id="portal-print-body" style={{ padding: '20px 20px 26px', background: '#fff' }}>
                    <div style={{ borderBottom: '2px solid #0e756c', paddingBottom: 12 }}>
                      <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 18, color: '#0e3b39' }}>{CLINIC_NAME}</span>
                      <span style={{ display: 'block', fontSize: '11.5px', color: '#5c7a76', marginTop: 6 }}>Date: <strong style={{ color: '#0e3b39' }}>{rx.dateLabel}</strong> &middot; <span style={{ fontFamily: 'ui-monospace,monospace' }}>{rx.visitId}</span></span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: '8px 20px', marginTop: 14, fontSize: 13 }}>
                      <span style={{ color: '#5c7a76' }}>Patient: <strong style={{ color: '#0e3b39' }}>{rx.name}</strong></span>
                      <span style={{ color: '#5c7a76' }}>Age / Gender: <strong style={{ color: '#0e3b39' }}>{rx.ageGender}</strong></span>
                      <span style={{ color: '#5c7a76' }}>Mobile: <strong style={{ color: '#0e3b39' }}>{rx.mobile}</strong></span>
                      {!!rx.medicalHistory && <span style={{ color: '#5c7a76' }}>Medical history: <strong style={{ color: '#0e3b39' }}>{rx.medicalHistory}</strong></span>}
                    </div>
                    <div style={{ marginTop: 14, padding: '13px 15px', borderRadius: 12, background: '#f7fbfa', border: '1px solid #e2efec', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: '8px 20px', fontSize: 13 }}>
                      {!!rx.chiefComplaint && <span style={{ color: '#5c7a76' }}>Chief complaint: <strong style={{ color: '#0e3b39' }}>{rx.chiefComplaint}</strong></span>}
                      {!!rx.description && <span style={{ color: '#5c7a76' }}>Description: <strong style={{ color: '#0e3b39' }}>{rx.description}</strong></span>}
                      {!!rx.treatmentGroup && <span style={{ color: '#5c7a76' }}>Treatment group: <strong style={{ color: '#0e3b39' }}>{rx.treatmentGroup}</strong></span>}
                      {!!rx.toothNumber && <span style={{ color: '#5c7a76' }}>Tooth number: <strong style={{ color: '#0e3b39' }}>{rx.toothNumber}</strong></span>}
                      {!!rx.treatment && <span style={{ color: '#5c7a76' }}>Current treatment: <strong style={{ color: '#0e3b39' }}>{rx.treatment}</strong></span>}
                      {!!rx.advisedTreatment && <span style={{ color: '#5c7a76' }}>Advised treatment: <strong style={{ color: '#0e3b39' }}>{rx.advisedTreatment}</strong></span>}
                    </div>
                    <p style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 15, color: '#0e3b39', margin: '18px 0 8px' }}>{'℞'} Medicines</p>
                    {rx.noMeds && <p style={{ fontSize: 13, color: '#98b0ab' }}>No medicine prescribed.</p>}
                    {rx.hasMeds && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {rx.meds.map(vm => (
                          <div key={vm.sn} style={{ border: '1px solid #e2efec', borderRadius: 12, padding: '11px 13px', background: '#fbfdfd' }}>
                            <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: '#0e3b39' }}>{vm.sn}. {vm.name} <span style={{ color: '#98b0ab', fontWeight: 400 }}>({vm.unit})</span></span>
                            <span style={{ display: 'block', fontSize: '12.5px', color: '#5c7a76', marginTop: 3 }}>{vm.dose} &middot; {vm.food} &middot; {vm.duration} <span style={{ color: '#98b0ab' }}>{vm.total}</span></span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Standard receipt view (no DOCX template) */}
                {!useDocxView && !isRx && receipt && (
                  <div id="portal-print-body" style={{ padding: '20px 20px 26px', background: '#fff' }}>
                    <div style={{ borderBottom: '2px solid #0e756c', paddingBottom: 12 }}>
                      <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 18, color: '#0e3b39' }}>{CLINIC_NAME}</span>
                      <span style={{ display: 'block', fontSize: '11.5px', color: '#5c7a76', marginTop: 6 }}>Date: <strong style={{ color: '#0e3b39' }}>{receipt.dateLabel}</strong> &middot; <span style={{ fontFamily: 'ui-monospace,monospace' }}>{receipt.receiptNo}</span></span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: '8px 20px', marginTop: 14, fontSize: 13 }}>
                      <span style={{ color: '#5c7a76' }}>Received from: <strong style={{ color: '#0e3b39' }}>{receipt.name}</strong></span>
                      <span style={{ color: '#5c7a76' }}>Mobile: <strong style={{ color: '#0e3b39' }}>{receipt.mobile}</strong></span>
                      <span style={{ color: '#5c7a76' }}>Patient ID: <strong style={{ color: '#0e3b39' }}>{receipt.patientId}</strong></span>
                      <span style={{ color: '#5c7a76' }}>Mode: <strong style={{ color: '#0e3b39' }}>{receipt.mode}</strong></span>
                    </div>
                    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column' }}>
                      {receipt.lines.map(vl => (
                        <div key={vl.sn} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, padding: '10px 0', borderBottom: '1px solid #f0f6f5', fontSize: '13.5px' }}>
                          <span style={{ color: '#0e3b39' }}>{vl.sn}. {vl.label}</span>
                          <span style={{ color: '#33534f', fontWeight: 600 }}>{vl.amountLabel}</span>
                        </div>
                      ))}
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, padding: '12px 0' }}>
                        <span style={{ fontWeight: 700, color: '#0e3b39', fontSize: 14 }}>Total received</span>
                        <span style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 18, color: '#12805a' }}>{receipt.totalLabel}</span>
                      </div>
                    </div>
                    <div style={{ padding: '12px 14px', borderRadius: 12, background: '#f7fbfa', border: '1px solid #e2efec', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', fontSize: 13 }}>
                      <span style={{ color: '#5c7a76' }}>Payment status: <strong style={{ color: '#0e3b39' }}>{receipt.status}</strong></span>
                      <span style={{ color: '#5c7a76' }}>Balance due: <strong style={{ color: receipt.balanceColor }}>{receipt.balanceLabel}</strong></span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* ═══ FILES POPUP ═══ */}
        {filesVisit && me && (() => {
          const v = me.visits.find(x => x.visitId === filesVisit);
          if (!v) return null;
          const docs = ((v.clinical || {}).documents) || [];
          if (docs.length === 0) return null;
          return (
            <div style={{ position: 'fixed', inset: 0, zIndex: 95, background: 'rgba(14,59,57,.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 14, overflow: 'auto' }}>
              <div style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 460, overflow: 'hidden', margin: 'auto' }}>
                <div style={{ background: '#0e3b39', color: '#fff', padding: '16px 18px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontFamily: 'ui-monospace,monospace', fontSize: 12, color: '#7fd4c9', fontWeight: 700 }}>{v.visitId}</span>
                    <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 17 }}>Documents</span>
                    <span style={{ display: 'block', fontSize: 12, color: '#bfe3dd', marginTop: 1 }}>{fmtDate(v.date)} &middot; {docs.length === 1 ? '1 document' : docs.length + ' documents'}</span>
                  </div>
                  <button onClick={() => setFilesVisit(null)} style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 9, border: 0, background: 'rgba(255,255,255,.15)', color: '#fff', fontSize: 15, cursor: 'pointer' }}>{'✕'}</button>
                </div>
                <div style={{ padding: '14px 16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {docs.map((d, i) => {
                    const isImg = /^image\//.test(d.type || '');
                    const thumbSrc = isImg ? (d.dataUrl || null) : null;
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, border: '1px solid #e2efec', borderRadius: 14, padding: '11px 12px', background: '#fbfdfd' }}>
                        <span style={{ flex: '0 0 auto', width: 50, height: 50, borderRadius: 11, background: '#eef4f3', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {thumbSrc ? <img src={thumbSrc} alt={d.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <DocFileIcon />}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, lineHeight: 1.3 }}>
                          <span style={{ display: 'block', fontSize: '10.5px', fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#0e756c' }}>{d.kind || 'Other'}</span>
                          <span style={{ display: 'block', fontSize: '13.5px', color: '#0e3b39', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
                          <span style={{ display: 'block', fontSize: '11.5px', color: '#98b0ab' }}>{fileTypeLabel(d.type)}</span>
                        </span>
                        <button onClick={() => {
                          if (d.s3Key) {
                            getDocumentUrl(d.s3Key).then(url => { if (url) window.open(url, '_blank'); }).catch(() => {});
                          } else if (d.dataUrl) {
                            window.open(d.dataUrl, '_blank');
                          }
                        }} style={{ flex: '0 0 auto', padding: '9px 14px', borderRadius: 10, border: '1px solid #cfe3df', background: '#f2f9f8', color: '#0e756c', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <EyeIcon /> View
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })()}

        {/* ═══ BOTTOM TABS: Today / History / Family ═══ */}
        {showTabs && (
          <div>
            <div style={{ height: 76 }} />
            <nav style={{
              position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 60,
              display: 'flex', justifyContent: 'center',
              background: '#fff', borderTop: '1px solid #e2efec',
              boxShadow: '0 -8px 24px -14px rgba(14,59,57,.22)',
            }}>
              <div style={{ width: '100%', maxWidth: 460, display: 'flex', gap: 8, padding: '8px 14px calc(8px + env(safe-area-inset-bottom))' }}>
                <button onClick={goHome} style={{
                  flex: 1, padding: 10, borderRadius: 12, border: 0,
                  background: view === 'home' ? '#e6f4f2' : 'transparent',
                  color: view === 'home' ? '#0e756c' : '#8aa8a3',
                  fontWeight: 700, fontSize: 12, cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                }}>
                  <HomeIcon /> Today
                </button>
                <button onClick={goHistory} style={{
                  flex: 1, padding: 10, borderRadius: 12, border: 0,
                  background: view === 'records' ? '#e6f4f2' : 'transparent',
                  color: view === 'records' ? '#0e756c' : '#8aa8a3',
                  fontWeight: 700, fontSize: 12, cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                }}>
                  <HistoryIcon /> History
                </button>
                <button onClick={goFamily} style={{
                  flex: 1, padding: 10, borderRadius: 12, border: 0,
                  background: view === 'family' ? '#e6f4f2' : 'transparent',
                  color: view === 'family' ? '#0e756c' : '#8aa8a3',
                  fontWeight: 700, fontSize: 12, cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                }}>
                  <FamilyIcon /> Family
                </button>
              </div>
            </nav>
          </div>
        )}
      </div>

      {/* Global styles for portal-specific animations */}
      <style>{`
        @keyframes pulseDot {
          0%, 100% { opacity: 1; }
          50% { opacity: .35; }
        }
        @media print {
          body * { visibility: hidden !important; }
          #rx-sheet, #rx-sheet * { visibility: visible !important; }
          #rx-chrome { display: none !important; }
          #rx-overlay {
            position: absolute !important; inset: auto !important;
            top: 0 !important; left: 0 !important;
            width: 100% !important; background: none !important;
            padding: 0 !important; overflow: visible !important;
            display: block !important; z-index: auto !important;
          }
          #rx-sheet {
            position: absolute !important; left: 0 !important; top: 0 !important;
            width: 100% !important; max-width: none !important;
            margin: 0 !important; border-radius: 0 !important;
            box-shadow: none !important; overflow: visible !important;
          }
        }
      `}</style>

      {/* Full-screen loading overlay */}
      {(savingReg || savingProblem) && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 100,
          background: 'rgba(238,244,243,.88)', backdropFilter: 'blur(2px)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16,
        }}>
          <div style={{ width: 44, height: 44, border: '3.5px solid #d6e7e3', borderTopColor: '#12a094', borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
          <span style={{ fontSize: 15, color: '#5c7a76', fontWeight: 600 }}>Loading, please wait...</span>
        </div>
      )}

      <div id="recaptcha-container" />
    </div>
  );
}
