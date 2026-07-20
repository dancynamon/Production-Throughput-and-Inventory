# Aquamentor Inventory & Production

Stage-based production tracking for XRT rescue tubes, built on free tools:

- **A Google Sheet** is the whole database — products, the 9-stage pipeline,
  raw materials, a stage-aware recipe (BOM), and the production log.
- **A phone/web app** (this folder) that employees "Add to Home Screen" on
  iPhone or Android — no App Store, no fees. Works on desktop too.
- **A Google Apps Script** (free) is the glue: an employee uploads what they
  finished at each stage today; it records the day **and deducts the raw
  materials each stage consumes**.
- **An Overview** shows work-in-progress at every stage and, from your
  throughput rates + daily targets, **suggests next-day goals per stage** —
  the feed for your manufacturing state machine.
- **A Receive screen** so stock goes *up* on deliveries too, with a
  `ReceivingLog` audit trail.

```
  Employee (phone/web)             Google Apps Script              Google Sheet
 ┌───────────────────┐  uploads   ┌───────────────────┐  writes  ┌──────────────┐
 │ "Today: Cut 112,  │ ─────────► │ append per stage  │ ───────► │ StageLog     │
 │  Glued 90,        │            │ deduct materials  │          │ RawMaterials │
 │  Boxed 40" (XRT50)│ ◄───────── │ at each stage     │ ◄─────── │ BOM (stage)  │
 └───────────────────┘  "−14.9    └───────────────────┘          │ Planning     │
      ▲                  foam,          │  computes             │ Overview     │
      │  next-day goals  webbing…"      ▼  WIP + goals          └──────────────┘
      └──────────────────────────  Overview / state-machine feed
```

---

## What's in this folder

| File | What it is |
|------|-----------|
| `apps-script/Code.gs` | The backend. Paste into Google Apps Script. Builds the sheet + handles the phone app. |
| `apps-script/make-icons.js` | Regenerates the app icons (already generated; you rarely need this). |
| `index.html`, `app.js`, `style.css` | The phone web-app. |
| `config.js` | **The one file you edit** — paste your script URL here. |
| `manifest.webmanifest`, `sw.js`, `icon-*.png` | Make it installable to the home screen + work offline. |

---

## Setup — about 15 minutes, one time

### Part 1 — Build the Google Sheet (5 min)

1. Go to <https://sheets.google.com> and create a **new blank spreadsheet**.
   Name it e.g. *Aquamentor Production*.
2. In the menu: **Extensions → Apps Script**. A code editor opens in a new tab.
3. Delete whatever is in `Code.gs`, then **paste the entire contents of
   `apps-script/Code.gs`** from this folder.
