/**
 * Clinic Console — Google Sheets backend.
 *
 * Bound to a Google Sheet. Deploy as a Web App (Extensions > Apps Script,
 * paste this file, then Deploy > New deployment > Web app). See
 * ../apps-script/README.md for the full setup walkthrough.
 *
 * Sheets used (auto-created on first call if missing):
 *   Patients: patientId | mobile | name | age | gender | createdAt
 *   Visits:   visitId | patientId | visitNo | date | createdAt | done |
 *             chiefDescription | chiefComplaint | treatmentGroup | treatment |
 *             toothNumber | treatmentOther | treatmentCost | amountPaid |
 *             balanceDue | paymentMode | paymentStatus | treatmentStage |
 *             googleReviewTaken | nextAppointment | comments
 *   Settings: key | value   (rows: seq, upiQr)
 *
 * API (all responses are JSON):
 *   GET  ?action=list                      -> full snapshot
 *   POST { action: 'saveIntake', mobile, name, age, gender, date }
 *   POST { action: 'saveClinical', patientId, visitId, cform }
 *   POST { action: 'uploadQr', dataUrl, filename }
 *
 * POST bodies must be sent with Content-Type: text/plain from the browser
 * (not application/json) so the request stays a CORS "simple request" and
 * Apps Script doesn't 404 on the preflight OPTIONS it can't handle.
 */

var PATIENTS_SHEET = 'Patients';
var VISITS_SHEET = 'Visits';
var SETTINGS_SHEET = 'Settings';
var QR_FOLDER_NAME = 'Clinic Console QR';

var PATIENTS_HEADERS = ['patientId', 'mobile', 'name', 'age', 'gender', 'email', 'createdAt'];
var VISITS_HEADERS = [
  'visitId', 'patientId', 'patientName', 'patientAge', 'patientGender',
  'visitNo', 'date', 'createdAt', 'done',
  'patientType', 'medicalHistory', 'chiefDescription', 'chiefComplaint', 'treatmentGroup', 'treatment', 'advisedTreatment', 'toothNumber', 'treatmentOther', 'advisedTreatmentOther',
  'treatmentCost', 'amountPaid', 'balanceDue',
  'paymentMode', 'paymentStatus', 'treatmentStage', 'googleReviewTaken',
  'nextAppointment', 'nextAppointmentTime', 'comments',
  'labName', 'labToothNumber', 'labDescription',
  'calendarEventId',
  'patientProblem', 'queueNumber',
  'medicines', 'paySplits', 'documents',
];

function doGet(e) {
  try {
    var action = e && e.parameter && e.parameter.action;
    if (action === 'list') return jsonOut_(action_list_());
    return jsonOut_({ ok: false, error: 'Unknown or missing action: ' + action });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var action = body.action;
    if (action === 'saveIntake') return jsonOut_(action_saveIntake_(body));
    if (action === 'saveClinical') return jsonOut_(action_saveClinical_(body));
    if (action === 'uploadQr') return jsonOut_(action_uploadQr_(body));
    if (action === 'portalCheckin') return jsonOut_(action_portalCheckin_(body));
    if (action === 'savePatientProblem') return jsonOut_(action_savePatientProblem_(body));
    if (action === 'sendOtp') return jsonOut_(action_sendOtp_(body));
    if (action === 'verifyOtp') return jsonOut_(action_verifyOtp_(body));
    return jsonOut_({ ok: false, error: 'Unknown or missing action: ' + action });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message || err) });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- sheet plumbing ----------

