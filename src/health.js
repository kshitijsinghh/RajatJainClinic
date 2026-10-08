// The four things a patient tells the clinic about themselves at check-in.
//
// These are the PATIENT's own words and are deliberately separate from the
// doctor's `medicalHistory` field, which is a clinical note. They are never
// merged and neither is ever copied into the other: a doctor reading their own
// note needs to know it is theirs, and a patient's self-report is evidence of
// what the patient believes, which is a different thing.

export const HEALTH_FIELDS = [
  'patientProblem',
  'patientMedicalHistory',
  'patientAllergies',
  'patientDentalHistory',
];

// The three that describe a standing condition rather than today's complaint,
// and so are worth carrying forward from a previous visit. Today's problem
// never is — that would put words in the patient's mouth about why they came.
export const CARRY_FIELDS = [
  'patientMedicalHistory',
  'patientAllergies',
  'patientDentalHistory',
];

// Quick-fill values, so the chip and the "is this a none?" test below cannot
// drift apart.
export const NO_ALLERGY_TEXT = 'No known allergies';
export const NO_DENTAL_TEXT = 'No previous dental treatment';

// Does this allergy field mean "nothing to declare"?
//
// SAFETY-CRITICAL. The whole trimmed string must match. A prefix test such as
// /^(none|no|nil)/ reads "Novocaine allergy" — a dental anaesthetic — and
// "Nose drops" as "no allergy", and hides the red alert from the one person
// who needs it. If this is ever rewritten, the tests in test/health.test.mjs
// are the specification.
const NONE_RE = /^\s*(none|no|nil|nkda|n\/a|no known( allergies)?|no known allergy|no allergies)\s*\.?\s*$/i;

export function isNoKnownAllergy(value) {
  return NONE_RE.test(String(value == null ? '' : value).trim());
}

// A value that names an actual allergy, as opposed to empty or a "none".
// This is what decides whether the red alert is shown.
export function hasRealAllergy(value) {
  const s = String(value == null ? '' : value).trim();
  return !!s && !isNoKnownAllergy(s);
}

export function anyHealthDetails(clinical) {
  const c = clinical || {};
  return HEALTH_FIELDS.some((f) => !!String(c[f] || '').trim());
}

// What the patient told us, in the order a doctor reads it, skipping blanks.
// `skipRealAllergy` drops the allergy row when it is being shown as the red
// alert instead, so it is never said twice.
export function healthRows(clinical, { skipRealAllergy = false } = {}) {
  const c = clinical || {};
  return [
    ["Today's problem", c.patientProblem],
    ['Medical history', c.patientMedicalHistory],
    ['Allergies', c.patientAllergies],
    ['Dental history', c.patientDentalHistory],
  ]
    .filter(([label, value]) => {
      if (!String(value || '').trim()) return false;
      if (skipRealAllergy && label === 'Allergies' && hasRealAllergy(value)) return false;
      return true;
    })
    .map(([k, v]) => ({ k, v }));
}

// What to pre-fill when a returning patient has not yet filled anything in
// today. Reads the most recent earlier visit that holds each field — not
// necessarily the same visit for all three, because a patient who declared an
// allergy two years ago and a new medicine last month should see both.
//
// `visits` is the patient's full list; `currentVisitId` is excluded.
export function carryForwardHealth(visits, currentVisitId) {
  const earlier = (visits || [])
    .filter((v) => v && v.visitId !== currentVisitId && v.clinical)
    .sort((a, b) => (b.no || 0) - (a.no || 0));
  const out = {};
  for (const field of CARRY_FIELDS) {
    const found = earlier.find((v) => String(v.clinical[field] || '').trim());
    out[field] = found ? found.clinical[field] : '';
  }
  return out;
}