4. Click **Save** (the 💾 icon).
5. In the toolbar, make sure the function dropdown shows **`setup`**, then
   click **▶ Run**.
   - The first time, Google asks you to **authorize**. Click *Review
     permissions → pick your account → Advanced → Go to (project) → Allow*.
     (It's your own script editing your own sheet — this is expected.)
6. Switch back to the spreadsheet tab. You now have tabs: **Products, Stages,
   RawMaterials, BOM, StageLog, ReceivingLog, Employees, Planning, Overview** —
   pre-loaded with XRT-50/40, your 33 raw materials (plus foam/adhesive/paint/
   ink from the COGS build), the 9-stage pipeline, and the seeded recipe.

> There's also an **"Aquamentor" menu** in the spreadsheet (reload the sheet if
> you don't see it) with *Rebuild overview / next-day goals*. The destructive
> *Build/reset all tabs* action is deliberately **not** on the menu — `setup()`
> wipes every tab back to seed data, so it can only be run on purpose from the
> Apps Script editor, and never on a sheet that already holds live data.

> **Migrating into an existing sheet** (tabs already present with real data):
> skip step 5 entirely — do **not** run `setup()`. Just paste the code, save,
> set the Script Properties (next section), and deploy.

### Part 2 — Deploy the backend (5 min)

0. **Set the PINs first** (they live in Script Properties, never in this repo):
   In the Apps Script editor open **Project Settings (⚙) → Script Properties →
   Add script property** and create two entries:
   - `MANAGER_PIN` — what the owners type to unlock Overview/Receive.
   - `SHOP_PIN` — the shared shop code employees enter once on their phone;
     every submit/receive write is rejected without it.
1. Back in the Apps Script editor, click **Deploy → New deployment**.
2. Click the ⚙ gear next to "Select type" → choose **Web app**.
3. Set:
   - **Description:** `Aquamentor production API`
   - **Execute as:** **Me**
   - **Who has access:** **Anyone**  ← required so employees' phones can reach it
4. Click **Deploy**, authorize if asked, then **copy the Web app URL**. It
   looks like:
   `https://script.google.com/macros/s/AKfy…long…/exec`

### Part 3 — Point the phone app at it (2 min)

1. Open `config.js` in this folder and paste your URL:
   ```js
   window.AEGIS_CONFIG = { API_URL: "https://script.google.com/macros/s/AKfy…/exec" };
   ```
2. Host this `inventory/` folder somewhere your employees' phones can open.
   Easiest free option: **GitHub Pages** (see below). Any static host works
   (Netlify, Cloudflare Pages, even a folder on your own web server).

### Part 4 — Employees install it (30 sec each)

1. On the employee's phone, open the hosted URL in the browser.
2. **iPhone (Safari):** Share button → **Add to Home Screen**.
   **Android (Chrome):** ⋮ menu → **Install app / Add to Home Screen**.
3. It now sits on their home screen like any app. They pick their name, the
   product, the quantity, tap **Submit**. Done.

---

## Hosting on GitHub Pages (free)

This folder is already in your repo. To publish it:

1. Push your branch and merge to your default branch (or enable Pages on the
   branch).
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from
   a branch**, pick your branch and `/ (root)`.
3. Your app will be at `https://<you>.github.io/<repo>/inventory/`.

> **Note:** `config.js` contains only your Apps Script URL, which is safe to
> expose (the script only accepts the actions it defines). All writes
> (`submitDay`, `receive`) additionally require the shared `SHOP_PIN` (a Script
> Property, asked once per device), so someone who merely finds the URL can
> read stock levels but can't post entries. Still keep the hosted URL internal.

---

## How to make it *yours*

Everything lives in the Google Sheet. Just edit the cells:

- **Products tab** — add a row to track more products. `ProductID` must be
  unique; set `Active = NO` to hide one. The **Line** column puts a product on a
  process: **Tube** (Cut→…→Boxed), **Shape** (CNC→Clean→Box, for foam mats &
  kickboards, deducting 4# foam by area), or **Chair** (Cut→Assemble→Box, for
  lifeguard chairs, deducting lumber + a hardware kit). The Log-My-Day form
  shows only the stages for the picked product's line.
- **RawMaterials tab** — `OnHand` = current stock, `ReorderPoint` = low-warning
  level. Blank `OnHand` shows as "not counted." **Status** fills in
  automatically. Do a physical count and type real numbers in.
- **Stages tab** — the 9 pipeline stages and their throughput rates (tubes/hr).
- **BOM tab** — the stage-aware recipe: `(ProductID, Stage, MaterialID,
  QtyPerUnit)`. Example: `XRT50, Straps Attached, M014, 1.78` = a 50″ tube uses
  1.78 yd of 1″ red webbing, deducted when "Straps Attached" is logged. Add a
  row per material a stage consumes.
- **Planning tab** — set **DailyTarget** per product; it drives the suggested
  next-day goals.
- **Employees tab** — names shown in the app.

After editing Products/Employees, tap ⟳ in the app to refresh.

---

## Using it day to day

**Employees** (phone/web), three tabs:
- **Log My Day** — pick the date, your name, the product, then enter how many
  you finished at each stage today → Submit. The confirmation shows what
  materials were deducted and flags anything low.
- **Overview** — the live pipeline: Done / WIP / suggested next-day goal per
  stage, plus a reorder list.
- **Receive** — log a delivery to add stock back (audited in `ReceivingLog`).

**You** (the Sheet): the **Overview tab** mirrors the pipeline for desktop, and
**Planning** is where you set daily targets. Run **Aquamentor → Rebuild
overview** after editing to refresh the sheet copy (the app view is always
live).

---

## How the deduction works

When a day is uploaded for, say, `XRT50` with `Straps Attached = 50`:

1. A row per stage is appended to **StageLog**.
2. For each stage, the script reads the **BOM** rows for `(product, stage)` and
   subtracts `QtyPerUnit × count` from each material's `OnHand`.
3. It returns the new levels and warns about anything at/below its reorder point
   (or gone negative — a sign that material needs a starting count or a
   receipt).

Receiving is the mirror image (**adds** to `OnHand`, logs to `ReceivingLog`).
A script lock serializes all writes so simultaneous submissions can't corrupt
the counts.

### Recipe status (what auto-deducts today)

Seeded from your COGS "COGS Model" tab plus your measured conversions.
**Auto-deducting now:** foam (Cut), adhesive (Glued), **nylon mesh** (Meshed),
**patch material + cyanoacrylate + accelerant** (Patched), urethane paint
(Paint 1/2), **UV ink** (Printed), 1″ red / 1″ black / 2″ black webbing +
D-ring + tri-glide (Straps Attached), polybag + box (Boxed).

Two values are estimates to refine: **UV ink** (~0.007 unit/tube from the COGS
top-down — send a real "one ink unit lasts ~N tubes" to pin it), and the
**XRT-40** length-based quantities (XRT-50 × 0.8). Mesh is tracked in **boxes**
at ~250 tubes/box (≈310 for the 40″).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Phone shows a "paste your URL" banner | `config.js` `API_URL` is still empty. |
| Dropdowns show "—" or a timeout | Re-check Part 2: deployment access must be **Anyone**; re-copy the `/exec` URL. |
| Changed `Code.gs`, no effect | Re-deploy: **Deploy → Manage deployments → ✏ Edit → Version: New version → Deploy**. |
| "Server is missing SHOP_PIN" | Add the `SHOP_PIN` Script Property (Part 2, step 0). |
| "Wrong shop PIN" keeps appearing | The phone re-prompts on the next submit; type the current `SHOP_PIN`. Managers can change it any time in Script Properties. |
| Stock went negative | Your `OnHand` counts were low, or a BOM qty is too high. Correct the numbers in the Sheet. |
| Employee can't see a new product | It needs `Active = YES` in Products; then tap ⟳ on the phone. |

---

## Extending later (optional ideas)

- Chart production over time with a Google Sheet chart on the Dashboard.
- Add an "undo last entry" action for quick correction of a mis-typed quantity.
- If you truly need offline scanning/barcodes, the same Sheet + Apps Script can
  back a native app later — the data model doesn't change.