function getSS_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function ensureSheet_(name, headers) {
  var ss = getSS_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function ensureColumns_(sh, headers) {
  var existing = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var set = {};
  existing.forEach(function (h) { set[String(h).trim()] = true; });
  for (var i = 0; i < headers.length; i++) {
    if (!set[headers[i]]) {
      sh.getRange(1, sh.getLastColumn() + 1).setValue(headers[i]);
    }
  }
}

function ensureAllSheets_() {
  ensureSheet_(PATIENTS_SHEET, PATIENTS_HEADERS);
  var visitsSh = ensureSheet_(VISITS_SHEET, VISITS_HEADERS);
  ensureColumns_(visitsSh, VISITS_HEADERS);
  var settings = ensureSheet_(SETTINGS_SHEET, ['key', 'value']);
  var map = settingsMap_(settings);
  if (!('seq' in map)) settings.appendRow(['seq', 0]);
  if (!('upiQr' in map)) settings.appendRow(['upiQr', '']);
}

function headerIndex_(sh) {
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = {};
  for (var i = 0; i < headers.length; i++) idx[String(headers[i]).trim()] = i;
  return idx;
}

function sheetRows_(sh) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { idx: headerIndex_(sh), rows: [] };
  var lastCol = sh.getLastColumn();
  var values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return { idx: headerIndex_(sh), rows: values };
}

function rowToObj_(idx, row) {
  var o = {};
  for (var key in idx) o[key] = row[idx[key]];
  return o;
}

function settingsMap_(sh) {
  var data = sheetRows_(sh);
  var map = {};
  data.rows.forEach(function (r) {
    map[r[data.idx.key]] = r[data.idx.value];
  });
  return map;
}

function setSetting_(sh, key, value) {
  var data = sheetRows_(sh);
  for (var i = 0; i < data.rows.length; i++) {
    if (data.rows[i][data.idx.key] === key) {
      sh.getRange(i + 2, data.idx.value + 1).setValue(value);
      return;
    }
  }
  sh.appendRow([key, value]);
}

// ---------- read model (mirrors the prototype's db.patients/db.order shape) ----------

function readSnapshot_() {
  var patientsSh = ensureSheet_(PATIENTS_SHEET, PATIENTS_HEADERS);
  var visitsSh = ensureSheet_(VISITS_SHEET, VISITS_HEADERS);
  var settingsSh = ensureSheet_(SETTINGS_SHEET, ['key', 'value']);

  var pData = sheetRows_(patientsSh);
  var vData = sheetRows_(visitsSh);
  var settings = settingsMap_(settingsSh);

  var patients = {};
  var order = [];
  pData.rows.forEach(function (row) {
    var p = rowToObj_(pData.idx, row);
    if (!p.patientId) return;
    patients[p.patientId] = {
      patientId: p.patientId,
      mobile: String(p.mobile || ''),
      name: p.name || '',
      age: p.age === '' ? '' : p.age,
      gender: p.gender || '',
      email: p.email || '',
      visits: [],
    };
    order.push(p.patientId);
  });

  vData.rows.forEach(function (row) {
    var v = rowToObj_(vData.idx, row);
    if (!v.visitId || !patients[v.patientId]) return;
    patients[v.patientId].visits.push({
      visitId: v.visitId,
      no: v.visitNo,
      date: v.date instanceof Date ? formatDate_(v.date) : String(v.date || ''),
      createdAt: v.createdAt instanceof Date ? v.createdAt.toISOString() : String(v.createdAt || ''),
      done: v.done === true || v.done === 'TRUE' || v.done === 'true',
      clinical: {
        patientType: v.patientType || '',
        medicalHistory: v.medicalHistory || '',
        chiefComplaint: parseJsonOrString_(v.chiefComplaint),
        chiefDescription: v.chiefDescription || '',
        treatmentGroup: parseJsonOrString_(v.treatmentGroup),
        treatment: parseJsonOrString_(v.treatment),
        advisedTreatment: parseJsonOrString_(v.advisedTreatment),
        toothNumber: parseJsonOrString_(v.toothNumber instanceof Date ? '' : String(v.toothNumber || '')),
        treatmentOther: v.treatmentOther || '',
        advisedTreatmentOther: v.advisedTreatmentOther || '',
        treatmentCost: v.treatmentCost === '' ? '' : String(v.treatmentCost),
        amountPaid: v.amountPaid === '' ? '' : String(v.amountPaid),
        balanceDue: v.balanceDue === '' ? '' : String(v.balanceDue),
        paymentMode: v.paymentMode || '',
        paymentStatus: v.paymentStatus || '',
        treatmentStage: v.treatmentStage || '',
        googleReviewTaken: v.googleReviewTaken || '',
        nextAppointment: v.nextAppointment instanceof Date ? formatDate_(v.nextAppointment) : String(v.nextAppointment || ''),
        nextAppointmentTime: v.nextAppointmentTime instanceof Date ? Utilities.formatDate(v.nextAppointmentTime, Session.getScriptTimeZone(), 'HH:mm') : String(v.nextAppointmentTime || ''),
        comments: v.comments || '',
        labName: v.labName || '',
        labToothNumber: v.labToothNumber instanceof Date ? '' : String(v.labToothNumber || ''),
        labDescription: v.labDescription || '',
        patientProblem: v.patientProblem || '',
        medicines: parseJsonArr_(v.medicines),
        paySplits: parseJsonArr_(v.paySplits),
        documents: parseJsonArr_(v.documents),
      },
      queueNumber: v.queueNumber === '' ? '' : (typeof v.queueNumber === 'number' ? v.queueNumber : (parseInt(v.queueNumber, 10) || '')),
    });
  });

  for (var pid in patients) {
    patients[pid].visits.sort(function (a, b) { return (a.no || 0) - (b.no || 0); });
  }

  var labNamesRaw = settings.labNames || '';
  var labNames = labNamesRaw ? labNamesRaw.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];

  return {
    ok: true,
    patients: patients,
    order: order,
    seq: Number(settings.seq || 0),
    upiQr: settings.upiQr || '',
    labNames: labNames,
  };
}

function formatDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd');
}

function parseJsonArr_(val) {
  if (!val || val === '') return [];
  try { var parsed = JSON.parse(val); return Array.isArray(parsed) ? parsed : []; }
  catch (e) { return []; }
}

function parseJsonOrString_(val) {
  if (!val || val === '') return [];
  var s = String(val);
  if (s.charAt(0) === '[') {
    try { var parsed = JSON.parse(s); if (Array.isArray(parsed)) return parsed; } catch (e) {}
  }
  return [s];
}

// ---------- Google Calendar integration ----------

function getClinicCalendar_() {
  var settingsSh = ensureSheet_(SETTINGS_SHEET, ['key', 'value']);
  var settings = settingsMap_(settingsSh);
  var calId = settings.calendarId || '';
  if (calId) {
    try {
      var cal = CalendarApp.getCalendarById(calId);
      if (cal) return cal;
    } catch (e) {}
  }
  var cal = CalendarApp.createCalendar('PatientPad Appointments');
  setSetting_(settingsSh, 'calendarId', cal.getId());
  return cal;
}

function syncCalendarEvent_(visitId, patientName, nextAppt, nextApptTime, treatment, existingEventId) {
  var settingsSh = ensureSheet_(SETTINGS_SHEET, ['key', 'value']);
  var settings = settingsMap_(settingsSh);
  var cal = getClinicCalendar_();
  var guests = (settings.allowedEmails || '').split(',').map(function (e) { return e.trim(); }).filter(Boolean);

  if (!nextAppt) {
    if (existingEventId) {
      try { var ev = cal.getEventById(existingEventId); if (ev) ev.deleteEvent(); } catch (e) {}
    }
    return '';
  }

  var h = 9, m = 0;
  if (nextApptTime) {
    var ampmMatch = nextApptTime.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (ampmMatch) {
      h = parseInt(ampmMatch[1], 10);
      m = parseInt(ampmMatch[2], 10) || 0;
      var isPM = ampmMatch[3].toUpperCase() === 'PM';
      if (isPM && h !== 12) h += 12;
      if (!isPM && h === 12) h = 0;
    } else {
      var p = nextApptTime.split(':');
      h = parseInt(p[0], 10) || 9;
      m = parseInt(p[1], 10) || 0;
    }
  }
  var start = new Date(nextAppt + 'T' + ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2) + ':00');
  var end = new Date(start.getTime() + 30 * 60000);
  var title = patientName + ' — ' + (treatment || 'Appointment');
  var desc = 'Visit: ' + visitId + '\nPatient: ' + patientName + '\nTreatment: ' + (treatment || '—');

  if (existingEventId) {
    try {
      var ev = cal.getEventById(existingEventId);
      if (ev) {
        ev.setTitle(title);
        ev.setDescription(desc);
        ev.setTime(start, end);
        return existingEventId;
      }
    } catch (e) {}
  }

  var opts = { description: desc };
  if (guests.length) { opts.guests = guests.join(','); opts.sendInvites = true; }
  var ev = cal.createEvent(title, start, end, opts);
  return ev.getId();
}

