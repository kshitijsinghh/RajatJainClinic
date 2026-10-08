import { useState, useRef, useEffect } from 'react';
import {
  CHIEF_COMPLAINTS, TREATMENT_GROUPS, TREATMENTS, TOOTH_NUMBERS, TOOTH_NUMBERS_KID, PAYMENT_MODES, YES_NO, TREATMENT_STAGES,
  MEDICINE_FORMS, FOOD_OPTIONS, DOC_KINDS, SPLIT_CATEGORIES, FDI_QUADRANTS, FDI_PRIMARY_QUADRANTS,
} from '../options';
import { TOUCH_BTN, FLUID_GRID_2COL } from '../styles';
import { getUploadUrl, uploadToS3, getDocumentUrl, generatePrescriptionPdf, generateReceiptPdf, savePayment, getClinicId, logEvent } from '../api';
import { DocPopupHeader, PhoneActionBar, SendStrip, useDocSend } from '../whatsapp/DocSend';
import NextAppointmentNotice from '../whatsapp/NextAppointmentNotice';
import { useIsPhone } from '../whatsapp/ui';
import { anyHealthDetails, hasRealAllergy, healthRows } from '../health';

// Rasterize a server-generated HTML document (fetched from its URL) into a jsPDF instance.
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

// Capture an already-rendered on-screen element to a PDF (used when there is no
// server-generated docx/pdf URL — the inline HTML prescription/receipt).
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

// Saves the server's file as it stands. The anchor's download attribute is
// ignored cross-origin, so the bytes go through a blob — which the browser
// does honour.
async function saveUrlAsFile(url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not fetch the document (' + res.status + ')');
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}

// `format` is what /generate-pdf reported. Once LibreOffice was in place the
// server started returning real PDFs, and rasterizing one of those re-renders
// the file's own bytes as text: renderUrlToPdf reads the body with
// res.text(), so "%PDF-1.5…" went into innerHTML and html2canvas dutifully
// photographed it over fifteen pages. A PDF is saved as-is; only the HTML
// fallback still needs rasterizing.
async function downloadAsPdf(url, filename, format) {
  try {
    if (format === 'pdf') { await saveUrlAsFile(url, filename); return; }
    const pdf = await renderUrlToPdf(url);
    pdf.save(filename);
  } catch (e) {
    // Never fail silently — a dead-looking button is worse than a fallback.
    console.error('PDF download failed:', e);
    window.open(url, '_blank');
    alert('Could not build the PDF automatically, so the document was opened in a new tab.\nUse your browser’s Print → "Save as PDF" from there.');
  }
}

