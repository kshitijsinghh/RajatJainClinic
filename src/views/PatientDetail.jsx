import { useState, useEffect } from 'react';
import { buildRx, buildReceipt, normalizeClinical, ReceiptSheet, PrescriptionSheet, trTeethLabel, advTeethLabel } from './Clinical';
import { getDocumentUrl } from '../api';
import PatientWhatsAppCard, { OptedOutPill } from '../whatsapp/PatientWhatsApp';

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
  return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
}
function listLabel(v, fallback) {
  if (Array.isArray(v)) return v.length ? v.join(', ') : (fallback || '');
  return v || fallback || '';
}
function trLabel(c) {
  if (!c) return '';
  const t = Array.isArray(c.treatment) ? c.treatment : (c.treatment ? [c.treatment] : []);
  const hasOther = t.some(x => /Other/.test(x));
  if (hasOther && c.treatmentOther) return [...t.filter(x => !/Other/.test(x)), c.treatmentOther].join(', ');
  return t.join(', ');
}
function medDoseText(m) {
  const parts = [];
  if (m.morning) parts.push('1 Morning');
  if (m.afternoon) parts.push('1 Afternoon');
  if (m.evening) parts.push('1 Evening');
  if (m.night) parts.push('1 Night');
  return parts.length ? parts.join(', ') : '—';
}
function fileTypeLabel(type) {
  if (!type) return 'File';
  if (/^image/i.test(type)) return 'Image';
  if (/pdf/i.test(type)) return 'PDF';
  return 'File';
}

const PAY_MAP = {
  'Fully Paid': ['#e3f5ec', '#12805a'],
  'Partially paid': ['#fdf0dc', '#a9741a'],
  'Not paid': ['#fdecea', '#c0392b'],
};

function buildDetailRows(v, p) {
  const c = normalizeClinical(v.clinical || {});
  const rows = [];
  const add = (k, val) => { if (val) rows.push({ k, v: val }); };
  add('Date', fmtDate(v.date));
  add('Medical history', c.medicalHistory);
  add('Chief complaint', listLabel(c.chiefComplaint));
  add('Description', c.chiefDescription);
  add('Diagnosis', c.diagnosis);
  add('Advised treatment', advTeethLabel(c) || listLabel(c.advisedTreatment));
  add('Investigation', c.investigation);
  add('Treatment group', listLabel(c.treatmentGroup));
  add('Current treatment', trTeethLabel(c) || trLabel(c));
  add('Tooth number', listLabel(c.toothNumber));
  const meds = (c.medicines || []).filter(m => m.name);
  if (meds.length) {
    add('Medicines', meds.map(m => m.name + ' — ' + medDoseText(m) + ', ' + m.food + (m.duration ? ', ' + m.duration + ' days' : '') + (m.remarks ? ' (' + m.remarks + ')' : '')).join(' · '));
  }
  if (num(c.treatmentCost)) add('Treatment cost', inr(num(c.treatmentCost)));
  if (num(c.amountPaid)) add('Amount paid', inr(num(c.amountPaid)));
  if (c.balanceDue !== undefined && c.balanceDue !== '') add('Balance due', inr(num(c.balanceDue)));
  add('Payment mode', c.paymentMode);
  add('Payment status', c.paymentStatus);
  add('Treatment stage', c.treatmentStage);
  if (c.treatmentStage === 'Complete') add('Google review taken', c.googleReviewTaken);
  if ((c.treatmentStage === 'In Progress' || c.treatmentStage === 'Follow Up Pending') && c.nextAppointment) {
    add('Next appointment', fmtDate(c.nextAppointment) + (c.nextAppointmentTime ? ' at ' + fmtTime(c.nextAppointmentTime) : ''));
  }
  add('Comments', c.comments);
  add('Lab name', c.labName);
  add('Lab tooth number', c.labToothNumber || listLabel(c.toothNumber));
  add('Lab description', c.labDescription);
  add("Patient's complaint", c.patientProblem);
  add('Medical history (patient)', c.patientMedicalHistory);
  add('Allergies (patient)', c.patientAllergies);
  add('Dental history (patient)', c.patientDentalHistory);
  return { rows };
}