// ---------- actions ----------

function action_list_() {
  ensureAllSheets_();
  return readSnapshot_();
}

function normMobile_(m) {
  return String(m || '').replace(/\D/g, '');
}

function action_saveIntake_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureAllSheets_();
    var mobile = normMobile_(body.mobile);
    var name = String(body.name || '').trim();
    var age = body.age;
    var gender = String(body.gender || '');
    var date = String(body.date || '');
    if (!mobile) return { ok: false, error: 'Mobile number is required.' };
    if (!name || String(age).trim() === '' || !gender || !date) {
      return { ok: false, error: 'Name, age, gender and date are required.' };
    }

    var patientsSh = ensureSheet_(PATIENTS_SHEET, PATIENTS_HEADERS);
    var visitsSh = ensureSheet_(VISITS_SHEET, VISITS_HEADERS);
    var settingsSh = ensureSheet_(SETTINGS_SHEET, ['key', 'value']);

    var pData = sheetRows_(patientsSh);
    var patientId = null;
    var rowIdx = -1;
    var nameToMatch = name.toLowerCase();
    for (var i = 0; i < pData.rows.length; i++) {
      if (String(pData.rows[i][pData.idx.mobile]) === mobile &&
          String(pData.rows[i][pData.idx.name] || '').trim().toLowerCase() === nameToMatch) {
        patientId = pData.rows[i][pData.idx.patientId];
        rowIdx = i;
        break;
      }
    }

    if (patientId) {
      var r = rowIdx + 2;
      patientsSh.getRange(r, pData.idx.age + 1).setValue(age);
      patientsSh.getRange(r, pData.idx.gender + 1).setValue(gender);
    } else {
      var settings = settingsMap_(settingsSh);
      var seq = Number(settings.seq || 0) + 1;
      patientId = 'P' + ('0000' + seq).slice(-4);
      var pIdx = headerIndex_(patientsSh);
      var pNumCols = patientsSh.getLastColumn();
      var pNewRow = new Array(pNumCols).fill('');
      var setPCol = function (key, val) { if (pIdx[key] !== undefined) pNewRow[pIdx[key]] = val; };
      setPCol('patientId', patientId);
      setPCol('mobile', mobile);
      setPCol('name', name);
      setPCol('age', age);
      setPCol('gender', gender);
      setPCol('createdAt', new Date().toISOString());
      patientsSh.appendRow(pNewRow);
      setSetting_(settingsSh, 'seq', seq);
    }

    var vData = sheetRows_(visitsSh);
    var vIdx = headerIndex_(visitsSh);
    var visitNo = 1;
    vData.rows.forEach(function (row) {
      if (row[vData.idx.patientId] === patientId) visitNo++;
    });
    var visitId = patientId + '_' + visitNo;
    var numCols = visitsSh.getLastColumn();
    var newRow = new Array(numCols).fill('');
    var setCol = function (key, val) { if (vIdx[key] !== undefined) newRow[vIdx[key]] = val; };
    setCol('visitId', visitId);
    setCol('patientId', patientId);
    setCol('visitNo', visitNo);
    setCol('date', date);
    setCol('createdAt', new Date().toISOString());
    setCol('done', false);
    setCol('patientName', name);
    setCol('patientGender', gender);
    setCol('patientAge', age);
    visitsSh.appendRow(newRow);

    var snap = readSnapshot_();
    snap.patientId = patientId;
    snap.visitId = visitId;
    return snap;
  } finally {
    lock.releaseLock();
  }
}