// Print a server-generated document by converting it to a real PDF first — networked
// MFP printers reliably print PDFs but often error on browser HTML print jobs.
async function printAsPdf(url, format) {
  // Open the tab synchronously inside the click gesture so it isn't popup-blocked.
  const win = window.open('', '_blank');
  try {
    if (format === 'pdf') {
      // Already a PDF: hand the browser's own viewer the real file rather
      // than a screenshot of it.
      const res = await fetch(url);
      if (!res.ok) throw new Error('Could not fetch the document (' + res.status + ')');
      const blobUrl = URL.createObjectURL(await res.blob());
      if (win) win.location.href = blobUrl;
      else window.open(blobUrl, '_blank');
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      return;
    }
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

// The document used to come back as HTML and the iframe showed the page
// itself. Now that the backend produces a real PDF, the browser wraps it in
// its own viewer — a grey toolbar, a zoom box and a thumbnail rail over what
// should just look like the receipt. These fragment parameters turn that
// furniture off and fit the page to the width of the pop-up. They are a
// fragment, so they never reach S3 and cannot disturb the signed URL.
export function previewSrc(url, format) {
  if (!url) return url;
  return format === 'pdf' ? url + '#toolbar=0&navpanes=0&scrollbar=0&view=FitH' : url;
}

// Capitalise the first letter of each word, leaving the rest of the word as typed
// ("zerodol p" -> "Zerodol P", "500mg" stays "500mg", "ZERODOL" stays "ZERODOL").
function titleCase(s) {
  return String(s == null ? '' : s).replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const fieldStyle = {
  width: '100%', minHeight: 44, padding: '12px 14px', border: '1px solid #d6e7e3', borderRadius: 10,
  fontSize: 15, background: '#f7fbfa',
};
const labelStyle = { display: 'block', fontWeight: 700, fontSize: 13.5, marginBottom: 7 };
const h3Style = { fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 16, color: '#0e3b39' };
const roStyle = { opacity: 0.7, background: '#f0f4f3', cursor: 'default' };

function num(x) { const n = parseFloat(x); return isNaN(n) ? 0 : n; }

/* ── MultiSelect ── */
// Switching between the Clinical and Billing steps swaps the page content but
// leaves the window scrolled where it was, so the doctor lands halfway down the
// new step. Reset it.
function scrollToTop() {
  try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch { window.scrollTo(0, 0); }
}

function MultiSelect({ value, options, onChange, placeholder, disabled, allowOther, searchable }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const arr = Array.isArray(value) ? value : (value ? String(value).split(', ').filter(Boolean) : []);
  const stdOptions = allowOther ? options.filter((o) => o !== 'Other') : options;
  const stdSelected = arr.filter((t) => stdOptions.includes(t));

  // Free-text entries are simply array items that are not one of the preset
  // options — the stored shape already supports any number of them. They are
  // held in local state while being typed so a half-typed entry never reaches
  // the record, and an empty row can exist in the UI without creating a blank
  // chip.
  const customsFromValue = allowOther ? arr.filter((t) => !stdOptions.includes(t)) : [];
  const [drafts, setDrafts] = useState(customsFromValue);

  // Resync when the value changes from outside (a different visit is loaded).
  // Skipped when our own edit produced the change, so typing is not clobbered.
  const externalKey = customsFromValue.join('\u0000');
  const draftKey = drafts.filter((d) => d.trim()).join('\u0000');
  useEffect(() => {
    if (externalKey !== draftKey) setDrafts(customsFromValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalKey]);

  const displayChips = allowOther ? [...stdSelected, ...drafts.filter((d) => d.trim())] : arr;

  function emit(std, nextDrafts) {
    onChange([...std, ...nextDrafts.filter((d) => d.trim())]);
  }
  function setDrafted(next) { setDrafts(next); emit(stdSelected, next); }
  function addOther() { setDrafts([...drafts, '']); }
  function setOtherAt(i, text) { setDrafted(drafts.map((d, x) => (x === i ? text : d))); }
  function removeOtherAt(i) { setDrafted(drafts.filter((_, x) => x !== i)); }

  function toggle(opt) {
    const base = allowOther ? stdSelected : arr;
    const next = base.includes(opt) ? base.filter((s) => s !== opt) : [...base, opt];
    if (allowOther) emit(next, drafts); else onChange(next);
  }
  function removeChip(chip) {
    if (allowOther && !stdOptions.includes(chip)) {
      const i = drafts.findIndex((d) => d === chip);
      if (i >= 0) removeOtherAt(i);
      return;
    }
    toggle(chip);
  }
  const filtered = searchable && search ? stdOptions.filter((o) => o.toLowerCase().includes(search.toLowerCase())) : stdOptions;
  const checkBox = (on) => (
    <span style={{ width: 18, height: 18, borderRadius: 4, border: '2px solid ' + (on ? '#12a094' : '#d6e7e3'), background: on ? '#12a094' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      {on && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>}
    </span>
  );
  return (
    <div style={{ position: 'relative' }}>
      <div onClick={() => { if (!disabled) { if (open) setSearch(''); setOpen(!open); } }}
        style={{ ...fieldStyle, display: 'flex', flexWrap: 'wrap', gap: 6, cursor: disabled ? 'default' : 'pointer', alignItems: 'center', minHeight: 44, paddingRight: 32, opacity: disabled ? 0.7 : 1, background: disabled ? '#f0f4f3' : fieldStyle.background, position: 'relative' }}>
        {displayChips.length === 0 && <span style={{ color: '#98b0ab', flex: 1 }}>{placeholder || 'Select…'}</span>}
        {displayChips.map((s) => (
          <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 100, background: '#e0f0ed', fontSize: 13, fontWeight: 600, color: '#0e756c' }}>
            {s}
            {!disabled && <span onClick={(e) => { e.stopPropagation(); removeChip(s); }} style={{ cursor: 'pointer', fontSize: 15, lineHeight: 1, color: '#5c7a76', marginLeft: 2 }}>&times;</span>}
          </span>
        ))}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8aa8a3" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><path d="M6 9l6 6 6-6" /></svg>
      </div>
      {open && !disabled && (
        <>
          <div onClick={() => { setOpen(false); setSearch(''); }} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, maxHeight: 260, overflowY: 'auto', background: '#fff', border: '1px solid #d6e7e3', borderRadius: 10, marginTop: 4, boxShadow: '0 8px 24px rgba(14,59,57,.12)' }}>
            {searchable && (
              <div style={{ padding: '8px 10px', borderBottom: '1px solid #eef4f3', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                <input value={search} onChange={(e) => setSearch(e.target.value)} onClick={(e) => e.stopPropagation()} placeholder="Search…" autoFocus style={{ width: '100%', padding: '8px 10px', border: '1px solid #d6e7e3', borderRadius: 8, fontSize: 14, background: '#f7fbfa' }} />
              </div>
            )}
            {filtered.map((opt) => {
              const on = stdSelected.includes(opt);
              return (
                <div key={opt} onClick={() => toggle(opt)} style={{ padding: '10px 14px', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', gap: 10, background: on ? '#eef7f6' : '#fff', borderBottom: '1px solid #f0f6f5' }}>
                  {checkBox(on)}
                  <span style={{ color: on ? '#0e3b39' : '#5c7a76', fontWeight: on ? 600 : 400 }}>{opt}</span>
                </div>
              );
            })}
            {allowOther && (!search || 'other'.includes(search.toLowerCase())) && (
              <div style={{ background: '#eef7f6', borderTop: '1px solid #e2efec' }}>
                {drafts.map((d, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px' }}>
                    <input
                      value={d}
                      onChange={(e) => setOtherAt(i, e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      placeholder="Type here…"
                      autoFocus={i === drafts.length - 1 && d === ''}
                      style={{ flex: 1, padding: '8px 10px', border: '1px solid #d6e7e3', borderRadius: 8, fontSize: 14, background: '#fff' }}
                    />
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeOtherAt(i); }}
                      title="Remove"
                      style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 8, border: '1px solid #f0d9d3', background: '#fdf0ec', color: '#c0392b', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}
                    >&times;</button>
                  </div>
                ))}
                <div
                  onClick={(e) => { e.stopPropagation(); addOther(); }}
                  style={{ padding: '10px 14px', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8, color: '#0e756c', fontWeight: 700 }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                  Add Other
                </div>
              </div>
            )}
            {searchable && search && filtered.length === 0 && <div style={{ padding: 14, color: '#98b0ab', fontSize: 14, textAlign: 'center' }}>No matches</div>}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Tooth picker modal: quadrant-grouped FDI chart over a dimmed backdrop ── */
function ToothPickerModal({ title, selected, onToggle, onClose }) {
  const [showPrimary, setShowPrimary] = useState(false);
  const quadrant = (q, keyPrefix) => (
    <div key={keyPrefix + q.label}>
      <span style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#a9c1bc', paddingBottom: 5, textAlign: q.align === 'flex-end' ? 'right' : 'left' }}>{q.label}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: q.align }}>
        {q.list.map((t) => {
          const on = selected.includes(t);
          return (
            <button key={t} type="button" onClick={() => onToggle(t)} style={{ width: 30, padding: '6px 0', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 700, border: '1px solid ' + (on ? '#0e756c' : '#dfece9'), background: on ? '#0e756c' : '#fff', color: on ? '#fff' : '#5c7a76' }}>{t}</button>
          );
        })}
      </div>
    </div>
  );
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(14,59,57,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(360px,92vw)', maxHeight: '82vh', overflow: 'auto', background: '#fff', border: '1px solid #dfece9', borderRadius: 16, boxShadow: '0 26px 60px -18px rgba(14,59,57,.5)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '13px 16px', borderBottom: '1px solid #eef4f3', position: 'sticky', top: 0, background: '#fff' }}>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: '#a9c1bc' }}>Select teeth</span>
            <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 15, color: '#0e3b39', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
          </span>
          <button type="button" onClick={onClose} title="Close" style={{ flexShrink: 0, width: 30, height: 30, borderRadius: 8, border: '1px solid #e2efec', background: '#f7fbfa', color: '#5c7a76', fontSize: 14, cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: '14px 16px 16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 12px' }}>
            {FDI_QUADRANTS.map((q) => quadrant(q, 'p'))}
          </div>
          <button type="button" onClick={() => setShowPrimary((v) => !v)} style={{ marginTop: 12, border: 0, background: 'none', padding: 0, color: '#0e756c', fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}>
            {showPrimary ? 'Hide primary (milk) teeth' : 'Show primary (milk) teeth'}
          </button>
          {showPrimary && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 12px', marginTop: 10, paddingTop: 12, borderTop: '1px solid #eef4f3' }}>
              {FDI_PRIMARY_QUADRANTS.map((q) => quadrant(q, 'k'))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── "Tooth number — per treatment": one row per selected treatment ── */
function ToothTagBlock({ cform, listField, mapField, emptyCopy, onChange, readOnly }) {
  const [openFor, setOpenFor] = useState('');
  const list = asList(cform[listField]);
  const map = cform[mapField] || {};

  const nameOf = (t) => (/Other/.test(t) && cform.treatmentOther ? cform.treatmentOther : t);

  function toggleTooth(tr, tooth) {
    const cur = asList(map[tr]);
    const next = { ...map, [tr]: cur.includes(tooth) ? cur.filter((x) => x !== tooth) : [...cur, tooth].sort() };
    onChange(next);
  }
  function applyToAll(sourceTr) {
    const teeth = asList(map[sourceTr]);
    const next = { ...map };
    list.forEach((t) => { next[t] = [...teeth]; });
    onChange(next);
  }

  if (!list.length) {
    return <p style={{ fontSize: 13.5, color: '#98b0ab', background: '#f7fbfa', border: '1px dashed #d6e7e3', borderRadius: 12, padding: '13px 15px' }}>{emptyCopy}</p>;
  }

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {list.map((tr, trIndex) => {
          const teeth = asList(map[tr]);
          const btnLabel = teeth.length ? (teeth.length === 1 ? '1 tooth' : teeth.length + ' teeth') : 'Tag teeth';
          const canApplyAll = trIndex === 0 && teeth.length > 0 && list.length > 1;
          return (
            <div key={tr} style={{ border: '1px solid #e2efec', borderRadius: 13, background: '#fbfdfd', padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, color: '#0e3b39', fontSize: 14.5 }}>{nameOf(tr)}</span>
                <button type="button" disabled={readOnly} onClick={() => setOpenFor(tr)} style={{ padding: '8px 13px', border: '1px solid #cfe3df', borderRadius: 9, fontSize: 13.5, background: '#fff', cursor: readOnly ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: 8, color: '#0e756c', fontWeight: 700 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                  {btnLabel}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8aa8a3" strokeWidth="2.4" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
                </button>
              </div>
              {teeth.length > 0 ? (
                <>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                    {teeth.map((t) => (
                      <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 100, background: '#e6f4f2', color: '#0e756c', fontWeight: 700, fontSize: 12.5 }}>
                        {t}
                        <button type="button" disabled={readOnly} onClick={() => toggleTooth(tr, t)} title="Remove" style={{ border: 0, background: 'none', padding: 0, color: '#0e756c', cursor: readOnly ? 'default' : 'pointer', fontSize: 12, lineHeight: 1 }}>✕</button>
                      </span>
                    ))}
                  </div>
                  {canApplyAll && !readOnly && (
                    <button type="button" onClick={() => applyToAll(tr)} style={{ marginTop: 9, border: 0, background: 'none', padding: 0, color: '#0e756c', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 4h10a2 2 0 0 1 2 2v10" /><rect x="4" y="8" width="12" height="12" rx="2" /></svg>
                      Apply these teeth to all treatments
                    </button>
                  )}
                </>
              ) : (
                <p style={{ fontSize: 12.5, color: '#a9c1bc', marginTop: 8 }}>No teeth tagged yet.</p>
              )}
            </div>
          );
        })}
      </div>
      <p style={{ fontSize: 12.5, color: '#98b0ab', marginTop: 8 }}>
        Prints on the prescription as <strong style={{ color: '#5c7a76' }}>{teethMapLabel(cform, listField, mapField)}</strong>
      </p>
      {openFor && (
        <ToothPickerModal
          title={nameOf(openFor)}
          selected={asList(map[openFor])}
          onToggle={(t) => toggleTooth(openFor, t)}
          onClose={() => setOpenFor('')}
        />
      )}
    </>
  );
}

function TimePicker12h({ value, onChange, disabled }) {
  let hr = '', min = '', ap = 'AM';
  if (value) {
    const m = value.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (m) { hr = m[1]; min = m[2]; ap = m[3].toUpperCase(); }
  }
  const build = (h, m, a) => h ? h + ':' + (m || '00').padStart(2, '0') + ' ' + a : '';
  const hours = Array.from({ length: 12 }, (_, i) => String(i + 1));
  const mins = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));
  const selStyle = { ...fieldStyle, flex: 1, minWidth: 0, ...(disabled ? roStyle : {}) };
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <select value={hr} onChange={(e) => onChange(build(e.target.value, min, ap))} style={selStyle} disabled={disabled}><option value="">Hr</option>{hours.map((h) => <option key={h} value={h}>{h}</option>)}</select>
      <select value={min} onChange={(e) => onChange(build(hr, e.target.value, ap))} style={selStyle} disabled={disabled}><option value="">Min</option>{mins.map((m) => <option key={m} value={m}>{m}</option>)}</select>
      <select value={ap} onChange={(e) => onChange(build(hr, min, e.target.value))} style={selStyle} disabled={disabled}><option value="AM">AM</option><option value="PM">PM</option></select>
    </div>
  );
}

function inr(n) { return '₹' + Math.round(n).toLocaleString('en-IN'); }
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return d; }
}
function fmtTime(t) {
  if (!t) return '—';
  if (/AM|PM/i.test(t)) return t;
  const [h, m] = t.split(':').map(Number);
  if (isNaN(h)) return '—';
  return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
}
function dash(x) { return (x === undefined || x === null || x === '') ? '—' : x; }
function listLabel(v, fallback) {
  if (Array.isArray(v)) return v.length ? v.join(', ') : (fallback || '—');
  return v || fallback || '—';
}
// Like listLabel but yields '' (never '—') when empty — used by the prescription,
// which omits a field entirely rather than printing a placeholder dash.
function listPlain(v) {
  if (Array.isArray(v)) return v.join(', ');
  return v || '';
}
function trLabel(c) {
  if (!c) return '';
  const t = Array.isArray(c.treatment) ? c.treatment : (c.treatment ? [c.treatment] : []);
  const hasOther = t.some(x => /Other/.test(x));
  if (hasOther && c.treatmentOther) return [...t.filter(x => !/Other/.test(x)), c.treatmentOther].join(', ');
  return t.join(', ');
}

/* ── Per-treatment tooth tagging ── */
function asList(x) { return Array.isArray(x) ? x : (x ? [x] : []); }

// "RCT: 11, 12 · Scaling & Polishing: 21" — a treatment with no teeth tagged
// prints as just its name. "Other" prints the treatmentOther text instead.
function teethMapLabel(c, listField, mapField) {
  if (!c) return '';
  const map = c[mapField] || {};
  return asList(c[listField]).map((t) => {
    const name = /Other/.test(t) && c.treatmentOther ? c.treatmentOther : t;
    const teeth = asList(map[t]);
    return teeth.length ? name + ': ' + teeth.join(', ') : name;
  }).join(' · ');
}
function trTeethLabel(c) { return teethMapLabel(c, 'treatment', 'treatmentTeeth'); }


// What the patient filled in at check-in, shown read-only above the doctor's
// own fields. Exported so the allergy alert — the one piece of this screen
// that changes what may safely be prescribed — can be rendered in a test.
export function PatientHealthPanel({ cform }) {
  const c = cform || {};
  if (!anyHealthDetails(c)) return null;
  return (
    <div style={{ background: '#f2f9f8', border: '1px solid #cfe3df', borderRadius: 12, padding: '13px 15px', marginBottom: 16 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#0e756c' }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.3-.6L3 21l1.7-5a8.4 8.4 0 0 1-.7-3.5A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg>
        Filled in by the patient at check-in
      </span>

      {/* First, and in red, because it is the one line that changes what the
          doctor may safely prescribe. */}
      {hasRealAllergy(c.patientAllergies) && (
        <div style={{ marginTop: 10, background: '#fdecea', border: '1px solid #f3c3bd', borderRadius: 10, padding: '9px 12px', display: 'flex', gap: 9, alignItems: 'flex-start' }}>
          <span style={{ flexShrink: 0, width: 20, height: 20, borderRadius: '50%', background: '#b3261e', color: '#fff', fontWeight: 700, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>!</span>
          <span style={{ fontSize: 14, color: '#7a1712' }}><strong>Allergy:</strong> {c.patientAllergies}</span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px 18px', marginTop: 10 }}>
        {healthRows(c, { skipRealAllergy: true }).map((r) => (
          <div key={r.k}>
            <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: '#5c7a76' }}>{r.k}</span>
            <span style={{ display: 'block', fontSize: 14.5, color: '#0e3b39', textWrap: 'pretty' }}>{r.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}


// One payment-split line per treatment marked in the Doctor's form, named like
// "RCT (32, 21)" — or just "Composite Restoration" when no teeth are tagged.
// Custom lines carry the name as-is, so the receipt prints it unchanged.
function treatmentSplitLines(c) {
  const map = (c && c.treatmentTeeth) || {};
  return asList(c && c.treatment).map((t) => {
    const name = /Other/.test(t) && c.treatmentOther ? c.treatmentOther : t;
    const teeth = asList(map[t]);
    return { category: 'Custom', custom: teeth.length ? name + ' (' + teeth.join(', ') + ')' : name, amount: '' };
  });
}
function advTeethLabel(c) { return teethMapLabel(c, 'advisedTreatment', 'advisedTeeth'); }

// toothNumber is no longer edited directly — it is the sorted union of every
// tooth tagged under treatmentTeeth, which keeps Lab Requirements auto-population
// working off a single field as before.
function deriveToothNumber(treatment, treatmentTeeth) {
  const union = [];
  asList(treatment).forEach((t) => {
    asList((treatmentTeeth || {})[t]).forEach((x) => { if (!union.includes(x)) union.push(x); });
  });
  return union.sort();
}

/* ── Medicine helpers ── */
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
  return '(Tot: ' + (per * d) + ' ' + m.unit + ')';
}

/* ── Shared builders (prescription & receipt) ── */
function buildRx(cf, meta) {
  return {
    dateLabel: meta.dateLabel, name: meta.name, ageGender: meta.ageGender, mobile: meta.mobile,
    patientId: meta.patientId, visitId: meta.visitId,
    // Empty fields are sent as '' (not '—') so the prescription can omit them entirely.
    medicalHistory: cf.medicalHistory || '',
    chiefComplaint: listPlain(cf.chiefComplaint),
    description: cf.chiefDescription || '',
    diagnosis: cf.diagnosis || '',
    investigation: cf.investigation || '',
    treatmentGroup: listPlain(cf.treatmentGroup),
    // Prefer the per-treatment tooth labels ("RCT: 11, 12 · Scaling: 21"); fall
    // back to the plain treatment list for records saved before tooth tagging.
    treatment: trTeethLabel(cf) || trLabel(cf) || '',
    advisedTreatment: advTeethLabel(cf) || listPlain(cf.advisedTreatment),
    toothNumber: listPlain(cf.toothNumber),
    meds: (cf.medicines || []).filter(m => m.name).map((m, i) => ({
      sn: i + 1, name: m.name, unit: m.unit, dose: medDoseText(m),
      food: m.food, duration: m.duration ? (m.duration + ' days') : '—', total: medTotal(m),
      remarks: m.remarks || '',
    })),
    // Drives the optional Remarks column — hidden entirely when no medicine has any.
    anyRemarks: (cf.medicines || []).some(m => m.name && m.remarks),
    hasMeds: (cf.medicines || []).some(m => m.name),
    noMeds: !(cf.medicines || []).some(m => m.name),
    comments: cf.comments || '',
  };
}

function splitLabel(sp) { return sp.category === 'Custom' ? (sp.custom || 'Custom') : sp.category; }

function linesFor(cf) {
  const splits = (cf.paySplits || []).filter(sp => splitLabel(sp) && num(sp.amount) > 0);
  if (splits.length) return splits.map(sp => ({ label: splitLabel(sp), amount: num(sp.amount) }));
  const fallback = trLabel(cf) || listLabel(cf.treatmentGroup, '');
  if (!fallback) return null;
  return [{ label: fallback, amount: num(cf.amountPaid) }];
}

function buildReceipt(cf, meta) {
  const lines = linesFor(cf) || [];
  const total = lines.reduce((s, l) => s + l.amount, 0);
  const bal = num(cf.balanceDue !== undefined && cf.balanceDue !== '' ? cf.balanceDue : (num(cf.treatmentCost) - num(cf.amountPaid)));
  const clinicId = getClinicId();
  const receiptNo = clinicId ? (clinicId + '_' + (meta.visitId || '')) : ('R-' + (meta.visitId || ''));
  const paySplits = (cf.paySplits || []).filter(sp => splitLabel(sp) && num(sp.amount) > 0)
    .map(sp => ({ category: sp.category, custom: sp.custom || '', amount: num(sp.amount) }));
  if (!paySplits.length && lines.length) {
    lines.forEach(l => paySplits.push({ category: l.label, custom: '', amount: l.amount }));
  }
  return {
    lines: lines.map((l, i) => ({ sn: i + 1, label: l.label, amountLabel: inr(l.amount) })),
    totalLabel: inr(total), balanceLabel: inr(bal), balanceColor: bal > 0 ? '#c0392b' : '#12805a',
    mode: cf.paymentMode || '—', status: cf.paymentStatus || '—',
    receiptNo, dateLabel: meta.dateLabel,
    name: meta.name, mobile: meta.mobile, patientId: meta.patientId,
    visitId: meta.visitId, ageSex: meta.ageGender || '',
    treatmentCost: String(num(cf.treatmentCost)), amountPaid: String(num(cf.amountPaid)),
    balanceDue: String(bal), paySplits,
  };
}

/* ── Print-ready Prescription sheet ── */
// Download turns a server document (or the on-screen sheet) into a PDF via
// html2canvas + jsPDF, which takes a few seconds on a large prescription. The
// button gave no feedback at all, so doctors clicked it repeatedly.
function DownloadButton({ onDownload, label }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  async function go() {
    if (busy) return;
    setBusy(true);
    setFailed('');
    try {
      await onDownload();
    } catch (err) {
      setFailed(String((err && err.message) || 'Download failed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {/* Outside the button: a <style> child would land in its textContent and
          pollute the accessible name. */}
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    <button
      onClick={go}
      disabled={busy}
      title={failed || undefined}
      style={{
        padding: '8px 15px', borderRadius: 9, border: 0,
        background: busy ? '#0b7a72' : (failed ? '#c0392b' : '#12a094'),
        color: '#fff', fontWeight: 700, fontSize: 13,
        cursor: busy ? 'progress' : 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 104, justifyContent: 'center',
      }}
    >
      {busy && (
        <span style={{
          width: 13, height: 13, borderRadius: '50%', flexShrink: 0,
          border: '2px solid rgba(255,255,255,.45)', borderTopColor: '#fff',
          animation: 'spin .7s linear infinite',
        }} />
      )}
      {busy ? 'Preparing…' : (failed ? 'Retry download' : (label || 'Download'))}
    </button>
    </>
  );
}

function PrescriptionSheet({ rx, onClose, clinicName, clinicAddress, doctorName, doctorQualification, rxTemplateUrl, hasDocxTemplate }) {
  const hasImageTemplate = !!rxTemplateUrl && !hasDocxTemplate;
  const isPhone = useIsPhone();
  const waPatient = { patientId: rx.patientId, name: rx.name, mobile: rx.mobile };
  const [docxUrl, setDocxUrl] = useState(null);
  const [docxLoading, setDocxLoading] = useState(false);
  const [docxError, setDocxError] = useState(null);
  const [docxFormat, setDocxFormat] = useState(null);

  // Must come AFTER docxUrl is declared: `const` is in the temporal dead
  // zone until its own line, so reading it above threw on every render and
  // took the whole pop-up down with it.
  //
  // docVersion is the visit id plus the date on the document: re-opening the
  // same prescription re-uses the key and cannot send twice, while a genuinely
  // re-issued one gets a new key and can.
  const waSend = useDocSend({
    useCase: 'EPRESCRIPTION',
    patient: waPatient,
    visitId: rx.visitId,
    docVersion: rx.dateLabel || '1',
    params: { issue_date: rx.dateLabel || '' },
    // The template has a document header, so the server needs the generated
    // file to upload to Meta. Until docxUrl exists there is nothing to send.
    documentUrl: docxUrl,
  });

  useEffect(() => {
    if (!hasDocxTemplate) return;
    setDocxLoading(true);
    const visitData = {
      patientName: rx.name, age_sex: rx.ageGender, mobile: rx.mobile,
      date: rx.dateLabel, visitId: rx.visitId,
      chiefComplaint: rx.chiefComplaint, description: rx.description,
      diagnosis: rx.diagnosis, investigation: rx.investigation,
      treatmentGroup: rx.treatmentGroup, toothNumber: rx.toothNumber,
      treatment: rx.treatment, advisedTreatment: rx.advisedTreatment,
      medicalHistory: rx.medicalHistory,
      comments: rx.comments,
      medicines: (rx.meds || []).map(m => ({ name: m.name, unit: m.unit, dose: m.dose, food: m.food, duration: m.duration, remarks: m.remarks })),
    };
    generatePrescriptionPdf(visitData)
      .then(res => { setDocxUrl(res.url); setDocxFormat(res.format); })
      .catch(err => setDocxError(err.message))
      .finally(() => setDocxLoading(false));
  }, [hasDocxTemplate]);

  return (
    <div id="rx-overlay" style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(14,59,57,.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 20, overflow: 'auto' }}>
      <div id="rx-sheet" onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 18, width: '100%', maxWidth: 720, overflow: 'hidden', margin: 'auto' }}>
        <DocPopupHeader
          title="E-Prescription"
          send={waSend}
          patient={waPatient}
          phone={isPhone}
          onPrint={hasDocxTemplate ? (docxUrl ? () => printAsPdf(docxUrl, docxFormat) : null) : () => window.print()}
          onDownload={hasDocxTemplate
            ? (docxUrl ? () => downloadAsPdf(docxUrl, `Prescription_${rx.visitId || 'doc'}.pdf`, docxFormat) : null)
            : () => downloadElementAsPdf('rx-print-body', `Prescription_${rx.visitId || 'doc'}.pdf`)}
          onClose={onClose}
          fallback={<>
            {hasDocxTemplate && docxUrl && (
              <button onClick={() => printAsPdf(docxUrl, docxFormat)} style={{ padding: '8px 15px', borderRadius: 9, border: '1px solid rgba(255,255,255,.3)', background: 'transparent', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Print</button>
            )}
            {hasDocxTemplate && docxUrl && (
              <DownloadButton onDownload={() => downloadAsPdf(docxUrl, `Prescription_${rx.visitId || 'doc'}.pdf`, docxFormat)} />
            )}
            {!hasDocxTemplate && (
              <button onClick={() => window.print()} style={{ padding: '8px 15px', borderRadius: 9, border: '1px solid rgba(255,255,255,.3)', background: 'transparent', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Print</button>
            )}
            {!hasDocxTemplate && (
              <DownloadButton onDownload={() => downloadElementAsPdf('rx-print-body', `Prescription_${rx.visitId || 'doc'}.pdf`)} />
            )}
          </>}
        />
        <SendStrip send={waSend} patient={waPatient} />

        {/* DOCX template mode — show generated document in iframe */}
        {hasDocxTemplate && (
          <div style={{ minHeight: 400 }}>
            {docxLoading && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 60, gap: 16 }}>
                <div style={{ width: 36, height: 36, border: '3px solid #e2efec', borderTopColor: '#12a094', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                <span style={{ color: '#5c7a76', fontSize: 14 }}>Generating prescription...</span>
                <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
              </div>
            )}
            {docxError && (
              <div style={{ padding: 40, textAlign: 'center', color: '#c0392b', fontSize: 14 }}>
                <p>Failed to generate prescription</p>
                <p style={{ fontSize: 12, color: '#888', marginTop: 8 }}>{docxError}</p>
              </div>
            )}
            {docxUrl && (docxFormat === 'pdf' || docxFormat === 'html') && (
              <iframe id="rx-iframe" src={previewSrc(docxUrl, docxFormat)} style={{ width: '100%', height: 700, border: 'none' }} title="Prescription" />
            )}
            {docxUrl && docxFormat === 'docx' && (
              <div style={{ padding: 40, textAlign: 'center' }}>
                <p style={{ color: '#0e3b39', fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Prescription generated successfully</p>
                <p style={{ color: '#5c7a76', fontSize: 13, marginBottom: 20 }}>PDF conversion not available. Download the file to view and print.</p>
                <a href={docxUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', padding: '12px 28px', borderRadius: 10, background: '#12a094', color: '#fff', fontWeight: 700, fontSize: 14, textDecoration: 'none' }}>Download Prescription</a>
              </div>
            )}
          </div>
        )}

        {/* Image template or no template — existing rendering */}
        {!hasDocxTemplate && (
        <div id="rx-print-body" style={{ position: 'relative', background: '#fff' }}>
          {hasImageTemplate && <img src={rxTemplateUrl} alt="" style={{ width: '100%', display: 'block' }} />}
          {hasImageTemplate && (
            <div style={{ position: 'absolute', top: '29%', left: '62%', right: '3%', fontSize: 11, color: '#111', fontWeight: 600, lineHeight: 2.1 }}>
              <div>{rx.name}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{rx.ageGender}</span>
                <span>{rx.dateLabel}</span>
              </div>
              <div>{rx.mobile}</div>
            </div>
          )}
          <div style={hasImageTemplate
            ? { position: 'absolute', top: '46%', left: '4%', right: '4%', bottom: '10%', overflow: 'hidden' }
            : { padding: '26px 28px 30px' }
          }>
            {!hasImageTemplate && (
              <>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, borderBottom: '2px solid #0e756c', paddingBottom: 14, flexWrap: 'wrap' }}>
                  <div>
                    <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 20, color: '#0e3b39' }}>{clinicName}</span>
                    <span style={{ display: 'block', fontSize: 12, color: '#5c7a76', marginTop: 2 }}>{clinicAddress}</span>
                  </div>
                  <span style={{ flexShrink: 0, textAlign: 'right', fontSize: 12, color: '#5c7a76', lineHeight: 1.5 }}>
                    <span style={{ display: 'block' }}>Date: <strong style={{ color: '#0e3b39' }}>{rx.dateLabel}</strong></span>
                    <span style={{ display: 'block', fontFamily: 'ui-monospace,monospace' }}>{rx.visitId}</span>
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: '10px 22px', marginTop: 16, fontSize: 13.5 }}>
                  <span style={{ color: '#5c7a76' }}>Patient: <strong style={{ color: '#0e3b39' }}>{rx.name}</strong></span>
                  <span style={{ color: '#5c7a76' }}>Age / Gender: <strong style={{ color: '#0e3b39' }}>{rx.ageGender}</strong></span>
                  <span style={{ color: '#5c7a76' }}>Mobile: <strong style={{ color: '#0e3b39' }}>{rx.mobile}</strong></span>
                  {!!rx.medicalHistory && <span style={{ color: '#5c7a76' }}>Medical history: <strong style={{ color: '#0e3b39' }}>{rx.medicalHistory}</strong></span>}
                </div>
                <div style={{ marginTop: 18, padding: '14px 16px', borderRadius: 12, background: '#f7fbfa', border: '1px solid #e2efec', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: '10px 22px', fontSize: 13.5 }}>
                  {!!rx.chiefComplaint && <span style={{ color: '#5c7a76' }}>Chief complaint: <strong style={{ color: '#0e3b39' }}>{rx.chiefComplaint}</strong></span>}
                  {!!rx.description && <span style={{ color: '#5c7a76' }}>Description: <strong style={{ color: '#0e3b39' }}>{rx.description}</strong></span>}
                  {!!rx.diagnosis && <span style={{ color: '#5c7a76' }}>Diagnosis: <strong style={{ color: '#0e3b39' }}>{rx.diagnosis}</strong></span>}
                  {!!rx.investigation && <span style={{ color: '#5c7a76' }}>Investigation: <strong style={{ color: '#0e3b39' }}>{rx.investigation}</strong></span>}
                  {!!rx.treatmentGroup && <span style={{ color: '#5c7a76' }}>Treatment group: <strong style={{ color: '#0e3b39' }}>{rx.treatmentGroup}</strong></span>}
                  {!!rx.toothNumber && <span style={{ color: '#5c7a76' }}>Tooth number: <strong style={{ color: '#0e3b39' }}>{rx.toothNumber}</strong></span>}
                  {!!rx.treatment && <span style={{ color: '#5c7a76' }}>Current treatment: <strong style={{ color: '#0e3b39' }}>{rx.treatment}</strong></span>}
                  {!!rx.advisedTreatment && <span style={{ color: '#5c7a76' }}>Advised treatment: <strong style={{ color: '#0e3b39' }}>{rx.advisedTreatment}</strong></span>}
                </div>
              </>
            )}
            {hasImageTemplate && (
              <div style={{ fontSize: 11.5, color: '#222', lineHeight: 1.5, marginBottom: 4 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 14px', color: '#444' }}>
                  {rx.medicalHistory && rx.medicalHistory !== '—' && <span>Medical Hx: <strong>{rx.medicalHistory}</strong></span>}
                  {rx.chiefComplaint && rx.chiefComplaint !== '—' && <span>Chief Complaint: <strong>{rx.chiefComplaint}</strong></span>}
                  {rx.description && rx.description !== '—' && <span>Description: <strong>{rx.description}</strong></span>}
                  {rx.diagnosis && rx.diagnosis !== '—' && <span>Diagnosis: <strong>{rx.diagnosis}</strong></span>}
                  {rx.investigation && rx.investigation !== '—' && <span>Investigation: <strong>{rx.investigation}</strong></span>}
                  {rx.treatmentGroup && rx.treatmentGroup !== '—' && <span>Treatment Group: <strong>{rx.treatmentGroup}</strong></span>}
                  {rx.toothNumber && rx.toothNumber !== '—' && <span>Tooth #: <strong>{rx.toothNumber}</strong></span>}
                  {rx.treatment && rx.treatment !== '—' && <span>Treatment: <strong>{rx.treatment}</strong></span>}
                  {rx.advisedTreatment && rx.advisedTreatment !== '—' && <span>Advised: <strong>{rx.advisedTreatment}</strong></span>}
                </div>
              </div>
            )}
            <p style={{ fontFamily: hasImageTemplate ? 'inherit' : "'Bricolage Grotesque'", fontWeight: 700, fontSize: hasImageTemplate ? 13 : 15, color: '#0e3b39', margin: hasImageTemplate ? '2px 0 4px' : '20px 0 8px' }}>℞</p>
            {rx.noMeds && <p style={{ fontSize: 13.5, color: '#98b0ab' }}>No medicine prescribed.</p>}
            {rx.hasMeds && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: hasImageTemplate ? 11 : 13, minWidth: hasImageTemplate ? 0 : 480 }}>
                  <thead><tr style={{ textAlign: 'left', color: hasImageTemplate ? '#555' : '#7a9994', fontSize: hasImageTemplate ? 10 : 11, letterSpacing: '.05em', textTransform: 'uppercase', borderBottom: '1px solid #ccc' }}>
                    <th style={{ padding: hasImageTemplate ? '4px 4px' : '8px 6px', fontWeight: 700 }}>#</th>
                    <th style={{ padding: hasImageTemplate ? '4px 4px' : '8px 6px', fontWeight: 700 }}>Medicine</th>
                    <th style={{ padding: hasImageTemplate ? '4px 4px' : '8px 6px', fontWeight: 700 }}>Dosage</th>
                    <th style={{ padding: hasImageTemplate ? '4px 4px' : '8px 6px', fontWeight: 700 }}>Food</th>
                    <th style={{ padding: hasImageTemplate ? '4px 4px' : '8px 6px', fontWeight: 700 }}>Duration</th>
                    {rx.anyRemarks && <th style={{ padding: hasImageTemplate ? '4px 4px' : '8px 6px', fontWeight: 700 }}>Remarks</th>}
                  </tr></thead>
                  <tbody>
                    {rx.meds.map((rm) => (
                      <tr key={rm.sn} style={{ borderBottom: '1px solid #e8e8e8' }}>
                        <td style={{ padding: hasImageTemplate ? '4px 4px' : '9px 6px', color: '#8aa8a3' }}>{rm.sn}</td>
                        <td style={{ padding: hasImageTemplate ? '4px 4px' : '9px 6px', color: '#0e3b39', fontWeight: 700 }}>{rm.name} <span style={{ color: '#98b0ab', fontWeight: 400 }}>({rm.unit})</span></td>
                        <td style={{ padding: hasImageTemplate ? '4px 4px' : '9px 6px', color: '#33534f' }}>{rm.dose} <span style={{ color: '#98b0ab' }}>{rm.total}</span></td>
                        <td style={{ padding: hasImageTemplate ? '4px 4px' : '9px 6px', color: '#33534f' }}>{rm.food}</td>
                        <td style={{ padding: hasImageTemplate ? '4px 4px' : '9px 6px', color: '#33534f' }}>{rm.duration}</td>
                        {rx.anyRemarks && <td style={{ padding: hasImageTemplate ? '4px 4px' : '9px 6px', color: '#33534f' }}>{rm.remarks}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!hasImageTemplate && (doctorName || doctorQualification) && (
              <div style={{ marginTop: 34, display: 'flex', justifyContent: 'flex-end' }}>
                <span style={{ textAlign: 'center', fontSize: 12.5, color: '#5c7a76', borderTop: '1px solid #cfe3df', paddingTop: 7, minWidth: 190 }}>Dr. {doctorName}{doctorQualification ? <><br /><span style={{ fontSize: 11.5, color: '#98b0ab' }}>{doctorQualification}</span></> : null}</span>
              </div>
            )}
          </div>
        </div>
        )}
        {waSend.enabled && isPhone && (
          <PhoneActionBar
            send={waSend}
            patient={waPatient}
            onDownload={() => (hasDocxTemplate && docxUrl
              ? downloadAsPdf(docxUrl, `Prescription_${rx.visitId || 'doc'}.pdf`, docxFormat)
              : downloadElementAsPdf('rx-print-body', `Prescription_${rx.visitId || 'doc'}.pdf`))}
            onPrint={() => (hasDocxTemplate && docxUrl ? printAsPdf(docxUrl, docxFormat) : window.print())}
          />
        )}
      </div>
    </div>
  );
}

/* ── Print-ready Receipt sheet ── */
function ReceiptSheet({ receipt, onClose, clinicName, clinicAddress, doctorName, hasReceiptTemplate, onPaymentSaved }) {
  const isPhone = useIsPhone();
  const waPatient = { patientId: receipt.patientId, name: receipt.name, mobile: receipt.mobile };
  const [docxUrl, setDocxUrl] = useState(null);
  const [docxLoading, setDocxLoading] = useState(false);
  const [docxError, setDocxError] = useState(null);
  const [docxFormat, setDocxFormat] = useState(null);

  // After docxUrl, for the same reason as PrescriptionSheet.
  const waSend = useDocSend({
    useCase: 'PAYMENT_RECEIPT',
    patient: waPatient,
    visitId: receipt.visitId,
    // The amount is part of the version: a corrected receipt for the same
    // visit is a different document and must be allowed through.
    docVersion: String(receipt.amountPaid || '') + '|' + (receipt.dateLabel || ''),
    params: { payment_date: receipt.dateLabel || '', amount: String(receipt.amountPaid || '') },
    documentUrl: docxUrl,
  });
  const [paymentSaving, setPaymentSaving] = useState(false);
  const [paymentSaved, setPaymentSaved] = useState(false);

  useEffect(() => {
    if (!hasReceiptTemplate) return;
    setDocxLoading(true);
    const visitData = {
      patientName: receipt.name, mobile: receipt.mobile, date: receipt.dateLabel,
      age_sex: receipt.ageSex || '', doctorName: doctorName || '',
      visitId: receipt.visitId, receiptNumber: receipt.receiptNo,
      treatmentCost: receipt.treatmentCost, amountPaid: receipt.amountPaid,
      balanceDue: receipt.balanceDue, paymentMode: receipt.mode,
      paySplits: receipt.paySplits || [],
    };
    generateReceiptPdf(visitData)
      .then(res => { setDocxUrl(res.url); setDocxFormat(res.format); })
      .catch(err => setDocxError(err.message))
      .finally(() => setDocxLoading(false));
  }, [hasReceiptTemplate]);

  function handleSavePayment() {
    setPaymentSaving(true);
    savePayment({
      visitId: receipt.visitId, patientId: receipt.patientId, patientName: receipt.name,
      mobile: receipt.mobile, date: receipt.dateLabel, treatmentCost: receipt.treatmentCost,
      amountPaid: receipt.amountPaid, balanceDue: receipt.balanceDue, paymentMode: receipt.mode,
      paySplits: receipt.paySplits || [], clinicId: getClinicId(),
    }).then(() => { setPaymentSaved(true); if (onPaymentSaved) onPaymentSaved(); })
      .catch(() => {})
      .finally(() => setPaymentSaving(false));
  }

  return (
    <div id="rx-overlay" style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(14,59,57,.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 20, overflow: 'auto' }}>
      <div id="rx-sheet" onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 18, width: '100%', maxWidth: hasReceiptTemplate ? 720 : 560, overflow: 'hidden', margin: 'auto' }}>
        <DocPopupHeader
          title="Payment Receipt"
          send={waSend}
          patient={waPatient}
          phone={isPhone}
          onPrint={hasReceiptTemplate ? (docxUrl ? () => printAsPdf(docxUrl, docxFormat) : null) : () => window.print()}
          onDownload={hasReceiptTemplate
            ? (docxUrl ? () => downloadAsPdf(docxUrl, `Receipt_${receipt.visitId || 'doc'}.pdf`, docxFormat) : null)
            : () => downloadElementAsPdf('rc-print-body', `Receipt_${receipt.visitId || 'doc'}.pdf`)}
          onClose={onClose}
          fallback={<>
            {hasReceiptTemplate && docxUrl && (
              <button onClick={() => printAsPdf(docxUrl, docxFormat)} style={{ padding: '8px 15px', borderRadius: 9, border: '1px solid rgba(255,255,255,.3)', background: 'transparent', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Print</button>
            )}
            {hasReceiptTemplate && docxUrl && (
              <DownloadButton onDownload={() => downloadAsPdf(docxUrl, `Receipt_${receipt.visitId || 'doc'}.pdf`, docxFormat)} />
            )}
            {!hasReceiptTemplate && (
              <button onClick={() => window.print()} style={{ padding: '8px 15px', borderRadius: 9, border: '1px solid rgba(255,255,255,.3)', background: 'transparent', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Print</button>
            )}
            {!hasReceiptTemplate && (
              <DownloadButton onDownload={() => downloadElementAsPdf('rc-print-body', `Receipt_${receipt.visitId || 'doc'}.pdf`)} />
            )}
          </>}
        />
        <SendStrip send={waSend} patient={waPatient} />

        {hasReceiptTemplate && (
          <div style={{ minHeight: 400 }}>
            {docxLoading && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 60, gap: 16 }}>
                <div style={{ width: 36, height: 36, border: '3px solid #e2efec', borderTopColor: '#12a094', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                <span style={{ color: '#5c7a76', fontSize: 14 }}>Generating receipt...</span>
                <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
              </div>
            )}
            {docxError && (
              <div style={{ padding: 40, textAlign: 'center', color: '#c0392b', fontSize: 14 }}>
                <p>Failed to generate receipt</p>
                <p style={{ fontSize: 12, color: '#888', marginTop: 8 }}>{docxError}</p>
              </div>
            )}
            {docxUrl && (docxFormat === 'pdf' || docxFormat === 'html') && (
              <iframe src={previewSrc(docxUrl, docxFormat)} style={{ width: '100%', height: 700, border: 'none' }} title="Receipt" />
            )}
            {docxUrl && docxFormat === 'docx' && (
              <div style={{ padding: 40, textAlign: 'center' }}>
                <p style={{ color: '#0e3b39', fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Receipt generated successfully</p>
                <p style={{ color: '#5c7a76', fontSize: 13, marginBottom: 20 }}>PDF conversion not available. Download the file to view and print.</p>
                <a href={docxUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', padding: '12px 28px', borderRadius: 10, background: '#12a094', color: '#fff', fontWeight: 700, fontSize: 14, textDecoration: 'none' }}>Download Receipt</a>
              </div>
            )}
          </div>
        )}

        {!hasReceiptTemplate && (
        <div id="rc-print-body" style={{ padding: '26px 28px 30px', background: '#fff' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, borderBottom: '2px solid #0e756c', paddingBottom: 14, flexWrap: 'wrap' }}>
            <div>
              <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 19, color: '#0e3b39' }}>{clinicName}</span>
              <span style={{ display: 'block', fontSize: 12, color: '#5c7a76', marginTop: 2 }}>{clinicAddress}</span>
            </div>
            <span style={{ flexShrink: 0, textAlign: 'right', fontSize: 12, color: '#5c7a76', lineHeight: 1.5 }}>
              <span style={{ display: 'block' }}>Date: <strong style={{ color: '#0e3b39' }}>{receipt.dateLabel}</strong></span>
              <span style={{ display: 'block', fontFamily: 'ui-monospace,monospace' }}>{receipt.receiptNo}</span>
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: '8px 22px', marginTop: 14, fontSize: 13.5 }}>
            <span style={{ color: '#5c7a76' }}>Received from: <strong style={{ color: '#0e3b39' }}>{receipt.name}</strong></span>
            <span style={{ color: '#5c7a76' }}>Mobile: <strong style={{ color: '#0e3b39' }}>{receipt.mobile}</strong></span>
            <span style={{ color: '#5c7a76' }}>Patient ID: <strong style={{ color: '#0e3b39' }}>{receipt.patientId}</strong></span>
            <span style={{ color: '#5c7a76' }}>Mode: <strong style={{ color: '#0e3b39' }}>{receipt.mode}</strong></span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, marginTop: 18 }}>
            <thead><tr style={{ textAlign: 'left', color: '#7a9994', fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase', borderBottom: '1px solid #e2efec' }}>
              <th style={{ padding: '8px 6px', fontWeight: 700 }}>#</th><th style={{ padding: '8px 6px', fontWeight: 700 }}>Particulars</th><th style={{ padding: '8px 6px', fontWeight: 700, textAlign: 'right' }}>Amount</th>
            </tr></thead>
            <tbody>
              {receipt.lines.map((rl) => (
                <tr key={rl.sn} style={{ borderBottom: '1px solid #f0f6f5' }}>
                  <td style={{ padding: '10px 6px', color: '#8aa8a3' }}>{rl.sn}</td>
                  <td style={{ padding: '10px 6px', color: '#0e3b39' }}>{rl.label}</td>
                  <td style={{ padding: '10px 6px', color: '#33534f', textAlign: 'right' }}>{rl.amountLabel}</td>
                </tr>
              ))}
              <tr>
                <td style={{ padding: '12px 6px' }}></td>
                <td style={{ padding: '12px 6px', fontWeight: 700, color: '#0e3b39' }}>Total received</td>
                <td style={{ padding: '12px 6px', textAlign: 'right', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 18, color: '#12805a' }}>{receipt.totalLabel}</td>
              </tr>
            </tbody>
          </table>
          <div style={{ marginTop: 6, padding: '13px 15px', borderRadius: 12, background: '#f7fbfa', border: '1px solid #e2efec', display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', fontSize: 13.5 }}>
            <span style={{ color: '#5c7a76' }}>Payment status: <strong style={{ color: '#0e3b39' }}>{receipt.status}</strong></span>
            <span style={{ color: '#5c7a76' }}>Balance due: <strong style={{ color: receipt.balanceColor }}>{receipt.balanceLabel}</strong></span>
          </div>
          <div style={{ marginTop: 30, display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <span style={{ fontSize: 11.5, color: '#98b0ab', maxWidth: 230 }}>This is a computer-generated receipt for the amount received.</span>
            <span style={{ textAlign: 'center', fontSize: 12.5, color: '#5c7a76', borderTop: '1px solid #cfe3df', paddingTop: 7, minWidth: 180 }}>For {clinicName}</span>
          </div>
        </div>
        )}
        {waSend.enabled && isPhone && (
          <PhoneActionBar
            send={waSend}
            patient={waPatient}
            onDownload={() => (hasReceiptTemplate && docxUrl
              ? downloadAsPdf(docxUrl, `Receipt_${receipt.visitId || 'doc'}.pdf`, docxFormat)
              : downloadElementAsPdf('rc-print-body', `Receipt_${receipt.visitId || 'doc'}.pdf`))}
            onPrint={() => (hasReceiptTemplate && docxUrl ? printAsPdf(docxUrl, docxFormat) : window.print())}
          />
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   Clinical — Doctor form (two steps)
   ═══════════════════════════════════════════ */
export default function Clinical({
  cur, hasHistory, cform, onSetField,
  prevPending, prevPendingLabel, amountToCollect, amountToCollectLabel, computedBalance, computedBalanceLabel, balanceColor,
  hasPending, noPending, pendingTotalLabel, pendingList,
  hasQr, noQr, qrUrl, qrUploadLabel, onUploadQr,
  showQr, onOpenQr, onCloseQr,
  savedFlash, onGoBack, onSaveClinical, onSaveAndNext, saving, error,
  apptCountText, showApptCount,
  db, curPatientId,
  labNames,
  readOnly, onCreateNewVisit,
  clinicName, clinicAddress, doctorName, doctorQualification,
  rxTemplateUrl, hasDocxTemplate, hasReceiptTemplate,
  onPaymentSaved,
}) {
  const [step, setStep] = useState(1);
  const [detailVisit, setDetailVisit] = useState(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  // The appointment as last saved, so the notice can tell "setting a date"
  // apart from "moving one the patient has already been told about". Read
  // from the stored visit, never from the form, which is the new value.
  const savedVisit = ((db && db.patients && db.patients[curPatientId] && db.patients[curPatientId].visits) || [])
    .find((v) => v.visitId === cur.visitId);
  const savedAppt = {
    date: (savedVisit && savedVisit.clinical && savedVisit.clinical.nextAppointment) || '',
    time: (savedVisit && savedVisit.clinical && savedVisit.clinical.nextAppointmentTime) || '',
  };
  const [labOpen, setLabOpen] = useState(false);
  const [rxOpen, setRxOpen] = useState(false);
  const [rcOpen, setRcOpen] = useState(false);
  const [rcError, setRcError] = useState('');
  const [viewDoc, setViewDoc] = useState(null);
  const [uploadRowCounter, setUploadRowCounter] = useState(1);
  const uploadRowsRef = useRef([{ rowId: 0, kind: 'X-Ray' }]);
  const [, forceUpdate] = useState(0);
  const fileInputRef = useRef(null);
  const pendingRowRef = useRef(null);
  const [uploadingRowIds, setUploadingRowIds] = useState([]);
  // Counted separately from uploadingRowIds: that list is keyed by the row that
  // started the upload and stays EMPTY when rowId is null, so it cannot be used
  // to decide whether a save is safe. This counter always reflects reality.
  const [uploadsInFlight, setUploadsInFlight] = useState(0);
  const uploadBusy = uploadsInFlight > 0;

  const medicines = cform.medicines || [];
  const paySplits = cform.paySplits || [];
  const documents = cform.documents || [];
  const uploadRows = uploadRowsRef.current;

  const remaining = amountToCollect - num(cform.amountPaid);
  const computedStatus = remaining <= 0 ? 'Fully Paid' : (num(cform.amountPaid) > 0 ? 'Partially paid' : 'Not paid');
  const statusColorMap = { 'Fully Paid': ['#e3f5ec', '#12805a'], 'Partially paid': ['#fdf0dc', '#a9741a'], 'Not paid': ['#fdecea', '#c0392b'] };
  const scm = statusColorMap[computedStatus] || ['#eef4f3', '#8aa8a3'];

  const splitTotal = paySplits.reduce((s, sp) => s + num(sp.amount), 0);
  const splitDiff = paySplits.length ? num(cform.amountPaid) - splitTotal : 0;
  const splitBlocked = paySplits.length > 0 && splitDiff !== 0;

  const meta = {
    dateLabel: cur.dateLabel, name: cur.name, ageGender: cur.ageGender,
    mobile: cur.mobile, patientId: cur.patientId, visitId: cur.visitId,
  };

  /* ── Medicine handlers ── */
  function addMedicine() { onSetField('medicines', [...medicines, { name: '', unit: 'Tablet', morning: false, afternoon: false, evening: false, night: false, food: 'After Food', duration: '' }]); }
  function removeMedicine(i) { onSetField('medicines', medicines.filter((_, x) => x !== i)); }
  function setMed(i, key, val) {
    const v = key === 'name' ? titleCase(val) : val;
    onSetField('medicines', medicines.map((m, x) => x === i ? { ...m, [key]: v } : m));
  }

  /* ── Split handlers ── */
  const treatmentLines = treatmentSplitLines(cform);
  // Split payment is offered first when treatments are marked; Add line item
  // takes over once lines exist, or when there are no treatments to split by.
  const showSplitButton = paySplits.length === 0 && treatmentLines.length > 0;
  function splitByTreatment() { onSetField('paySplits', treatmentLines); setRcError(''); }
  function addSplit() { onSetField('paySplits', [...paySplits, { category: 'Treatment', custom: '', amount: '' }]); setRcError(''); }
  function removeSplit(i) { onSetField('paySplits', paySplits.filter((_, x) => x !== i)); setRcError(''); }
  function setSplit(i, key, val) {
    const v = key === 'custom' ? titleCase(val) : val;
    onSetField('paySplits', paySplits.map((sp, x) => x === i ? { ...sp, [key]: v } : sp));
    setRcError('');
  }

  /* ── Document upload handlers ── */
  function addUploadRow() {
    const newId = uploadRowCounter;
    uploadRowsRef.current = [...uploadRows, { rowId: newId, kind: 'X-Ray' }];
    setUploadRowCounter(newId + 1);
    forceUpdate(c => c + 1);
  }
  function removeUploadRow(rowId) {
    uploadRowsRef.current = uploadRows.filter(r => r.rowId !== rowId);
    onSetField('documents', documents.filter(d => d.rowId !== rowId));
    forceUpdate(c => c + 1);
  }
  function setUploadRowKind(rowId, kind) {
    uploadRowsRef.current = uploadRows.map(r => r.rowId === rowId ? { ...r, kind } : r);
    onSetField('documents', documents.map(d => d.rowId === rowId ? { ...d, kind } : d));
    forceUpdate(c => c + 1);
  }
  function triggerUpload(rowId, kind) {
    pendingRowRef.current = { rowId, kind };
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  }
  function onUploadDocs(e) {
    const input = e && e.target;
    const files = Array.from((input && input.files) || []);
    if (!files.length) return;
    const pending = pendingRowRef.current;
    const kind = pending ? pending.kind : 'Other';
    const rowId = pending ? pending.rowId : null;
    const visitId = cur.visitId;

    setUploadingRowIds(prev => rowId !== null ? [...prev, rowId] : prev);
    setUploadsInFlight(n => n + 1);

    const uploadOne = async (file) => {
      try {
        const result = await getUploadUrl({ visitId, fileName: file.name, fileType: file.type, docKind: kind });
        if (result && result.uploadUrl) {
          await uploadToS3(result.uploadUrl, file);
          return { name: file.name, kind, rowId, type: file.type || '', s3Key: result.key, at: Date.now() };
        }
        // Null rather than a throw: AWS_URL or CLINIC_ID missing from the build.
        logEvent({
          kind: 'document_upload_fallback', severity: 'data_loss_risk',
          visitId, fileName: file && file.name, fileBytes: file && file.size,
          docKind: kind, error: 'getUploadUrl returned null (AWS not configured for this build)',
        });
      } catch (err) {
        // The base64 fallback below looks like a safety net but is not one:
        // App.jsx strips `dataUrl` before saving (the sheet cell cannot hold
        // it), so the stored record ends up with neither s3Key nor dataUrl and
        // the document is silently lost. Log it loudly — this is data loss the
        // doctor is never shown.
        logEvent({
          kind: 'document_upload_fallback',
          severity: 'data_loss_risk',
          visitId,
          fileName: file && file.name,
          fileBytes: file && file.size,
          fileType: file && file.type,
          docKind: kind,
          error: String((err && err.message) || err),
        });
      }
      return new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve({ name: file.name, kind, rowId, type: file.type || '', dataUrl: String(r.result || ''), at: Date.now() });
        r.onerror = () => resolve(null);
        r.readAsDataURL(file);
      });
    };

    Promise.all(files.map(uploadOne)).then((docs) => {
      const good = docs.filter(Boolean);
      if (!good.length) return;
      const existing = rowId !== null ? documents.filter(d => d.rowId !== rowId) : documents;
      onSetField('documents', [...existing, ...good]);
    }).finally(() => {
      setUploadingRowIds(prev => prev.filter(id => id !== rowId));
      setUploadsInFlight(n => Math.max(0, n - 1));
      try { if (input) input.value = ''; } catch (err) {}
    });
  }
  function removeDoc(i) { onSetField('documents', documents.filter((_, x) => x !== i)); }

  /* ── Receipt open ── */
  function openReceipt() {
    if (num(cform.amountPaid) <= 0) return setRcError('Enter an amount paid before generating a receipt.');
    if (splitBlocked) {
      const d = splitDiff;
      return setRcError(d > 0
        ? 'Line items worth ' + inr(Math.abs(d)) + ' remaining — the split must match the amount paid.'
        : 'Line items exceed amount paid by ' + inr(Math.abs(d)) + ' — the split must match the amount paid.');
    }
    if (!linesFor(cform)) return setRcError("Select a treatment / treatment group in the Doctor's form, or add a payment split below.");
    setRcError('');
    setRcOpen(true);
  }

  /* ── Visit detail modal ── */
  let detail = null;
  if (detailVisit && db) {
    const dp = db.patients[detailVisit.pid];
    const dv = dp && dp.visits.find((x) => x.visitId === detailVisit.visitId);
    if (dv) {
      const c = dv.clinical || {};
      const nc = normalizeClinical(c);
      detail = {
        title: dv.visitId, dateLabel: fmtDate(dv.date), name: dp.name,
        rows: [
          { k: 'Medical history', v: dash(nc.medicalHistory) },
          { k: 'Chief complaint', v: listLabel(nc.chiefComplaint, '—') },
          { k: 'Description', v: dash(nc.chiefDescription) },
          { k: 'Diagnosis', v: dash(nc.diagnosis) },
          { k: 'Advised treatment', v: advTeethLabel(nc) || listLabel(nc.advisedTreatment, '—') },
          { k: 'Investigation', v: dash(nc.investigation) },
          { k: 'Treatment group', v: listLabel(nc.treatmentGroup, '—') },
          { k: 'Current treatment', v: trTeethLabel(nc) || trLabel(nc) || '—' },
          { k: 'Tooth number', v: listLabel(nc.toothNumber, '—') },
          { k: 'Medicines', v: (nc.medicines || []).filter(m => m.name).length
            ? (nc.medicines || []).filter(m => m.name).map(m => m.name + ' — ' + medDoseText(m) + ', ' + m.food + (m.duration ? ', ' + m.duration + ' days' : '') + (m.remarks ? ' (' + m.remarks + ')' : '')).join(' · ')
            : '—' },
          { k: 'Treatment cost', v: nc.treatmentCost ? inr(num(nc.treatmentCost)) : '—' },
          { k: 'Amount paid', v: nc.amountPaid ? inr(num(nc.amountPaid)) : '—' },
          { k: 'Balance due', v: nc.balanceDue ? inr(num(nc.balanceDue)) : '—' },
          { k: 'Payment mode', v: dash(nc.paymentMode) }, { k: 'Payment status', v: dash(nc.paymentStatus) },
          { k: 'Treatment stage', v: dash(nc.treatmentStage) }, { k: 'Google review taken', v: dash(nc.googleReviewTaken) },
          { k: 'Next appointment', v: nc.nextAppointment ? fmtDate(nc.nextAppointment) : '—' },
          { k: 'Next appointment time', v: fmtTime(nc.nextAppointmentTime) },
          { k: 'Comments', v: dash(nc.comments) },
          { k: 'Lab name', v: dash(nc.labName) },
          { k: 'Lab tooth number', v: dash(nc.labToothNumber || listLabel(nc.toothNumber, '')) },
          { k: 'Lab description', v: dash(nc.labDescription) },
          { k: "Patient's complaint", v: dash(nc.patientProblem) },
          { k: 'Medical history (patient)', v: dash(nc.patientMedicalHistory) },
          { k: 'Allergies (patient)', v: dash(nc.patientAllergies) },
          { k: 'Dental history (patient)', v: dash(nc.patientDentalHistory) },
        ],
        docs: (nc.documents || []).map((d, i) => ({ ...d, idx: i, isImage: /^image/i.test(d.type), href: d.dataUrl || '', s3Key: d.s3Key || '' })),
        hasDocs: (nc.documents || []).length > 0,
      };
    }
  }

  const toothOptions = cform.patientType === 'Kid' ? TOOTH_NUMBERS_KID : TOOTH_NUMBERS;
  // Lab tooth numbers are auto-filled from cform.toothNumber, which the tooth
  // picker now writes in FDI notation ("11"), while toothOptions uses "1-1".
  // Union them so an auto-filled value is never silently dropped from the chips.
  const labToothOptions = [...toothOptions, ...asList(cform.toothNumber).filter((t) => !toothOptions.includes(t))];

  return (
    <div style={{ maxWidth: 840, margin: '0 auto' }}>
      <button onClick={onGoBack} style={{ ...TOUCH_BTN, justifyContent: 'flex-start', border: 0, background: 'none', color: '#0e756c', fontWeight: 700, fontSize: 14, cursor: 'pointer', padding: '10px 0', marginBottom: 4, marginLeft: -2 }}>
        &larr; Back
      </button>

      {/* ── Hero header ── */}
      <div style={{ background: 'linear-gradient(135deg,#0e756c,#0e3b39)', borderRadius: 18, padding: '22px 24px', color: '#fff', display: 'flex', gap: 20, flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span style={{ fontSize: 12, letterSpacing: '.14em', textTransform: 'uppercase', color: '#7fd4c9', fontWeight: 700 }}>{readOnly ? 'Appointment · Visit details' : 'Doctor · Clinical record'}</span>
          <h1 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 26, marginTop: 4 }}>{cur.name}</h1>
          <p style={{ color: '#bfe3dd', fontSize: 14, marginTop: 2 }}>{cur.ageGender} · {cur.mobile}</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span style={{ display: 'block', fontFamily: 'ui-monospace,monospace', fontSize: 13, color: '#bfe3dd' }}>Patient {cur.patientId}</span>
          <span style={{ display: 'block', fontFamily: 'ui-monospace,monospace', fontSize: 18, fontWeight: 700 }}>{cur.visitId}</span>
          <span style={{ display: 'block', fontSize: 13, color: '#bfe3dd', marginTop: 2 }}>{cur.dateLabel}</span>
        </div>
      </div>

      {/* ── Visit history ── */}
      {hasHistory && (
        <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, padding: '20px 24px', marginTop: 16 }}>
          <h3 style={{ ...h3Style, marginBottom: 4 }}>Visit history</h3>
          <p style={{ color: '#98b0ab', fontSize: 12.5, marginBottom: 12 }}>Tap a row to see everything recorded at that visit.</p>
          {(() => {
            const visibleHistory = showAllHistory ? cur.history : cur.history.slice(-2);
            const hasMore = cur.history.length > 2 && !showAllHistory;
            return (
              <>
                <div className="table-view" style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, minWidth: 600 }}>
                    <thead>
                      <tr style={{ textAlign: 'left', color: '#7a9994', fontSize: 11.5, letterSpacing: '.05em', textTransform: 'uppercase' }}>
                        <th style={{ padding: '8px 10px', fontWeight: 700 }}>Visit</th><th style={{ padding: '8px 10px', fontWeight: 700 }}>Date</th><th style={{ padding: '8px 10px', fontWeight: 700 }}>Treatment</th><th style={{ padding: '8px 10px', fontWeight: 700 }}>Cost</th><th style={{ padding: '8px 10px', fontWeight: 700 }}>Balance</th><th style={{ padding: '8px 10px', fontWeight: 700 }}>Status</th><th style={{ padding: '8px 10px' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleHistory.map((h) => (
                        <tr key={h.visitId} onClick={() => setDetailVisit({ pid: curPatientId, visitId: h.visitId })} style={{ borderTop: '1px solid #eef4f3', background: h.rowBg, cursor: 'pointer' }}>
                          <td style={{ padding: '9px 10px', fontFamily: 'ui-monospace,monospace', fontSize: 12, color: '#0e756c', fontWeight: 600 }}>{h.visitId}</td>
                          <td style={{ padding: '9px 10px', color: '#5c7a76' }}>{h.dateLabel}</td>
                          <td style={{ padding: '9px 10px', color: '#5c7a76' }}>{h.treatmentLabel}</td>
                          <td style={{ padding: '9px 10px', color: '#33534f' }}>{h.cost}</td>
                          <td style={{ padding: '9px 10px', color: '#33534f' }}>{h.balance}</td>
                          <td style={{ padding: '9px 10px', color: '#5c7a76' }}>{h.status}</td>
                          <td style={{ padding: '9px 10px', textAlign: 'right', color: '#0e756c', fontWeight: 700, fontSize: 12 }}>View &rarr;</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="card-view">
                  {visibleHistory.map((h) => (
                    <div key={h.visitId} onClick={() => setDetailVisit({ pid: curPatientId, visitId: h.visitId })} style={{ padding: '10px 12px', borderTop: '1px solid #eef4f3', background: h.rowBg, display: 'flex', flexDirection: 'column', gap: 3, cursor: 'pointer' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 12, color: '#0e756c', fontWeight: 600 }}>{h.visitId}</span>
                        <span style={{ fontSize: 12, color: '#5c7a76' }}>{h.dateLabel}</span>
                      </div>
                      <div style={{ fontSize: 13, color: '#5c7a76' }}>{h.treatmentLabel}</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 12.5, color: '#33534f' }}>Cost {h.cost} · Balance {h.balance} · {h.status}</span>
                        <span style={{ color: '#0e756c', fontWeight: 700, fontSize: 12 }}>View &rarr;</span>
                      </div>
                    </div>
                  ))}
                </div>
                {hasMore && <button onClick={() => setShowAllHistory(true)} style={{ display: 'block', width: '100%', padding: '12px 0', border: 0, borderTop: '1px solid #eef4f3', background: 'none', color: '#0e756c', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}>View more ({cur.history.length - 2} earlier visits)</button>}
              </>
            );
          })()}
        </div>
      )}

      {/* ── Step switcher ── */}
      {!readOnly && (
        <div style={{ display: 'flex', gap: 8, marginTop: 16, background: '#fff', border: '1px solid #dfece9', borderRadius: 14, padding: 8 }}>
          <button onClick={() => { setStep(1); scrollToTop(); }} style={{ flex: 1, padding: '11px 6px', borderRadius: 10, border: 0, cursor: 'pointer', fontWeight: 700, fontSize: 14, background: step === 1 ? '#0e756c' : 'transparent', color: step === 1 ? '#fff' : '#5c7a76' }}>1 · Clinical</button>
          <button onClick={() => { setStep(2); scrollToTop(); }} style={{ flex: 1, padding: '11px 6px', borderRadius: 10, border: 0, cursor: 'pointer', fontWeight: 700, fontSize: 14, background: step === 2 ? '#0e756c' : 'transparent', color: step === 2 ? '#fff' : '#5c7a76' }}>2 · Billing & files</button>
        </div>
      )}

      {/* ════════════════════════════════════════ STEP 1 · CLINICAL ════════════════════════════════════════ */}
      {(step === 1 || readOnly) && (
        <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, padding: 24, marginTop: 16 }}>
          <h3 style={{ ...h3Style, marginBottom: 16 }}>Doctor's form</h3>

          <PatientHealthPanel cform={cform} />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Medical history</label>
              <textarea value={cform.medicalHistory || ''} onChange={(e) => onSetField('medicalHistory', e.target.value)} placeholder="Diabetes, hypertension, allergies, medication…" style={{ ...fieldStyle, minHeight: 68, resize: 'vertical', ...(readOnly ? roStyle : {}) }} disabled={readOnly} />
            </div>
            <div>
              <label style={labelStyle}>Chief complaint</label>
              <MultiSelect value={cform.chiefComplaint} options={CHIEF_COMPLAINTS} onChange={(v) => onSetField('chiefComplaint', v)} placeholder="Select…" disabled={readOnly} allowOther />
            </div>
            <div>
              <label style={labelStyle}>Description</label>
              <input className="fld" value={cform.chiefDescription || ''} onChange={(e) => onSetField('chiefDescription', e.target.value)} placeholder="Notes on the chief complaint" style={{ ...fieldStyle, ...(readOnly ? roStyle : {}) }} disabled={readOnly} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Diagnosis</label>
              <input className="fld" value={cform.diagnosis || ''} onChange={(e) => onSetField('diagnosis', e.target.value)} placeholder="Clinical diagnosis" style={{ ...fieldStyle, ...(readOnly ? roStyle : {}) }} disabled={readOnly} />
            </div>
            <div>
              <label style={labelStyle}>Advised treatment</label>
              <MultiSelect value={cform.advisedTreatment} options={TREATMENTS} onChange={(v) => onSetField('advisedTreatment', v)} placeholder="Select…" disabled={readOnly} allowOther searchable />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ ...labelStyle, marginBottom: 4 }}>Tooth number <span style={{ color: '#98b0ab', fontWeight: 400 }}>— per advised treatment</span></label>
              <ToothTagBlock
                cform={cform}
                listField="advisedTreatment"
                mapField="advisedTeeth"
                emptyCopy="Select an advised treatment above, then tag the teeth it applies to."
                onChange={(next) => onSetField('advisedTeeth', next)}
                readOnly={readOnly}
              />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Investigation</label>
              <input className="fld" value={cform.investigation || ''} onChange={(e) => onSetField('investigation', e.target.value)} placeholder="X-ray, IOPA, OPG, pulp test…" style={{ ...fieldStyle, ...(readOnly ? roStyle : {}) }} disabled={readOnly} />
            </div>
            <div>
              <label style={labelStyle}>Treatment group</label>
              <MultiSelect value={cform.treatmentGroup} options={TREATMENT_GROUPS} onChange={(v) => onSetField('treatmentGroup', v)} placeholder="Select…" disabled={readOnly} allowOther />
            </div>
            <div>
              <label style={labelStyle}>Current treatment</label>
              {/* toothNumber is derived from the selected treatments, so it must be
                  recomputed when a treatment is added or removed, not only when a
                  tooth is tagged. */}
              <MultiSelect value={cform.treatment} options={TREATMENTS} onChange={(v) => { onSetField('treatment', v); onSetField('toothNumber', deriveToothNumber(v, cform.treatmentTeeth)); }} placeholder="Select…" disabled={readOnly} allowOther searchable />
            </div>
            {(Array.isArray(cform.treatment) ? cform.treatment : []).some(t => /Other/.test(t)) && (
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={labelStyle}>Treatment — other (specify)</label>
                <input className="fld" value={cform.treatmentOther || ''} onChange={(e) => onSetField('treatmentOther', e.target.value)} placeholder="Type the treatment" style={{ ...fieldStyle, ...(readOnly ? roStyle : {}) }} disabled={readOnly} />
              </div>
            )}
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ ...labelStyle, marginBottom: 4 }}>Tooth number <span style={{ color: '#98b0ab', fontWeight: 400 }}>— per treatment</span></label>
              <ToothTagBlock
                cform={cform}
                listField="treatment"
                mapField="treatmentTeeth"
                emptyCopy="Select a treatment above, then tag the teeth it applies to."
                onChange={(next) => {
                  onSetField('treatmentTeeth', next);
                  onSetField('toothNumber', deriveToothNumber(cform.treatment, next));
                }}
                readOnly={readOnly}
              />
            </div>
          </div>

          {/* ── Prescribed medicine ── */}
          {!readOnly && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '24px 0 12px' }}>
                <h3 style={h3Style}>Prescribed medicine</h3>
              </div>
              {medicines.length === 0 && (
                <p style={{ fontSize: 13.5, color: '#98b0ab', background: '#f7fbfa', border: '1px dashed #d6e7e3', borderRadius: 12, padding: '14px 16px' }}>No medicine added. Tap "Add medicine" if a prescription is needed.</p>
              )}
              {medicines.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {medicines.map((m, i) => (
                    <div key={i} style={{ border: '1px solid #e2efec', borderRadius: 14, padding: 14, background: '#fbfdfd' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
                        <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#8aa8a3' }}>Medicine {i + 1}</span>
                        <button onClick={() => removeMedicine(i)} title="Remove" style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid #f0d9d3', background: '#fdf0ec', color: '#c0392b', cursor: 'pointer', fontSize: 14 }}>✕</button>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
                        <div style={{ gridColumn: '1 / -1' }}>
                          <label style={{ display: 'block', fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>Medicine name</label>
                          <input className="fld" value={m.name} onChange={(e) => setMed(i, 'name', e.target.value)} placeholder="e.g. Amoxicillin 500mg" style={{ width: '100%', padding: '11px 13px', border: '1px solid #d6e7e3', borderRadius: 10, fontSize: 14.5, background: '#fff' }} />
                        </div>
                        <div>
                          <label style={{ display: 'block', fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>Form</label>
                          <select value={m.unit} onChange={(e) => setMed(i, 'unit', e.target.value)} style={{ width: '100%', padding: '11px 13px', border: '1px solid #d6e7e3', borderRadius: 10, fontSize: 14.5, background: '#fff' }}>
                            {MEDICINE_FORMS.map((u) => <option key={u} value={u}>{u}</option>)}
                          </select>
                        </div>
                        <div>
                          <label style={{ display: 'block', fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>Duration (days)</label>
                          <input className="fld" value={m.duration} onChange={(e) => setMed(i, 'duration', e.target.value)} type="number" min="0" placeholder="5" style={{ width: '100%', padding: '11px 13px', border: '1px solid #d6e7e3', borderRadius: 10, fontSize: 14.5, background: '#fff' }} />
                        </div>
                        <div>
                          <label style={{ display: 'block', fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>Food</label>
                          <select value={m.food} onChange={(e) => setMed(i, 'food', e.target.value)} style={{ width: '100%', padding: '11px 13px', border: '1px solid #d6e7e3', borderRadius: 10, fontSize: 14.5, background: '#fff' }}>
                            {FOOD_OPTIONS.map((fo) => <option key={fo} value={fo}>{fo}</option>)}
                          </select>
                        </div>
                        <div style={{ gridColumn: '1 / -1' }}>
                          <label style={{ display: 'block', fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>When to take</label>
                          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                            {['morning', 'afternoon', 'evening', 'night'].map((slot) => (
                              <button key={slot} onClick={() => setMed(i, slot, !m[slot])} style={{ padding: '7px 11px', borderRadius: 100, border: '1px solid ' + (m[slot] ? '#0e756c' : '#d6e7e3'), background: m[slot] ? '#0e756c' : '#fff', color: m[slot] ? '#fff' : '#5c7a76', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', textTransform: 'capitalize' }}>{slot}</button>
                            ))}
                          </div>
                          <p style={{ fontSize: 12.5, color: '#5c7a76', marginTop: 8 }}>{medDoseText(m)} · {m.food} {medTotal(m)}</p>
                        </div>
                        <div style={{ gridColumn: '1 / -1' }}>
                          <label style={{ display: 'block', fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>Remarks / instructions</label>
                          <input className="fld" value={m.remarks || ''} onChange={(e) => setMed(i, 'remarks', e.target.value)} placeholder="e.g. Complete the full course, do not chew" style={{ width: '100%', padding: '11px 13px', border: '1px solid #d6e7e3', borderRadius: 10, fontSize: 14.5, background: '#fff' }} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
                <button onClick={addMedicine} style={{ padding: '10px 16px', borderRadius: 10, border: '1px dashed #cfe3df', background: '#f7fbfa', color: '#0e756c', fontWeight: 700, fontSize: 13.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
                  Add medicine
                </button>
                <button onClick={() => setRxOpen(true)} style={{ padding: '10px 16px', borderRadius: 10, border: '1px solid #cfe3df', background: '#fff', color: '#0e756c', fontWeight: 700, fontSize: 13.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5M9 13h6M9 17h4"/></svg>
                  Generate e-prescription
                </button>
              </div>
              {/* Save and Next CTA (step 1 only) */}
              <div style={{ display: 'flex', gap: 12, marginTop: 22, justifyContent: 'flex-end' }}>
                <button onClick={() => { if (onSaveAndNext) onSaveAndNext(); setStep(2); scrollToTop(); }} style={{ padding: '11px 22px', borderRadius: 10, border: 0, background: '#0e756c', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Save and Next →</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════ STEP 2 · BILLING & FILES ════════════════════════════════ */}
      {step === 2 && !readOnly && (
        <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, padding: 24, marginTop: 16 }}>
          <h3 style={{ ...h3Style, marginBottom: 16 }}>Billing</h3>
          <div style={{ display: 'grid', gridTemplateColumns: FLUID_GRID_2COL, gap: 16 }}>
            <div>
              <label style={labelStyle}>Treatment cost (₹)</label>
              <input className="fld" value={cform.treatmentCost} onChange={(e) => onSetField('treatmentCost', e.target.value)} type="number" min="0" placeholder="0" style={fieldStyle} />
            </div>
            <div>
              <label style={labelStyle}>Amount paid (₹)</label>
              <input className="fld" value={cform.amountPaid} onChange={(e) => onSetField('amountPaid', e.target.value)} type="number" min="0" placeholder="0" style={fieldStyle} />
            </div>
            <div>
              <label style={labelStyle}>Payment mode</label>
              <select value={cform.paymentMode} onChange={(e) => onSetField('paymentMode', e.target.value)} style={fieldStyle}>
                <option value="">Select…</option>
                {PAYMENT_MODES.map((pm) => <option key={pm} value={pm}>{pm}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Payment status <span style={{ color: '#98b0ab', fontWeight: 400 }}>(auto)</span></label>
              <div style={{ padding: '11px 14px', border: '1px solid #e2efec', borderRadius: 10, background: '#f7fbfa', display: 'flex', alignItems: 'center' }}>
                <span style={{ display: 'inline-block', padding: '5px 13px', borderRadius: 100, fontSize: 13.5, fontWeight: 700, background: scm[0], color: scm[1] }}>{computedStatus}</span>
              </div>
            </div>
            <div style={{ gridColumn: '1 / -1', borderRadius: 12, padding: '14px 16px', background: '#f2f9f8', border: '1px solid #cfe3df', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: '#5c7a76' }}>Balance due = (treatment cost + previous pending <strong style={{ color: '#0e3b39' }}>{prevPendingLabel}</strong>) − amount paid</span>
              <span style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 22, color: balanceColor }}>{computedBalanceLabel}</span>
            </div>
          </div>

          {/* Payment split */}
          <div style={{ marginTop: 18, border: '1px solid #e2efec', borderRadius: 14, padding: 16, background: '#fbfdfd' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 15, color: '#0e3b39' }}>Payment split</span>
                <span style={{ display: 'block', fontSize: 12.5, color: '#98b0ab', marginTop: 2 }}>Optional. If left blank, the receipt bills the treatment selected in the Doctor's form.</span>
              </div>
              <span style={{ fontSize: 13, color: '#5c7a76' }}>Split total: <strong style={{ color: '#0e3b39' }}>{inr(splitTotal)}</strong></span>
            </div>
            {paySplits.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
                {paySplits.map((sp, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    <select value={sp.category} onChange={(e) => setSplit(i, 'category', e.target.value)} style={{ flex: '0 1 160px', padding: '11px 13px', border: '1px solid #d6e7e3', borderRadius: 10, fontSize: 14.5, background: '#fff' }}>
                      {SPLIT_CATEGORIES.map((sc) => <option key={sc} value={sc}>{sc}</option>)}
                    </select>
                    {sp.category === 'Custom' && (
                      <input className="fld" value={sp.custom} onChange={(e) => setSplit(i, 'custom', e.target.value)} placeholder="Line item name" style={{ flex: '1 1 170px', minWidth: 140, padding: '11px 13px', border: '1px solid #d6e7e3', borderRadius: 10, fontSize: 14.5, background: '#fff' }} />
                    )}
                    <input className="fld" value={sp.amount} onChange={(e) => setSplit(i, 'amount', e.target.value)} type="number" min="0" placeholder="Amount ₹" style={{ flex: '0 1 130px', padding: '11px 13px', border: '1px solid #d6e7e3', borderRadius: 10, fontSize: 14.5, background: '#fff' }} />
                    <button onClick={() => removeSplit(i)} title="Remove" style={{ width: 36, height: 38, borderRadius: 10, border: '1px solid #f0d9d3', background: '#fdf0ec', color: '#c0392b', fontSize: 14, cursor: 'pointer' }}>✕</button>
                  </div>
                ))}
              </div>
            )}
            {splitBlocked && (
              <p style={{ marginTop: 10, fontSize: 13, padding: '10px 13px', borderRadius: 10, background: splitDiff > 0 ? '#fdf0dc' : '#fdecea', color: splitDiff > 0 ? '#a9741a' : '#c0392b', fontWeight: 600 }}>
                {splitDiff > 0 ? 'Line items worth ' + inr(splitDiff) + ' remaining' : 'Line items exceed amount paid by ' + inr(Math.abs(splitDiff))}
              </p>
            )}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
              {showSplitButton && (
                <button onClick={splitByTreatment} title="One line item per treatment marked in the Doctor's form" style={{ padding: '9px 15px', borderRadius: 10, border: 0, background: '#0e756c', color: '#fff', fontWeight: 700, fontSize: 13.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h10M4 18h7"/></svg>
                  Split payment
                </button>
              )}
              {!showSplitButton && (
                <button onClick={addSplit} style={{ padding: '9px 15px', borderRadius: 10, border: '1px dashed #cfe3df', background: '#f7fbfa', color: '#0e756c', fontWeight: 700, fontSize: 13.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
                  Add line item
                </button>
              )}
              <button onClick={openReceipt} style={{ padding: '9px 15px', borderRadius: 10, border: '1px solid #cfe3df', background: splitBlocked ? '#f0f4f3' : '#fff', color: splitBlocked ? '#98b0ab' : '#0e756c', fontWeight: 700, fontSize: 13.5, cursor: splitBlocked ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2z"/><path d="M9 8h6M9 12h6"/></svg>
                Generate payment receipt
              </button>
            </div>
            {rcError && <p style={{ marginTop: 10, fontSize: 13, color: '#c0392b', fontWeight: 600 }}>{rcError}</p>}
          </div>

          {/* Pending + UPI */}
          <div style={{ marginTop: 16, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'stretch' }}>
            <div style={{ flex: 1, minWidth: 240, borderRadius: 12, padding: '14px 16px', background: '#fdf6f4', border: '1px solid #f6d3c8' }}>
              {hasPending && (
                <div>
                  <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#b0442a' }}>Total pending (all visits)</span>
                  <span style={{ display: 'block', fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 24, color: '#c0392b', marginTop: 2 }}>{pendingTotalLabel}</span>
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {pendingList.map((pd) => (
                      <span key={pd.visitId} style={{ fontSize: 13, color: '#8a5b4e' }}>
                        <span style={{ fontFamily: 'ui-monospace,monospace', color: '#c0392b', fontWeight: 600 }}>{pd.visitId}</span> · {pd.dateLabel} — <strong>{pd.amount}</strong>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {noPending && <span style={{ fontSize: 14, color: '#12805a', fontWeight: 600 }}>✓ No pending balance for this patient.</span>}
            </div>
            <div style={{ flex: '0 0 168px', borderRadius: 12, padding: 14, background: '#f2f9f8', border: '1px dashed #cfe3df', textAlign: 'center' }}>
              <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#0e756c', marginBottom: 8 }}>UPI scanner</span>
              <button onClick={onOpenQr} title="Show UPI scanner" style={{ width: 88, height: 88, borderRadius: 12, border: '1px solid #cfe3df', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', margin: '0 auto' }}>
                {hasQr && <img src={qrUrl} alt="UPI QR" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
                {noQr && <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#0e756c" strokeWidth="1.7"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3M20 14v.01M14 20h.01M20 20v-3" /></svg>}
              </button>
              <label style={{ display: 'block', minHeight: 44, padding: '10px 0', marginTop: 3, fontSize: 12, fontWeight: 700, color: '#0e756c', cursor: 'pointer', textDecoration: 'underline' }}>
                {qrUploadLabel}
                <input type="file" accept="image/*" onChange={onUploadQr} style={{ display: 'none' }} />
              </label>
            </div>
          </div>

          {/* Follow-up */}
          <h3 style={{ ...h3Style, margin: '24px 0 16px' }}>Follow-up</h3>
          <div style={{ display: 'grid', gridTemplateColumns: FLUID_GRID_2COL, gap: 16 }}>
            <div>
              <label style={labelStyle}>Treatment stage</label>
              <select value={cform.treatmentStage} onChange={(e) => onSetField('treatmentStage', e.target.value)} style={fieldStyle}>
                <option value="">Select…</option>
                {TREATMENT_STAGES.map((ts) => <option key={ts} value={ts}>{ts}</option>)}
              </select>
            </div>
            {cform.treatmentStage === 'Complete' && (
              <div>
                <label style={labelStyle}>Google review taken</label>
                <select value={cform.googleReviewTaken} onChange={(e) => onSetField('googleReviewTaken', e.target.value)} style={fieldStyle}>
                  <option value="">Select…</option>
                  {YES_NO.map((yn) => <option key={yn} value={yn}>{yn}</option>)}
                </select>
              </div>
            )}
            {(cform.treatmentStage === 'In Progress' || cform.treatmentStage === 'Follow Up Pending') && (
              <>
                <div>
                  <label style={labelStyle}>Next appointment date</label>
                  <input type="date" value={cform.nextAppointment} onChange={(e) => onSetField('nextAppointment', e.target.value)} style={fieldStyle} />
                  {showApptCount && <p style={{ marginTop: 7, fontSize: 13, color: '#0e756c', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: '#12a094' }} />{apptCountText}</p>}
                </div>
                {cform.nextAppointment && (
                  <div>
                    <label style={labelStyle}>Next appointment time</label>
                    <TimePicker12h value={cform.nextAppointmentTime} onChange={(v) => onSetField('nextAppointmentTime', v)} />
                  </div>
                )}
                <div style={{ gridColumn: '1 / -1' }}>
                  <NextAppointmentNotice
                    patientName={cur.name}
                    mobile={cur.mobile}
                    date={cform.nextAppointment}
                    time={cform.nextAppointmentTime}
                    prevDate={savedAppt.date}
                    prevTime={savedAppt.time}
                  />
                </div>
              </>
            )}
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Comments</label>
              <textarea value={cform.comments || ''} onChange={(e) => onSetField('comments', e.target.value)} placeholder="Any notes for this visit…" style={{ ...fieldStyle, minHeight: 84, resize: 'vertical' }} />
            </div>
          </div>

          {/* Lab Requirements accordion */}
          <div style={{ marginTop: 24, border: '1px solid #e2efec', borderRadius: 14, overflow: 'hidden' }}>
            <button onClick={() => setLabOpen((o) => !o)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 16px', background: '#f7fbfa', cursor: 'pointer', border: 0, textAlign: 'left' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 16, color: '#0e3b39' }}>Lab Requirements</span>
                {(cform.labName || cform.labDescription || cform.labToothNumber) && (
                  <span style={{ padding: '3px 10px', borderRadius: 100, fontSize: 11.5, fontWeight: 700, background: '#e6f4f2', color: '#0e756c' }}>Added</span>
                )}
              </span>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#0e756c" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'transform .2s', transform: labOpen ? 'rotate(180deg)' : 'rotate(0)' }}><path d="M6 9l6 6 6-6" /></svg>
            </button>
            {labOpen && (
              <div style={{ padding: '16px', borderTop: '1px solid #e2efec', display: 'grid', gridTemplateColumns: FLUID_GRID_2COL, gap: 16 }}>
                <div>
                  <label style={labelStyle}>Lab name</label>
                  <select value={cform.labName} onChange={(e) => onSetField('labName', e.target.value)} style={fieldStyle}>
                    <option value="">Select…</option>
                    {(labNames || []).map((ln) => <option key={ln} value={ln}>{ln}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Tooth number</label>
                  {/* Auto-populated from the derived toothNumber, which now uses FDI
                      numbering from the tooth picker. Merge those values into the
                      option list so pre-filled teeth still render as selected. */}
                  <MultiSelect value={cform.labToothNumber || cform.toothNumber || []} options={labToothOptions} onChange={(v) => onSetField('labToothNumber', v)} placeholder="Select…" searchable />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={labelStyle}>Description</label>
                  <input value={cform.labDescription || ''} onChange={(e) => onSetField('labDescription', e.target.value)} placeholder="Shade, material, due date…" style={fieldStyle} />
                </div>
              </div>
            )}
          </div>

          {/* Documents */}
          <h3 style={{ ...h3Style, margin: '24px 0 6px' }}>Documents</h3>
          <p style={{ fontSize: 13, color: '#98b0ab', marginBottom: 12 }}>Attach X-rays, prescriptions or medical reports for this visit.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input ref={fileInputRef} type="file" accept="image/*,application/pdf" multiple onChange={onUploadDocs} style={{ display: 'none' }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
            {uploadRows.map((ur) => {
              const rowDocs = documents.filter(d => d.rowId === ur.rowId);
              const hasFiles = rowDocs.length > 0;
              const isUploading = uploadingRowIds.includes(ur.rowId);
              const fileLabel = hasFiles ? (rowDocs.length === 1 ? rowDocs[0].name : rowDocs[0].name.split('.')[0] + ' + ' + (rowDocs.length - 1) + ' more') : '';
              return (
                <div key={ur.rowId} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <select value={ur.kind} onChange={(e) => setUploadRowKind(ur.rowId, e.target.value)} style={{ flex: '0 1 190px', padding: '11px 13px', border: '1px solid #d6e7e3', borderRadius: 10, fontSize: 14.5, background: '#f7fbfa' }}>
                    {DOC_KINDS.map((dk) => <option key={dk} value={dk}>{dk}</option>)}
                  </select>
                  <button onClick={() => triggerUpload(ur.rowId, ur.kind)} disabled={isUploading} style={{ padding: '11px 18px', borderRadius: 10, border: '1px solid #cfe3df', background: isUploading ? '#e2efec' : '#f2f9f8', color: '#0e756c', fontWeight: 700, fontSize: 14, cursor: isUploading ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, opacity: isUploading ? 0.7 : 1 }}>
                    {isUploading ? (
                      <div style={{ width: 16, height: 16, border: '2.5px solid #cfe3df', borderTopColor: '#0e756c', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
                    )}
                    {isUploading ? 'Uploading...' : (hasFiles ? 'Replace file' : 'Upload file')}
                  </button>
                  {hasFiles && !isUploading && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, maxWidth: 240, padding: '8px 12px', borderRadius: 9, background: '#e6f4f2', color: '#0e756c', fontSize: 13, fontWeight: 600 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M20 6L9 17l-5-5"/></svg>
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{fileLabel}</span>
                    </span>
                  )}
                  {uploadRows.length > 1 && (
                    <button onClick={() => removeUploadRow(ur.rowId)} title="Remove this row" style={{ width: 36, height: 38, borderRadius: 10, border: '1px solid #d6e7e3', background: '#fff', color: '#8aa8a3', fontSize: 14, cursor: 'pointer' }}>✕</button>
                  )}
                </div>
              );
            })}
          </div>
          <button onClick={addUploadRow} style={{ marginTop: 10, padding: '9px 15px', borderRadius: 10, border: '1px dashed #cfe3df', background: '#f7fbfa', color: '#0e756c', fontWeight: 700, fontSize: 13.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
            Add another document
          </button>
          {documents.length === 0 && <p style={{ fontSize: 13.5, color: '#98b0ab', marginTop: 12 }}>No documents attached yet.</p>}
          {documents.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 12, marginTop: 14 }}>
              {documents.map((d, i) => (
                <div key={i} style={{ border: '1px solid #e2efec', borderRadius: 12, overflow: 'hidden', background: '#fbfdfd' }}>
                  <a href={d.dataUrl || '#'} onClick={d.s3Key ? (ev) => { ev.preventDefault(); getDocumentUrl(d.s3Key).then(u => u && window.open(u, '_blank')).catch(() => {}); } : undefined} target="_blank" rel="noopener noreferrer" style={{ display: 'block', height: 92, background: '#eef4f3', overflow: 'hidden', cursor: 'pointer' }}>
                    {/^image/i.test(d.type) && d.dataUrl
                      ? <img src={d.dataUrl} alt={d.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <span style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8aa8a3', fontSize: 12, fontWeight: 700 }}>{d.s3Key ? 'S3' : (/^image/i.test(d.type) ? 'IMG' : 'PDF')}</span>
                    }
                  </a>
                  <div style={{ padding: '9px 11px' }}>
                    <span style={{ display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: '#0e756c' }}>{d.kind}</span>
                    <span style={{ display: 'block', fontSize: 12.5, color: '#5c7a76', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
                    <button onClick={() => removeDoc(i)} style={{ marginTop: 6, border: 0, background: 'none', padding: 0, color: '#c0392b', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>Remove</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Read-only view (for appointments) ── */}
      {readOnly && (
        <div style={{ background: '#fff', border: '1px solid #dfece9', borderRadius: 18, padding: 24, marginTop: 16 }}>
          <h3 style={{ ...h3Style, marginBottom: 16 }}>Billing</h3>
          <div style={{ display: 'grid', gridTemplateColumns: FLUID_GRID_2COL, gap: 16 }}>
            <div><label style={labelStyle}>Treatment cost</label><div style={{ ...fieldStyle, ...roStyle }}>{cform.treatmentCost ? inr(num(cform.treatmentCost)) : '—'}</div></div>
            <div><label style={labelStyle}>Amount paid</label><div style={{ ...fieldStyle, ...roStyle }}>{cform.amountPaid ? inr(num(cform.amountPaid)) : '—'}</div></div>
            <div><label style={labelStyle}>Payment mode</label><div style={{ ...fieldStyle, ...roStyle }}>{cform.paymentMode || '—'}</div></div>
            <div><label style={labelStyle}>Payment status</label><div style={{ ...fieldStyle, ...roStyle }}>{cform.paymentStatus || '—'}</div></div>
          </div>
        </div>
      )}

      {/* ── Saved flash ── */}
      {savedFlash && <p style={{ marginTop: 14, color: '#0e756c', fontSize: 14, fontWeight: 700 }}>✓ Record saved.</p>}
      {error && <p style={{ marginTop: 14, color: '#c0392b', fontSize: 14, fontWeight: 600 }}>{error}</p>}

      {/* ── Footer buttons ── */}
      {readOnly ? (
        <div style={{ display: 'flex', gap: 12, marginTop: 20, justifyContent: 'flex-end' }}>
          <button onClick={onGoBack} style={{ ...TOUCH_BTN, padding: '11px 20px', borderRadius: 10, border: '1px solid #d6e7e3', background: '#fff', color: '#5c7a76', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Back</button>
          <button onClick={onCreateNewVisit} style={{ ...TOUCH_BTN, padding: '11px 22px', borderRadius: 10, border: 0, background: '#12a094', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Create New Visit</button>
        </div>
      ) : step === 2 ? (
        <div style={{ display: 'flex', gap: 12, marginTop: 20, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <button onClick={() => { setStep(1); scrollToTop(); }} style={{ padding: '11px 20px', borderRadius: 10, border: '1px solid #cfe3df', background: '#f2f9f8', color: '#0e756c', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>← Back to Doctor's form</button>
          <div style={{ display: 'flex', gap: 12 }}>
            <button onClick={onGoBack} style={{ ...TOUCH_BTN, padding: '11px 20px', borderRadius: 10, border: '1px solid #d6e7e3', background: '#fff', color: '#5c7a76', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Cancel</button>
            {/* Saving mid-upload writes a document record with neither an
                s3Key nor a dataUrl, so the file is silently lost. Block it. */}
            <button onClick={onSaveClinical} disabled={saving || splitBlocked || uploadBusy} style={{ ...TOUCH_BTN, padding: '11px 22px', borderRadius: 10, border: 0, background: (saving || splitBlocked || uploadBusy) ? '#b8d0cd' : '#0e756c', color: '#fff', fontWeight: 700, fontSize: 14, cursor: (saving || splitBlocked || uploadBusy) ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {uploadBusy && (
                <span style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid rgba(255,255,255,.5)', borderTopColor: '#fff', animation: 'spin .7s linear infinite' }} />
              )}
              {saving ? 'Saving…' : (uploadBusy ? 'Uploading…' : 'Save')}
            </button>
          </div>
        </div>
      ) : null}

      {/* ── Modals ── */}
      {rxOpen && <PrescriptionSheet rx={buildRx(cform, meta)} onClose={() => setRxOpen(false)} clinicName={clinicName || ''} clinicAddress={clinicAddress || ''} doctorName={doctorName} doctorQualification={doctorQualification} rxTemplateUrl={rxTemplateUrl} hasDocxTemplate={hasDocxTemplate} />}
      {rcOpen && <ReceiptSheet receipt={buildReceipt(cform, meta)} onClose={() => setRcOpen(false)} clinicName={clinicName || ''} clinicAddress={clinicAddress || ''} doctorName={doctorName} hasReceiptTemplate={hasReceiptTemplate} onPaymentSaved={onPaymentSaved} />}
      {viewDoc && viewDoc.kind === 'rx' && <PrescriptionSheet rx={viewDoc.data} onClose={() => setViewDoc(null)} clinicName={clinicName || ''} clinicAddress={clinicAddress || ''} doctorName={doctorName} doctorQualification={doctorQualification} rxTemplateUrl={rxTemplateUrl} hasDocxTemplate={hasDocxTemplate} />}
      {viewDoc && viewDoc.kind === 'receipt' && <ReceiptSheet receipt={viewDoc.data} onClose={() => setViewDoc(null)} clinicName={clinicName || ''} clinicAddress={clinicAddress || ''} doctorName={doctorName} hasReceiptTemplate={hasReceiptTemplate} />}

      {detail && (
        <div onClick={() => setDetailVisit(null)} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(14,59,57,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 20, padding: 0, maxWidth: 480, width: '100%', maxHeight: '82vh', overflow: 'auto' }}>
            <div style={{ position: 'sticky', top: 0, background: '#0e3b39', color: '#fff', padding: '18px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderRadius: '20px 20px 0 0' }}>
              <div>
                <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 13, color: '#7fd4c9', fontWeight: 700 }}>{detail.title}</span>
                <h3 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 17 }}>{detail.name} · {detail.dateLabel}</h3>
              </div>
              <button onClick={() => setDetailVisit(null)} style={{ width: 32, height: 32, borderRadius: 8, border: 0, background: 'rgba(255,255,255,.15)', color: '#fff', fontSize: 16, cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ padding: '8px 22px 22px' }}>
              {detail.rows.map((r) => (
                <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '11px 0', borderBottom: '1px solid #f0f6f5' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#8aa8a3', flex: '0 0 auto' }}>{r.k}</span>
                  <span style={{ fontSize: 14, color: '#33534f', textAlign: 'right' }}>{r.v}</span>
                </div>
              ))}
              {detail.hasDocs && (
                <div style={{ marginTop: 14 }}>
                  <span style={{ display: 'block', fontSize: 12, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#8aa8a3', marginBottom: 8 }}>Documents</span>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 10 }}>
                    {detail.docs.map((d) => (
                      <a key={d.idx} href={d.href || '#'} onClick={d.s3Key ? (ev) => { ev.preventDefault(); getDocumentUrl(d.s3Key).then(u => u && window.open(u, '_blank')).catch(() => {}); } : undefined} target="_blank" rel="noopener noreferrer" style={{ border: '1px solid #e2efec', borderRadius: 11, overflow: 'hidden', background: '#fbfdfd', display: 'block', cursor: 'pointer' }}>
                        <span style={{ display: 'block', height: 76, background: '#eef4f3', overflow: 'hidden' }}>
                          {d.isImage && d.href ? <img src={d.href} alt={d.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8aa8a3', fontSize: 12, fontWeight: 700 }}>{d.s3Key ? 'S3' : 'PDF'}</span>}
                        </span>
                        <span style={{ display: 'block', padding: '7px 9px' }}>
                          <span style={{ display: 'block', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', color: '#0e756c' }}>{d.kind}</span>
                          <span style={{ display: 'block', fontSize: 12, color: '#5c7a76', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showQr && (
        <div onClick={onCloseQr} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(14,59,57,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 20, padding: 24, maxWidth: 360, width: '100%', textAlign: 'center' }}>
            <h3 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 18, color: '#0e3b39' }}>Scan to pay via UPI</h3>
            {hasQr && <img src={qrUrl} alt="UPI QR scanner" style={{ width: '100%', maxWidth: 280, margin: '16px auto 0', borderRadius: 12, display: 'block' }} />}
            {noQr && <p style={{ color: '#8aa8a3', fontSize: 14, margin: '18px 0' }}>No scanner uploaded yet. Use "Upload scanner" under the UPI scanner tile to add one.</p>}
            <button onClick={onCloseQr} style={{ ...TOUCH_BTN, marginTop: 18, padding: '11px 22px', borderRadius: 10, border: 0, background: '#0e3b39', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* Normalize clinical record for backward compat */
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
  const out = { ...c };
  ['chiefComplaint', 'treatmentGroup', 'treatment', 'advisedTreatment', 'toothNumber'].forEach(k => {
    let v = tryParseJson(out[k]);
    out[k] = Array.isArray(v) ? v : (v ? [v] : []);
  });
  // Legacy records predate per-treatment tooth tagging — normalize to {}.
  ['treatmentTeeth', 'advisedTeeth'].forEach(k => {
    const v = tryParseObj(out[k]);
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  });
  out.diagnosis = out.diagnosis || '';
  out.investigation = out.investigation || '';
  out.medicines = Array.isArray(out.medicines) ? out.medicines : tryParseJson(out.medicines) || [];
  out.paySplits = Array.isArray(out.paySplits) ? out.paySplits : tryParseJson(out.paySplits) || [];
  out.documents = Array.isArray(out.documents) ? out.documents : tryParseJson(out.documents) || [];
  return out;
}

export { buildRx, buildReceipt, normalizeClinical, ReceiptSheet, PrescriptionSheet, trTeethLabel, advTeethLabel };
