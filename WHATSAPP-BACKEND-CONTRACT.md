# Backend contract

Exactly what the frontend now calls. Build these and the UI lights up; nothing
in the UI has to change.

All routes sit behind the API Gateway authorizer and carry
`Authorization: Bearer <staff JWT>`. All take `clinicId` (query for GET, body
for POST). All answer `{ ok: true, ... }` or `{ ok: false, error: "..." }`.

---

## Appointments — the new DynamoDB entity

The Sheet keeps owning the visit. The appointment becomes its own row because
a reminder scheduler cannot poll a spreadsheet and a cancelled slot has to be
authoritative somewhere.

Suggested table `patientpad-wa-appointments`: PK `clinicId`,
SK `date#time#appointmentId`, GSI on `visitId`.

```
appointmentId, clinicId, patientId, visitId, name, mobile,
date "YYYY-MM-DD", time "HH:MM", durationMin, treatment,
status: scheduled | rescheduled | cancelled,
confirmation: { answer: "coming"|"cant_come"|null, answeredAt, changed, lastMessageStatus },
lastSentAt, lastMessageId, failureCode,
history: [ { at, action, from, to, by } ],      // every edit, per your requirement
createdAt, updatedAt
```

### `GET /whatsapp/appointments?clinicId&from&to`
`{ appointments: [ ...rows ] }` — cancelled rows omitted. One request per
range, never one per row. The UI polls this every 30s while the tab is open
and the browser tab is visible.

### `POST /whatsapp/appointments`
`{ clinicId, patientId, visitId, name, mobile, date, time, treatment, durationMin }`

Called after every clinical save that carries a next appointment. **Upsert
keyed on `visitId`.** Compare before acting:

- no existing row → create, send `APPOINTMENT_CONFIRMATION`, schedule the reminder
- same date and time → **send nothing** (re-saving a form must be silent)
- different date or time → treat as a reschedule

### `POST /whatsapp/appointments/:id/reschedule`
`{ clinicId, date, time }` → cancel the pending reminder for the old slot,
send `APPOINTMENT_RESCHEDULED`, schedule a new reminder, append to `history`,
reset `confirmation.answer` to null.

### `POST /whatsapp/appointments/:id/cancel`
`{ clinicId }` → set `status: cancelled`, cancel pending reminders, send
`APPOINTMENT_CANCELLED`, append to `history`. The row is kept, not deleted.

---

## Messages

### `POST /whatsapp/messages/send`
```
{ clinicId, useCase, patientId, visitId, mobile, name,
  params: {...}, documentUrl?, idempotencyKey }
```
Returns `{ message: { messageId, status, ... } }` **immediately** — do not
block on Meta.

`idempotencyKey` is `visitId:useCase:docVersion`. **This has to actually work.**
The current `claimIdempotency` guards on `attribute_not_exists(idempotencyKey)`
but writes a sort key containing a fresh UUID, so the condition always passes
and nothing is deduplicated. Needs a dedicated claim record keyed on the key
alone. Until then a double click sends twice.

When `documentUrl` is absent for a document use case, generate the PDF the
same way `/generate-pdf` does and upload it to Meta.

### `GET /whatsapp/messages/:id?clinicId`
`{ message: { messageId, status, sentAt, deliveredAt, readAt, repliedAt, reply, failureCode, failureReason } }`

Polled every 3s while a document pop-up is open.

### `GET /whatsapp/messages?clinicId&from&to&event&status&q&page`
```
{ messages: [...], total, page, pageSize: 12,
  statusCounts: { "Seen": n, "Delivered": n, "Sent": n, "Not delivered": n } }
```
`statusCounts` is over the **whole filtered set**, not the page — the chips
show totals. `status` arrives as the on-screen label. `q` matches name or
number ignoring spaces.

Each row: `messageId, sentAt, name, patientId, mobile, useCase, templateName,
status, reply, failureCode, failureReason, visitId, sentBy, preview, buttons[]`.

`preview` is the rendered message text, `buttons` the quick-reply labels — the
drawer shows the patient's eye view, so parameters must already be
substituted.

### `GET /whatsapp/messages/stats?clinicId&from&to`
```
{ triggered, delivered, seen, failed,
  perDay: [ { date, triggered, delivered, seen, failed } ],
  byEvent: [ { useCase, templateName, triggered, delivered, seen, failed } ] }
```

### `GET /whatsapp/messages/failed?clinicId&date&unresolved=1`
`{ messages: [...] }` — same row shape. Drives the banner.

### `POST /whatsapp/messages/:id/resolve`
`{ clinicId }` → mark the failure handled so the banner can empty.

### `GET /whatsapp/patients/:patientId/messages?clinicId`
`{ messages: [...] }`, newest first, for the profile card.

### `GET /whatsapp/patients/stats?clinicId`
`{ triggered, delivered, replied, failed }` for the current month.

---

## Config

### `GET /whatsapp/config/:clinicId`
`{ enabled, clinicPhone, optedOut: ["9876543210", ...] }`

One call at boot, and **only** when `org.waEnabled` is true. Add `waEnabled`
(BOOL) to the org record — that is the whole rollout switch.

---

## Templates to create

| Use case | Template | Params (named) | Buttons |
|---|---|---|---|
| `APPOINTMENT_CONFIRMATION` | `appt_confirmation_v2` | patient_name, clinic_name, appointment_date, appointment_time, clinic_phone | Yes, coming / Not coming |
| `APPOINTMENT_REMINDER` | `appt_reminder_v1` | patient_name, clinic_name, appointment_time, clinic_phone | Yes, coming / Not coming |
| `APPOINTMENT_REMINDER_TODAY` | `appt_reminder_today_v1` | patient_name, clinic_name, appointment_time, clinic_phone | none |
| `APPOINTMENT_RESCHEDULED` | `appt_reschedule_v1` | patient_name, clinic_name, appointment_date, appointment_time, clinic_phone | Yes, coming / Not coming |
| `APPOINTMENT_CANCELLED` | `appt_cancelled_v1` | patient_name, appointment_date, appointment_time, clinic_name, clinic_phone | none |
| `EPRESCRIPTION` | `prescription_pdf_v1` | patient_name, clinic_name, clinic_phone | document header |
| `PAYMENT_RECEIPT` | `payment_receipt_pdf_v1` | patient_name, clinic_name, amount, clinic_phone | document header |

All Utility, all `parameter_format: named`. The UI never references a template
name — only the use case — so renaming one is a bindings change.

---

## Free-text replies — decided: auto-reply

A patient reply that is not a button tap:

1. store the text against the appointment (`inboundMessages[]`)
2. send **one** free-form reply per 24h window — free, no template needed:

   > Thanks for your message. We can't change appointments on WhatsApp.
   >
   > To reschedule, please call {clinic_name} at {clinic_phone}.
   >
   > Your appointment is still booked for {appt_date} at {appt_time}.

3. leave `confirmation.answer` as null, so the slot stays amber on the
   calendar and the existing "chase the amber ones" habit covers it

Fire once per window, never per message, and never for a button tap.

---

## Reminder scheduler

Does not exist yet. EventBridge → Lambda, hourly: find tomorrow's
`status: scheduled` appointments with no reminder sent, send
`APPOINTMENT_REMINDER`, stamp the row. Reschedule and cancel must clear the
stamp and the pending send, or a patient gets a reminder for an appointment
that is not happening.

---

## Capacity

One phone number under the WABA (`1361589733698668`), so Indu and Raghav share
a single 250-unique-customers-per-24h ceiling. Appointment confirmations alone
could reach that in a busy week with both live. A second number is needed
before clinic three.
