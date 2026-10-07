# Clinic Console

Staff-facing internal tool for Nishant Dental Clinic: reception intake,
doctor clinical records, and a dashboard with date-range stats and pending
balances. Ported from the `Clinic Console.dc.html` design prototype in
`../project/`.

All data lives in a Google Sheet — there is no database or backend server
to run yourself. A Google Apps Script (deployed from your own Google
account) sits between this app and the Sheet.

## Setup

1. **Backend**: follow [`apps-script/README.md`](./apps-script/README.md)
   to create the Sheet and deploy the Apps Script Web App. You'll end up
   with a URL like `https://script.google.com/macros/s/AKfycb.../exec`.
2. **App config**: copy `.env.example` to `.env` and paste that URL into
   `VITE_SHEETS_API_URL`.
3. **Install & run**:
   ```
   npm install
   npm run dev
   ```

## Project structure

- `src/App.jsx` — top-level state/data flow (mirrors the prototype's
  `Component` logic class, but reads/writes via `src/api.js` instead of
  localStorage).
- `src/api.js` — fetch wrapper around the Apps Script Web App.
- `src/views/` — Dashboard, Intake (reception), Clinical (doctor) screens.
- `src/components/Header.jsx` — sticky nav header.
- `src/options.js` — static dropdown lists (chief complaints, treatment
  groups/treatments, payment modes/statuses), ported verbatim from the
  prototype.
- `apps-script/` — the Google Sheets/Drive backend and its deploy guide.

## Notes / deviations from the prototype

- **Storage**: the prototype used `localStorage` (single browser only).
  This app instead reads/writes the Google Sheet on every action, so
  reception and doctor devices share the same records. The dashboard has
  a manual **Refresh** button, and also refetches whenever you navigate
  back to it, since there's no live push between devices.
- **UPI QR image**: the prototype stored the uploaded QR as a data URL in
  `localStorage`. Here it's uploaded to a Drive folder ("Clinic Console
  QR") via the Apps Script, and only the resulting link is stored in the
  Sheet's `Settings` tab.
- Visual design (colors, type, spacing, copy, interactions) is ported
  pixel-for-pixel from `Clinic Console.dc.html`.