function action_saveClinical_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureAllSheets_();
    var patientId = String(body.patientId || '');
    var visitId = String(body.visitId || '');
    var cform = body.cform || {};
    if (!patientId || !visitId) return { ok: false, error: 'Missing patient or visit id.' };

    var visitsSh = ensureSheet_(VISITS_SHEET, VISITS_HEADERS);
    var vData = sheetRows_(visitsSh);

    var num = function (x) { var n = parseFloat(x); return isNaN(n) ? 0 : n; };
    var targetRow = -1;
    var otherVisits = [];
    for (var i = 0; i < vData.rows.length; i++) {
      var row = vData.rows[i];
      if (row[vData.idx.patientId] !== patientId) continue;
      if (row[vData.idx.visitId] === visitId) { targetRow = i; continue; }
      otherVisits.push({ visitNo: num(row[vData.idx.visitNo]), cost: num(row[vData.idx.treatmentCost]), paid: num(row[vData.idx.amountPaid]) });
    }
    if (targetRow === -1) return { ok: false, error: 'Visit not found: ' + visitId };
    otherVisits.sort(function (a, b) { return a.visitNo - b.visitNo; });
    var prevPending = 0;
    otherVisits.forEach(function (v) {
      prevPending += v.cost - v.paid;
      if (prevPending < 0) prevPending = 0;
    });

    var amountToCollect = num(cform.treatmentCost) + prevPending;
    var remaining = amountToCollect - num(cform.amountPaid);
    var balanceDue = remaining;
    var paymentStatus = remaining <= 0 ? 'Fully Paid' : (num(cform.amountPaid) > 0 ? 'Partially paid' : 'Not paid');
    var r = targetRow + 2;
    var jsonField = function(val) { return Array.isArray(val) ? JSON.stringify(val) : (val || ''); };
    var fields = {
      patientType: cform.patientType || '',
      medicalHistory: cform.medicalHistory || '',
      chiefComplaint: jsonField(cform.chiefComplaint),
      chiefDescription: cform.chiefDescription || '',
      treatmentGroup: jsonField(cform.treatmentGroup),
      treatment: jsonField(cform.treatment),
      advisedTreatment: jsonField(cform.advisedTreatment),
      toothNumber: jsonField(cform.toothNumber),
      treatmentOther: cform.treatmentOther || '',
      advisedTreatmentOther: cform.advisedTreatmentOther || '',
      treatmentCost: cform.treatmentCost || '',
      amountPaid: cform.amountPaid || '',
      balanceDue: String(balanceDue),
      paymentMode: cform.paymentMode || '',
      paymentStatus: paymentStatus,
      treatmentStage: cform.treatmentStage || '',
      googleReviewTaken: cform.googleReviewTaken || '',
      nextAppointment: cform.nextAppointment || '',
      nextAppointmentTime: cform.nextAppointmentTime || '',
      comments: cform.comments || '',
      labName: cform.labName || '',
      labToothNumber: cform.labToothNumber || '',
      labDescription: cform.labDescription || '',
      medicines: JSON.stringify(cform.medicines || []),
      paySplits: JSON.stringify(cform.paySplits || []),
      documents: JSON.stringify(cform.documents || []),
      done: true,
    };
    for (var key in fields) {
      if (vData.idx[key] === undefined) continue;
      var cell = visitsSh.getRange(r, vData.idx[key] + 1);
      if (key === 'toothNumber' || key === 'labToothNumber' || key === 'nextAppointmentTime' || key === 'medicines' || key === 'paySplits' || key === 'documents' || key === 'chiefComplaint' || key === 'treatmentGroup' || key === 'treatment' || key === 'advisedTreatment') cell.setNumberFormat('@');
      cell.setValue(fields[key]);
    }

    var patientsSh = ensureSheet_(PATIENTS_SHEET, PATIENTS_HEADERS);
    var pData = sheetRows_(patientsSh);
    var patientName = '', patientGender = '', patientAge = '';
    for (var pi = 0; pi < pData.rows.length; pi++) {
      if (pData.rows[pi][pData.idx.patientId] === patientId) {
        patientName = pData.rows[pi][pData.idx.name] || '';
        patientGender = pData.rows[pi][pData.idx.gender] || '';
        patientAge = pData.rows[pi][pData.idx.age];
        if (patientAge === undefined || patientAge === null) patientAge = '';
        break;
      }
    }
    if (vData.idx.patientName !== undefined) visitsSh.getRange(r, vData.idx.patientName + 1).setValue(patientName);
    if (vData.idx.patientGender !== undefined) visitsSh.getRange(r, vData.idx.patientGender + 1).setValue(patientGender);
    if (vData.idx.patientAge !== undefined) visitsSh.getRange(r, vData.idx.patientAge + 1).setValue(String(patientAge));

    try {
      var shouldHaveEvent = (fields.treatmentStage === 'In Progress' || fields.treatmentStage === 'Follow Up Pending') && fields.nextAppointment;
      var existingEventId = (vData.idx.calendarEventId !== undefined)
        ? String(vData.rows[targetRow][vData.idx.calendarEventId] || '') : '';

      if (shouldHaveEvent || existingEventId) {
        var newEventId = syncCalendarEvent_(
          visitId, patientName,
          shouldHaveEvent ? fields.nextAppointment : '',
          shouldHaveEvent ? fields.nextAppointmentTime : '',
          fields.treatment, existingEventId
        );
        if (vData.idx.calendarEventId !== undefined) {
          visitsSh.getRange(r, vData.idx.calendarEventId + 1).setValue(newEventId);
        }
      }
    } catch (calErr) {
      // Calendar sync is non-critical — don't fail the save
    }

    return readSnapshot_();
  } finally {
    lock.releaseLock();
  }
}

