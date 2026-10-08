// The patient's own health details, and above all the allergy check.
//
// Hiding a real allergy is the worst thing this feature can do, so the
// false-negative cases come first and are deliberately over-represented.
import {
  isNoKnownAllergy, hasRealAllergy, anyHealthDetails, healthRows,
  carryForwardHealth, HEALTH_FIELDS, CARRY_FIELDS, NO_ALLERGY_TEXT, NO_DENTAL_TEXT,
} from '../src/health.js';

let pass = 0, fail = 0;
const check = (n, ok, got) => {
  if (ok) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, got === undefined ? '' : JSON.stringify(got)); }
};

/* ── Allergies that must RAISE the alert ──────────────────────────────────
   Every one of these starts with the letters of a "none" word. A prefix
   match would swallow them all, and the patient would be anaesthetised with
   the drug they react to. */

const MUST_ALERT = [
  'Novocaine allergy',      // a dental anaesthetic — the case that matters most
  'Nose drops',
  'Nobivac',
  'Nickel',
  'Nuts',
  'None of the painkillers agree with me',
  'No idea, but I react to something in anaesthetic',
  'Nil by mouth before surgery — allergic to latex',
  'Penicillin',
  'Allergic to penicillin (rash).',
  'nsaids',
  'Nitrous oxide',
];
for (const v of MUST_ALERT) {
  check(`ALERTS on ${JSON.stringify(v)}`, hasRealAllergy(v) === true && isNoKnownAllergy(v) === false, v);
}

/* ── Values that genuinely mean "nothing to declare" ───────────────────── */

const MUST_NOT_ALERT = [
  'None', 'none', 'NONE', 'No', 'no', 'Nil', 'nil', 'NKDA', 'nkda',
  'N/A', 'n/a', 'No known allergies', 'no known allergies', 'No known allergy',
  'No allergies', 'None.', 'no.', 'NKDA.', '  None  ', '\tNo known allergies\n',
  NO_ALLERGY_TEXT,
];
for (const v of MUST_NOT_ALERT) {
  check(`quiet on ${JSON.stringify(v)}`, isNoKnownAllergy(v) === true && hasRealAllergy(v) === false, v);
}

check('empty is neither an allergy nor a declared "none" worth showing',
  hasRealAllergy('') === false && hasRealAllergy('   ') === false);
check('null and undefined do not throw',
  hasRealAllergy(null) === false && hasRealAllergy(undefined) === false);
// Saying nothing is not the same as saying "none": the first means the
// question is still open, the second is an answer. Only the second is worth
// printing for the doctor, which is why the grid shows one and not the other.
check('an unanswered allergy field is not counted as a declared "none"',
  isNoKnownAllergy('') === false && isNoKnownAllergy(null) === false
  && isNoKnownAllergy('   ') === false);

/* ── The grid: a real allergy is shown once, as the alert, never twice ─── */

const withAllergy = {
  patientProblem: 'Pain lower left',
  patientMedicalHistory: 'Diabetes',
  patientAllergies: 'Penicillin',
  patientDentalHistory: 'RCT 2022',
};
const gridA = healthRows(withAllergy, { skipRealAllergy: true });
check('a real allergy is dropped from the grid (it is the red alert)',
  !gridA.some((r) => r.k === 'Allergies'), gridA.map((r) => r.k));
check('...but the other three rows are all there',
  gridA.map((r) => r.k).join('|') === "Today's problem|Medical history|Dental history", gridA.map((r) => r.k));

const withNone = { ...withAllergy, patientAllergies: 'NKDA' };
const gridN = healthRows(withNone, { skipRealAllergy: true });
check('a "none" allergy DOES appear in the grid — the doctor should see it was asked',
  gridN.some((r) => r.k === 'Allergies' && r.v === 'NKDA'), gridN);

check('without the skip, a real allergy is listed normally (visit-detail view)',
  healthRows(withAllergy).some((r) => r.k === 'Allergies' && r.v === 'Penicillin'));

check('blank fields never produce a row',
  healthRows({ patientProblem: 'x', patientAllergies: '  ' }).map((r) => r.k).join() === "Today's problem",
  healthRows({ patientProblem: 'x', patientAllergies: '  ' }));
check('nothing at all gives no rows', healthRows({}).length === 0 && healthRows(null).length === 0);

/* ── Is there anything to show? ───────────────────────────────────────── */

check('a panel is shown when any one field has a value',
  anyHealthDetails({ patientDentalHistory: 'Braces' }) === true);
check('...and hidden when none do',
  anyHealthDetails({ patientProblem: '', patientAllergies: '   ' }) === false);
check('...and when the record is missing entirely',
  anyHealthDetails(null) === false && anyHealthDetails(undefined) === false);
check('the doctor\'s own medicalHistory does not count as a patient field',
  anyHealthDetails({ medicalHistory: 'Hypertension' }) === false);
check('the two are never confused in the field list',
  !HEALTH_FIELDS.includes('medicalHistory') && HEALTH_FIELDS.includes('patientMedicalHistory'));

/* ── Carry-forward ────────────────────────────────────────────────────── */

const visits = [
  { visitId: 'P1_1', no: 1, clinical: { patientMedicalHistory: 'Asthma', patientAllergies: 'Penicillin', patientDentalHistory: 'Extraction 2019' } },
  { visitId: 'P1_2', no: 2, clinical: { patientMedicalHistory: 'Asthma, now on Metformin too' } },
  { visitId: 'P1_3', no: 3, clinical: {} },
];

const carried = carryForwardHealth(visits, 'P1_3');
check('the most recent value of each field wins',
  carried.patientMedicalHistory === 'Asthma, now on Metformin too', carried);
check('...independently per field, so an older allergy is not lost',
  carried.patientAllergies === 'Penicillin', carried);
check('...and an older dental history is kept too',
  carried.patientDentalHistory === 'Extraction 2019', carried);
check('today\'s problem is never carried forward',
  carried.patientProblem === undefined, carried);
check('the carried fields are exactly CARRY_FIELDS',
  Object.keys(carried).sort().join() === [...CARRY_FIELDS].sort().join(), Object.keys(carried));

check('the current visit is excluded even if it has values',
  carryForwardHealth([{ visitId: 'V', no: 9, clinical: { patientAllergies: 'Latex' } }], 'V').patientAllergies === '');
check('no earlier visits gives empty strings, not undefined',
  carryForwardHealth([], 'V').patientAllergies === '');
check('a missing visit list does not throw',
  carryForwardHealth(null, 'V').patientMedicalHistory === '');
check('visits with no clinical record are skipped',
  carryForwardHealth([{ visitId: 'A', no: 1 }, { visitId: 'B', no: 2, clinical: { patientAllergies: 'Dust' } }], 'C')
    .patientAllergies === 'Dust');
check('a whitespace-only earlier value is not carried as if it were real',
  carryForwardHealth([{ visitId: 'A', no: 1, clinical: { patientAllergies: '   ' } }], 'C').patientAllergies === '');

/* ── Quick-fill chips ─────────────────────────────────────────────────── */

check('the allergy chip writes a value the "none" test recognises',
  isNoKnownAllergy(NO_ALLERGY_TEXT) === true, NO_ALLERGY_TEXT);
check('the dental chip text is the one the spec names',
  NO_DENTAL_TEXT === 'No previous dental treatment', NO_DENTAL_TEXT);
check('the dental chip value is NOT treated as an allergy "none" by accident',
  hasRealAllergy(NO_DENTAL_TEXT) === true, NO_DENTAL_TEXT);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