/* ReceiptSheet is imported from Clinical.jsx */

function FilesPopup({ filesVisit, patient, onClose }) {
  const nc = normalizeClinical(filesVisit.clinical || {});
  const docs = (nc.documents || []).filter(d => d.dataUrl || d.s3Key);
  const countLabel = docs.length === 1 ? '1 document' : docs.length + ' documents';

  function onView(ev, d) {
    if (d.s3Key) {
      ev.preventDefault();
      getDocumentUrl(d.s3Key).then(u => u && window.open(u, '_blank')).catch(() => {});
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 95, background: 'rgba(14,59,57,.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 20, overflow: 'auto' }}>
      <div style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 520, overflow: 'hidden', margin: 'auto' }}>
        <div style={{ background: '#0e3b39', color: '#fff', padding: '16px 20px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontFamily: 'ui-monospace,monospace', fontSize: 12.5, color: '#7fd4c9', fontWeight: 700 }}>{filesVisit.visitId}</span>
            <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 17 }}>Documents</span>
            <span style={{ display: 'block', fontSize: 12.5, color: '#bfe3dd', marginTop: 1 }}>{patient.name} · {fmtDate(filesVisit.date)} · {countLabel}</span>
          </div>
          <button onClick={onClose} style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 9, border: 0, background: 'rgba(255,255,255,.15)', color: '#fff', fontSize: 15, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ padding: '14px 18px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {docs.map((d, i) => {
            const isImage = /^image/i.test(d.type);
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 13, border: '1px solid #e2efec', borderRadius: 14, padding: '11px 13px', background: '#fbfdfd' }}>
                <span style={{ flex: '0 0 auto', width: 52, height: 52, borderRadius: 11, background: '#eef4f3', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {isImage && d.dataUrl
                    ? <img src={d.dataUrl} alt={d.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8aa8a3" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/></svg>
                  }
                </span>
                <span style={{ flex: 1, minWidth: 0, lineHeight: 1.35 }}>
                  <span style={{ display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#0e756c' }}>{d.kind || 'Other'}</span>
                  <span style={{ display: 'block', fontSize: 14, color: '#0e3b39', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
                  <span style={{ display: 'block', fontSize: 12, color: '#98b0ab' }}>{fileTypeLabel(d.type)}</span>
                </span>
                <a href={d.dataUrl || '#'} onClick={(ev) => onView(ev, d)} target="_blank" rel="noopener noreferrer"
                  style={{ flex: '0 0 auto', padding: '9px 14px', borderRadius: 10, border: '1px solid #cfe3df', background: '#f2f9f8', color: '#0e756c', fontWeight: 700, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 7, textDecoration: 'none', cursor: 'pointer' }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>
                  View
                </a>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function PatientDetail({ patient, patientId, onGoBack, onRenamePatient, clinicName, clinicAddress, doctorName, doctorQualification, rxTemplateUrl, hasDocxTemplate, hasReceiptTemplate }) {
  const [detailVisit, setDetailVisit] = useState(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState('');
  const [viewDoc, setViewDoc] = useState(null);
  const [filesVisit, setFilesVisit] = useState(null);

  if (!patient) return null;

  const cn = clinicName || '';
  const ca = clinicAddress || '';

  const p = patient;
  const sorted = p.visits.slice().sort((a, b) => (a.no || 0) - (b.no || 0));

  let totalCost = 0, totalPaid = 0, bal = 0;
  sorted.forEach((v) => {
    totalCost += num(v.clinical && v.clinical.treatmentCost);
    totalPaid += num(v.clinical && v.clinical.amountPaid);
    bal += num(v.clinical && v.clinical.treatmentCost) - num(v.clinical && v.clinical.amountPaid);
    if (bal < 0) bal = 0;
  });
  const outstanding = bal;

  let status;
  if (outstanding > 0 && totalPaid > 0) status = 'Partially paid';
  else if (outstanding > 0) status = 'Not paid';
  else status = 'Fully Paid';

  const [stBg, stInk] = PAY_MAP[status] || ['#eef4f3', '#8aa8a3'];
  const ageGender = (p.age || '?') + '/' + (p.gender || '—');

  const visitCards = sorted.slice().reverse().map((v) => {
    const nc = normalizeClinical(v.clinical || {});
    const tr = trLabel(nc) || '—';
    const cost = num(nc.treatmentCost);
    const balance = num(nc.balanceDue);
    const ps = nc.paymentStatus || '—';
    const [vBg, vInk] = PAY_MAP[ps] || ['#eef4f3', '#8aa8a3'];
    const hasMeds = (nc.medicines || []).some(m => m.name);
    const hasPaid = num(nc.amountPaid) > 0;
    const fileDocs = (nc.documents || []).filter(d => d.dataUrl || d.s3Key);
    const hasFiles = fileDocs.length > 0;
    const filesCount = fileDocs.length;
    return { visitId: v.visitId, dateLabel: fmtDate(v.date), treatmentLabel: tr, costLabel: cost ? inr(cost) : '—', balanceLabel: balance ? inr(balance) : '—', status: ps, stBg: vBg, stInk: vInk, visit: v, hasMeds, hasPaid, nc, hasFiles, filesCount };
  });

  function openRx(vc) {
    const meta = { dateLabel: vc.dateLabel, name: p.name, ageGender: (p.age || '?') + ' yrs · ' + (p.gender || '—'), mobile: p.mobile, patientId, visitId: vc.visitId };
    setViewDoc({ kind: 'rx', data: buildRx(vc.nc, meta) });
  }
  function openReceipt(vc) {
    const meta = { dateLabel: vc.dateLabel, name: p.name, mobile: p.mobile, patientId, visitId: vc.visitId, ageGender: `${p.age || ''}/${p.gender || ''}` };
    setViewDoc({ kind: 'receipt', data: buildReceipt(vc.nc, meta) });
  }

  const detail = detailVisit ? buildDetailRows(detailVisit, p) : null;

  async function saveName() {
    const next = nameDraft.trim();
    if (!next) { setNameError('Name cannot be empty.'); return; }
    if (next === (p.name || '')) { setEditingName(false); return; }
    setSavingName(true);
    setNameError('');
    try {
      await onRenamePatient(patientId, next);
      setEditingName(false);
    } catch (err) {
      // Surface the real reason rather than a generic failure.
      const m = String((err && err.message) || '').trim();
      setNameError(m ? (m.length > 140 ? m.slice(0, 140) + '…' : m) : 'Could not save the name. Please try again.');
    } finally {
      setSavingName(false);
    }
  }

  const chipStyle = { padding: '7px 13px', borderRadius: 9, border: '1px solid #cfe3df', background: '#f2f9f8', color: '#0e756c', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 };

  return (
    <div style={{ maxWidth: 840, margin: '0 auto' }}>
      <button onClick={onGoBack}
        style={{ border: 0, background: 'none', color: '#0e756c', fontWeight: 700, fontSize: 14, cursor: 'pointer', padding: 0, marginBottom: 12 }}>
        &larr; Back to patients
      </button>

      <div style={{
        background: 'linear-gradient(135deg,#0e756c,#0e3b39)', borderRadius: 18, padding: '22px 24px',
        color: '#fff', display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start',
      }}>
        <div style={{ minWidth: 0 }}>
          <span style={{ fontSize: 12, letterSpacing: '.14em', textTransform: 'uppercase', color: '#7fd4c9', fontWeight: 700 }}>Patient</span>
          {!editingName && (
            <h1 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 26, marginTop: 4, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {p.name}
              {onRenamePatient && (
                <button
                  type="button"
                  title="Edit patient name"
                  onClick={() => { setNameDraft(p.name || ''); setNameError(''); setEditingName(true); }}
                  style={{ width: 30, height: 30, flexShrink: 0, borderRadius: 8, border: '1px solid rgba(255,255,255,.35)', background: 'rgba(255,255,255,.14)', color: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              )}
            </h1>
          )}
          {editingName && (
            <div style={{ marginTop: 6 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  value={nameDraft}
                  onChange={(e) => { setNameDraft(e.target.value); setNameError(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false); }}
                  autoFocus
                  disabled={savingName}
                  placeholder="Patient name"
                  style={{ padding: '9px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,.4)', background: 'rgba(255,255,255,.15)', color: '#fff', fontSize: 18, fontWeight: 700, fontFamily: "'Bricolage Grotesque'", minWidth: 220, flex: '1 1 220px' }}
                />
                <button type="button" onClick={saveName} disabled={savingName}
                  style={{ padding: '9px 16px', borderRadius: 10, border: 0, background: '#fff', color: '#0e756c', fontWeight: 700, fontSize: 13.5, cursor: savingName ? 'default' : 'pointer', opacity: savingName ? 0.7 : 1 }}>
                  {savingName ? 'Saving…' : 'Save'}
                </button>
                <button type="button" onClick={() => { setEditingName(false); setNameError(''); }} disabled={savingName}
                  style={{ padding: '9px 14px', borderRadius: 10, border: '1px solid rgba(255,255,255,.35)', background: 'transparent', color: '#fff', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
              {!!nameError && <p style={{ color: '#ffd5cc', fontSize: 13, fontWeight: 600, marginTop: 6 }}>{nameError}</p>}
            </div>
          )}
          <p style={{ color: '#bfe3dd', fontSize: 14, marginTop: 2 }}>
            <span style={{ fontFamily: 'ui-monospace,monospace' }}>{patientId}</span> · {ageGender}
          </p>
          <p style={{ color: '#bfe3dd', fontSize: 14, marginTop: 2 }}>
            {p.mobile} · {p.visits.length} visit(s)
          </p>
          {!!p.address && (
            <p style={{ color: '#bfe3dd', fontSize: 13.5, marginTop: 4, maxWidth: 420, lineHeight: 1.45 }}>{p.address}</p>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end' }}>
          <span style={{ display: 'inline-block', padding: '5px 13px', borderRadius: 100, fontSize: 13, fontWeight: 700, background: stBg, color: stInk }}>{status}</span>
          <OptedOutPill mobile={p.mobile} />
          <a href={'tel:' + p.mobile} title="Call patient"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 16px', borderRadius: 10,
              background: 'rgba(255,255,255,.14)', border: '1px solid rgba(255,255,255,.35)',
              color: '#fff', fontWeight: 700, fontSize: 13.5, textDecoration: 'none',
            }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M6.62 10.79a15.53 15.53 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02l-2.2 2.2z" />
            </svg>
            Call
          </a>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginTop: 16 }}>
        <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 15, padding: '14px 16px' }}>
          <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#8aa8a3' }}>Total billed</span>
          <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 22, color: '#0e3b39', marginTop: 2 }}>{inr(totalCost)}</span>
        </div>
        <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 15, padding: '14px 16px' }}>
          <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#8aa8a3' }}>Paid</span>
          <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 22, color: '#12805a', marginTop: 2 }}>{inr(totalPaid)}</span>
        </div>
        <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 15, padding: '14px 16px' }}>
          <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#8aa8a3' }}>Pending</span>
          <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 22, color: '#c0392b', marginTop: 2 }}>{inr(outstanding)}</span>
        </div>
      </div>

      <PatientWhatsAppCard patientId={patientId} patientName={p.name} mobile={p.mobile} />

      <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, padding: '20px 22px', marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <h3 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 16, color: '#0e3b39' }}>Visit history</h3>
          <span style={{ fontSize: 12.5, color: '#98b0ab' }}>Latest first · tap for details</span>
        </div>
        {visitCards.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {visitCards.map((vc) => (
              <div key={vc.visitId} style={{ border: '1px solid #eef4f3', borderRadius: 12, background: '#fff', padding: '13px 15px' }}>
                <div onClick={() => setDetailVisit(vc.visit)}
                  style={{ textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 12, color: '#0e756c', fontWeight: 700 }}>{vc.visitId}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 100, fontSize: 11.5, fontWeight: 700, background: vc.stBg, color: vc.stInk }}>{vc.status}</span>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#98b0ab" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M9 6l6 6-6 6"/></svg>
                    </span>
                  </span>
                  <span style={{ fontSize: 14, color: '#33534f' }}>{vc.treatmentLabel}</span>
                  <span style={{ display: 'flex', flexWrap: 'wrap', columnGap: 14, fontSize: 12.5, color: '#5c7a76' }}>
                    {vc.dateLabel} · Cost {vc.costLabel} · Balance {vc.balanceLabel}
                  </span>
                </div>
                {(vc.hasMeds || vc.hasPaid || vc.hasFiles) && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 11, paddingTop: 11, borderTop: '1px solid #f0f6f5' }}>
                    {vc.hasMeds && (
                      <button onClick={() => openRx(vc)} style={chipStyle}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5M9 13h6M9 17h4"/></svg>
                        Prescription
                      </button>
                    )}
                    {vc.hasPaid && (
                      <button onClick={() => openReceipt(vc)} style={chipStyle}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2z"/><path d="M9 8h6M9 12h6"/></svg>
                        Payment receipt
                      </button>
                    )}
                    {vc.hasFiles && (
                      <button onClick={(e) => { e.stopPropagation(); setFilesVisit(vc.visit); }} style={chipStyle}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>
                        Documents ({vc.filesCount})
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: '#8aa8a3', fontSize: 14, textAlign: 'center', padding: '20px 0' }}>No visits recorded yet.</p>
        )}
      </div>

      {detailVisit && detail && (
        <div onClick={() => setDetailVisit(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(14,59,57,.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
          }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 20, maxWidth: 480, width: '100%', maxHeight: '82vh', overflow: 'auto' }}>
            <div style={{
              position: 'sticky', top: 0, background: '#0e3b39', color: '#fff',
              padding: '18px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              borderRadius: '20px 20px 0 0',
            }}>
              <div>
                <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 13, color: '#7fd4c9', fontWeight: 700 }}>{detailVisit.visitId}</span>
                <h3 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 17 }}>{p.name} · {fmtDate(detailVisit.date)}</h3>
              </div>
              <button onClick={() => setDetailVisit(null)}
                style={{ width: 32, height: 32, borderRadius: 8, border: 0, background: 'rgba(255,255,255,.15)', color: '#fff', fontSize: 16, cursor: 'pointer' }}>
                ✕
              </button>
            </div>
            <div style={{ padding: '8px 22px 22px' }}>
              {detail.rows.map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '11px 0', borderBottom: '1px solid #f0f6f5' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#8aa8a3', flex: '0 0 auto' }}>{r.k}</span>
                  <span style={{ fontSize: 14, color: '#33534f', textAlign: 'right' }}>{r.v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {filesVisit && <FilesPopup filesVisit={filesVisit} patient={p} onClose={() => setFilesVisit(null)} />}

      {viewDoc && viewDoc.kind === 'rx' && <PrescriptionSheet rx={viewDoc.data} onClose={() => setViewDoc(null)} clinicName={cn} clinicAddress={ca} doctorName={doctorName} doctorQualification={doctorQualification} rxTemplateUrl={rxTemplateUrl} hasDocxTemplate={hasDocxTemplate} />}
      {viewDoc && viewDoc.kind === 'receipt' && <ReceiptSheet receipt={viewDoc.data} onClose={() => setViewDoc(null)} clinicName={cn} clinicAddress={ca} doctorName={doctorName} hasReceiptTemplate={hasReceiptTemplate} />}
    </div>
  );
}