function action_uploadQr_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureAllSheets_();
    var dataUrl = String(body.dataUrl || '');
    var m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return { ok: false, error: 'Invalid image data.' };
    var mimeType = m[1];
    var bytes = Utilities.base64Decode(m[2]);
    var filename = String(body.filename || 'upi-qr');

    var folders = DriveApp.getFoldersByName(QR_FOLDER_NAME);
    var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(QR_FOLDER_NAME);

    var blob = Utilities.newBlob(bytes, mimeType, filename);
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var url = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1000';

    var settingsSh = ensureSheet_(SETTINGS_SHEET, ['key', 'value']);
    setSetting_(settingsSh, 'upiQr', url);

    return readSnapshot_();
  } finally {
    lock.releaseLock();
  }
}

function todayLocal_() {
  var tz = Session.getScriptTimeZone() || 'Asia/Kolkata';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

function action_portalCheckin_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureAllSheets_();
    var mobile = normMobile_(body.mobile);
    var name = String(body.name || '').trim();
    var age = body.age;
    var gender = String(body.gender || '');
    var email = String(body.email || '').trim();
    var date = todayLocal_();
    if (!mobile) return { ok: false, error: 'Mobile number is required.' };
    if (!name || String(age).trim() === '' || !gender) {
      return { ok: false, error: 'Name, age, and gender are required.' };
    }

    var patientsSh = ensureSheet_(PATIENTS_SHEET, PATIENTS_HEADERS);
    var visitsSh = ensureSheet_(VISITS_SHEET, VISITS_HEADERS);
    var settingsSh = ensureSheet_(SETTINGS_SHEET, ['key', 'value']);

    var pData = sheetRows_(patientsSh);
    var patientId = null;
    var rowIdx = -1;
    var nameToMatch = name.toLowerCase();
    for (var i = 0; i < pData.rows.length; i++) {
      if (String(pData.rows[i][pData.idx.mobile]) === mobile &&
          String(pData.rows[i][pData.idx.name] || '').trim().toLowerCase() === nameToMatch) {
        patientId = pData.rows[i][pData.idx.patientId];
        rowIdx = i;
        break;
      }
    }

    if (patientId) {
      var r = rowIdx + 2;
      patientsSh.getRange(r, pData.idx.age + 1).setValue(age);
      patientsSh.getRange(r, pData.idx.gender + 1).setValue(gender);
      if (email && pData.idx.email !== undefined) {
        patientsSh.getRange(r, pData.idx.email + 1).setValue(email);
      }
    } else {
      var settings = settingsMap_(settingsSh);
      var seq = Number(settings.seq || 0) + 1;
      patientId = 'P' + ('0000' + seq).slice(-4);
      var pIdx = headerIndex_(patientsSh);
      var pNumCols = patientsSh.getLastColumn();
      var pNewRow = new Array(pNumCols).fill('');
      var setPCol = function (key, val) { if (pIdx[key] !== undefined) pNewRow[pIdx[key]] = val; };
      setPCol('patientId', patientId);
      setPCol('mobile', mobile);
      setPCol('name', name);
      setPCol('age', age);
      setPCol('gender', gender);
      setPCol('email', email);
      setPCol('createdAt', new Date().toISOString());
      patientsSh.appendRow(pNewRow);
      setSetting_(settingsSh, 'seq', seq);
    }

    var vData = sheetRows_(visitsSh);
    var vIdx = headerIndex_(visitsSh);

    var existingTodayVisit = null;
    var visitNo = 1;
    for (var vi = 0; vi < vData.rows.length; vi++) {
      if (vData.rows[vi][vData.idx.patientId] !== patientId) continue;
      visitNo++;
      var vDate = vData.rows[vi][vData.idx.date];
      if (vDate instanceof Date) vDate = formatDate_(vDate);
      else vDate = String(vDate || '');
      if (vDate === date) {
        existingTodayVisit = {
          visitId: vData.rows[vi][vData.idx.visitId],
          queueNumber: vData.rows[vi][vData.idx.queueNumber] || '',
        };
      }
    }

    if (existingTodayVisit) {
      var snap = readSnapshot_();
      snap.patientId = patientId;
      snap.visitId = existingTodayVisit.visitId;
      snap.queueNumber = existingTodayVisit.queueNumber;
      return snap;
    }

    var queueNum = 1;
    for (var qi = 0; qi < vData.rows.length; qi++) {
      var qDate = vData.rows[qi][vData.idx.date];
      if (qDate instanceof Date) qDate = formatDate_(qDate);
      else qDate = String(qDate || '');
      if (qDate === date) {
        var qn = parseInt(vData.rows[qi][vData.idx.queueNumber], 10);
        if (qn >= queueNum) queueNum = qn + 1;
      }
    }

    var visitId = patientId + '_' + visitNo;
    var numCols = visitsSh.getLastColumn();
    var newRow = new Array(numCols).fill('');
    var setCol = function (key, val) { if (vIdx[key] !== undefined) newRow[vIdx[key]] = val; };
    setCol('visitId', visitId);
    setCol('patientId', patientId);
    setCol('visitNo', visitNo);
    setCol('date', date);
    setCol('createdAt', new Date().toISOString());
    setCol('done', false);
    setCol('patientName', name);
    setCol('patientGender', gender);
    setCol('patientAge', age);
    setCol('queueNumber', queueNum);
    visitsSh.appendRow(newRow);

    var snap = readSnapshot_();
    snap.patientId = patientId;
    snap.visitId = visitId;
    snap.queueNumber = queueNum;
    return snap;
  } finally {
    lock.releaseLock();
  }
}

