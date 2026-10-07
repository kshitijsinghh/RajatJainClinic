# Clinic Console — Google Sheets backend setup

This turns a Google Sheet into the database for the Clinic Console app. No
server hosting needed — Google runs the script for you.

## 1. Create the Sheet

1. Go to [sheets.new](https://sheets.new) to create a blank spreadsheet.
2. Name it something like **Clinic Console Data**.
3. You don't need to create tabs or headers yourself — the script creates
   `Patients`, `Visits` and `Settings` tabs automatically the first time it
   runs.

## 2. Add the script

1. In the Sheet, go to **Extensions → Apps Script**.
2. Delete the placeholder `myFunction() {}` code in `Code.gs`.
3. Copy the entire contents of [`Code.gs`](./Code.gs) from this folder and
   paste it in.
4. Click the **save** icon (or Ctrl/Cmd+S). Name the project e.g. "Clinic
   Console API".

## 3. Deploy as a Web App

1. Click **Deploy → New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Fill in:
   - **Description**: `Clinic Console API` (or anything)
   - **Execute as**: **Me** (your account)
   - **Who has access**: **Anyone** — this makes the URL reachable from the
     browser app. It does *not* make your Sheet public; only the specific
     `list`/`saveIntake`/`saveClinical`/`uploadQr` actions in the script are
     exposed, and it can't be used to browse the Sheet in general.
4. Click **Deploy**.
5. The first time, Google will ask you to authorize the script (it needs
   permission to read/write this Sheet and to create files in your Drive
   for the UPI QR image). Click through **Advanced → Go to Clinic Console
   API (unsafe)** — this "unsafe" warning is standard for scripts you
   haven't published to the Marketplace; it's your own script running under
   your own account.
6. Copy the **Web app URL** shown after deployment. It looks like:
   `https://script.google.com/macros/s/AKfycb.../exec`

## 4. Point the app at it

In the `clinic-console` React app folder, create a file named `.env` (copy
`.env.example`) and set:

```
VITE_SHEETS_API_URL=https://script.google.com/macros/s/AKfycb.../exec
```

Restart `npm run dev` (or rebuild) after changing this.

## Updating the script later

If you edit `Code.gs` again (e.g. after a future change to this project),
go back to **Deploy → Manage deployments**, click the pencil/edit icon on
the existing deployment, and choose **New version** under "Version" before
clicking **Deploy**. Just saving the file in the editor does *not* update
the live URL — you must create a new version.

## Notes

- All app data lives in this Sheet — the app doesn't use browser storage.
  Reception and doctor devices both read/write the same Sheet, so records
  created on one device show up on the other (the app refetches on key
  actions; there's no live push, so a manual refresh may occasionally help
  during concurrent editing).
- The UPI QR scanner image is uploaded to a Drive folder named
  **"Clinic Console QR"** (auto-created) in your Drive, and only the file's
  view link is stored in the `Settings` tab.
- If you ever want to reset all data, you can safely delete rows in
  `Patients`/`Visits` (keep the header row) — do not delete the `Settings`
  tab or its `seq`/`upiQr` rows, or clear cell A1/A2 headers.
