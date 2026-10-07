# WhatsApp UI — what's in this drop, and how to deploy it

Frontend only. Nothing here sends a message until the backend routes exist, and
nothing here runs at all for a clinic that has not been switched on.

## 1. Unzip over the repo

```bash
cd ~/Downloads
unzip -o patientpad-whatsapp-ui.zip -d ~/path/to/Doctor-Console-
cd ~/path/to/Doctor-Console-
npm run build        # must finish clean before you push
```

## 2. Files

**New** — all of this is dormant until the flag is on:

```
src/whatsapp/statusModel.js            the one derivation of status → colour, label, wording
src/whatsapp/waApi.js                  every /whatsapp/* call
src/whatsapp/WaContext.jsx             the per-clinic flag + the opted-out set
src/whatsapp/ui.jsx                    glyph, toast, spinner, date/time helpers
src/whatsapp/DocSend.jsx               the send button, strip, icon buttons, phone bar
src/whatsapp/FailedMessagesBanner.jsx  §6
src/whatsapp/NextAppointmentNotice.jsx §2
src/whatsapp/PatientWhatsApp.jsx       §4 + §5
src/whatsapp/MonthStats.jsx            the four Patients-tab numbers
src/whatsapp/WhatsAppDisclosure.jsx    §7
src/whatsapp/appointments/WeekGrid.jsx         grid, lanes, now-line, legend
src/whatsapp/appointments/EventPopover.jsx     pop-up, reschedule, cancel modal
src/whatsapp/appointments/AppointmentsTable.jsx
src/whatsapp/messages/MessageDrawer.jsx
src/views/AppointmentsCalendar.jsx     the new Appointments tab
src/views/Messages.jsx                 the new Messages tab
```

**Changed** — each one additive:

```
src/App.jsx              provider, the Messages route, the appointment mirror on save
src/components/Header.jsx the Messages tab (>=900px, flag on)
src/views/Clinical.jsx   send button in both pop-ups, the next-appointment line
src/views/Dashboard.jsx  the failed banner
src/views/Intake.jsx     the registration line
src/views/Patients.jsx   the four month numbers
src/views/PatientDetail.jsx  the opted-out pill, the messages card
src/index.css            one print rule
```

**`src/views/Appointments.jsx` is deliberately untouched.** It is still what a
clinic without WhatsApp renders.

## 3. Switching a clinic on

One DynamoDB write, no redeploy:

```bash
aws dynamodb update-item --region us-east-1 \
  --table-name patientpad-orgs \
  --key '{"clinicId":{"S":"clinic_179c0de5"}}' \
  --update-expression 'SET waEnabled = :t' \
  --expression-attribute-values '{":t":{"BOOL":true}}'
```

Then reload the console. To switch back off, set it to `false` — the tabs
disappear and nothing else changes.

### What a clinic with the flag off does

`WaProvider` reads `org.waEnabled` from the org record the app already
fetches at boot. When it is false:

- no `/whatsapp/*` request is ever made, not even a failing one
- the Appointments tab renders the **old** component, unchanged
- the Messages tab is absent from the nav
- both document pop-ups render their existing header, Print and Download
  buttons included
- every other new component returns `null`

Nishant, Clover and Vaishnavi get a slightly larger bundle and nothing else.

## 4. Tests

29 assertions over the two pieces with real logic — the status derivation and
the calendar's overlap layout:

```bash
npx esbuild src/whatsapp/ui.jsx --bundle --loader:.jsx=jsx --format=esm \
  --outfile=ui.mjs --external:react
npx esbuild src/whatsapp/appointments/WeekGrid.jsx --bundle --loader:.jsx=jsx \
  --format=esm --outfile=wg.mjs --external:react
node sm-test.mjs && node ui-test.mjs      # test files in the zip root
rm -f ui.mjs wg.mjs
```

## 5. Still to come

The backend. See `WHATSAPP-BACKEND-CONTRACT.md` for the exact routes the UI
calls and what it expects back. Until those exist the new tabs load, show
their error state and retry — they do not break the rest of the console.