function action_savePatientProblem_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureAllSheets_();
    var patientId = String(body.patientId || '');
    var visitId = String(body.visitId || '');
    var patientProblem = String(body.patientProblem || '');
    if (!patientId || !visitId) return { ok: false, error: 'Missing patient or visit id.' };

    var visitsSh = ensureSheet_(VISITS_SHEET, VISITS_HEADERS);
    var vData = sheetRows_(visitsSh);

    var targetRow = -1;
    for (var i = 0; i < vData.rows.length; i++) {
      if (vData.rows[i][vData.idx.visitId] === visitId &&
          vData.rows[i][vData.idx.patientId] === patientId) {
        targetRow = i;
        break;
      }
    }
    if (targetRow === -1) return { ok: false, error: 'Visit not found: ' + visitId };

    var r = targetRow + 2;
    if (vData.idx.patientProblem !== undefined) {
      visitsSh.getRange(r, vData.idx.patientProblem + 1).setValue(patientProblem);
    }

    return readSnapshot_();
  } finally {
    lock.releaseLock();
  }
}

// ---------- OTP via Twilio ----------

var OTP_SHEET = 'OTP';
var OTP_HEADERS = ['mobile', 'otp', 'createdAt', 'used'];
var OTP_EXPIRY_MS = 5 * 60 * 1000;

function getTwilioCreds_(body) {
  return {
    sid: String(body.twilioSid || ''),
    token: String(body.twilioToken || ''),
    from: String(body.twilioFrom || ''),
  };
}

function action_sendOtp_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var mobile = normMobile_(body.mobile);
    if (!mobile || mobile.length !== 10) return { ok: false, error: 'Please enter a valid 10-digit mobile number.' };

    var creds = getTwilioCreds_(body);
    if (!creds.sid || !creds.token || !creds.from) {
      return { ok: false, error: 'OTP service not configured. Please contact the clinic.' };
    }

    var otp = String(Math.floor(100000 + Math.random() * 900000));
    var otpSh = ensureSheet_(OTP_SHEET, OTP_HEADERS);
    var otpIdx = headerIndex_(otpSh);
    var numCols = otpSh.getLastColumn();
    var newRow = new Array(numCols).fill('');
    if (otpIdx.mobile !== undefined) newRow[otpIdx.mobile] = mobile;
    if (otpIdx.otp !== undefined) newRow[otpIdx.otp] = otp;
    if (otpIdx.createdAt !== undefined) newRow[otpIdx.createdAt] = new Date().toISOString();
    if (otpIdx.used !== undefined) newRow[otpIdx.used] = false;
    otpSh.appendRow(newRow);

    var toNumber = '+91' + mobile;
    var url = 'https://api.twilio.com/2010-04-01/Accounts/' + creds.sid + '/Messages.json';
    var payload = {
      To: toNumber,
      From: creds.from,
      Body: 'Your PatientPad verification code is ' + otp + '. Valid for 5 minutes.',
    };
    var options = {
      method: 'post',
      payload: payload,
      headers: {
        Authorization: 'Basic ' + Utilities.base64Encode(creds.sid + ':' + creds.token),
      },
      muteHttpExceptions: true,
    };
    var res = UrlFetchApp.fetch(url, options);
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      return { ok: false, error: 'Failed to send OTP. Please try again.' };
    }

    return { ok: true, sent: true };
  } finally {
    lock.releaseLock();
  }
}

function action_verifyOtp_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var mobile = normMobile_(body.mobile);
    var otpInput = String(body.otp || '').trim();
    if (!mobile || mobile.length !== 10) return { ok: false, error: 'Invalid mobile number.' };
    if (!otpInput || otpInput.length !== 6) return { ok: false, error: 'Please enter the 6-digit code.' };

    var otpSh = ensureSheet_(OTP_SHEET, OTP_HEADERS);
    var data = sheetRows_(otpSh);
    var now = new Date().getTime();

    var matched = false;
    for (var i = data.rows.length - 1; i >= 0; i--) {
      var row = data.rows[i];
      if (String(row[data.idx.mobile]) !== mobile) continue;
      if (row[data.idx.used] === true || row[data.idx.used] === 'TRUE' || row[data.idx.used] === 'true') continue;
      var created = new Date(row[data.idx.createdAt]).getTime();
      if (now - created > OTP_EXPIRY_MS) continue;
      if (String(row[data.idx.otp]) === otpInput) {
        otpSh.getRange(i + 2, data.idx.used + 1).setValue(true);
        matched = true;
        break;
      }
    }

    if (!matched) return { ok: false, error: 'Invalid or expired OTP. Please try again.' };
    return { ok: true, verified: true };
  } finally {
    lock.releaseLock();
  }
}
