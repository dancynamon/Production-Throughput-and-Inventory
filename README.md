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
> you don't see it) with *Set up / repair missing tabs*, *Rebuild overview /
> next-day goals*, and *⚠ Erase and rebuild ALL tabs*.

### The sheet is the source of truth

Everything you maintain by hand — on-hand counts, the employee roster, daily
targets, BOM tweaks — lives in the sheet, and **nothing in this project
overwrites it**. `setup()` only ever *creates tabs that are missing*; a tab that
already exists is left exactly as it is, so *Set up / repair missing tabs* is
safe to re-run any time (it reports what it created and what it left alone).

The single exception is **Overview**, which is derived rather than entered — it
gets redrawn from `StageLog` + `Planning` every time it rebuilds. Don't hand-edit
that tab.

If you ever genuinely want the factory defaults back, *⚠ Erase and rebuild ALL
tabs* does that — it asks for confirmation first, and it is the only thing here
that destroys data. Take a copy of the spreadsheet before you use it.

### Part 2 — Deploy the backend (5 min)

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

## Hosting (free) — pick one

The app is plain static files at the **root of this repo**, so any static host
serves it as-is. No build step.

### Option A — Cloudflare Pages

1. <https://dash.cloudflare.com> → **Workers & Pages → Create → Pages →
   Connect to Git**, pick this repo.
2. Build settings: **Framework preset: None**, **Build command: (leave empty)**,
   **Build output directory: `/`**.
3. **Save and Deploy.** You get `https://<project>.pages.dev`.
4. Optional: **Custom domains** → add e.g. `production.aquamentor.com` (the
   domain is already on Cloudflare, so the DNS record is one click).

### Option B — GitHub Pages

1. Push your branch and merge to your default branch (or enable Pages on the
   branch).
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from
   a branch**, pick your branch and `/ (root)`.
3. Your app will be at `https://<you>.github.io/<repo>/`.

> **Note:** `config.js` contains only your Apps Script URL, which is safe to
> expose (the script only accepts the actions it defines). The **Overview** and
> **Receive** screens are already gated behind the manager PIN
> (`MANAGER_PIN` in `Code.gs` — **change it from the default `2468`**).
> **Log My Day** is deliberately ungated, so anyone with the URL can post a
> production entry. For a small shop that's usually fine; keep the hosted URL
> internal, or add a PIN check to `submitDay()` in `Code.gs` if you want a gate.

---

## Keeping it private

The app is on the public internet. Anyone with the URL can reach it, and
`Log My Day` has no gate of its own. Three layers, weakest to strongest:

### 1. Stay out of search engines (in the repo, already done)

- **`robots.txt`** — `Disallow: /` for all crawlers.
- **`_headers`** — `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` on
  every asset, plus `Referrer-Policy: no-referrer` so the app's hostname isn't
  leaked to Google in the `Referer` of each API call.
- **`<meta name="robots">`** in `index.html`.

All three are *requests*. Compliant crawlers honour them; nothing else does.
This solves "someone googles us and finds it", not "someone has the link".

### 2. Don't advertise the hostname

Any subdomain of `aquamentor.com` appears in public **Certificate Transparency**
logs, which are scraped to enumerate subdomains. So `production.aquamentor.com`
is discoverable by anyone looking at your domain — not via search, but findable.
Putting the app on an unrelated domain you own says nothing about the company.

### 3. Cloudflare Access — the actual control

Free for a small team. It sits in front of the hostname at the edge, so an
unauthenticated visitor never reaches the app at all.

Zero Trust → Access → Applications → Add a self-hosted app → your hostname →
add a policy. Either allow a Google Workspace domain (`@aquamentor.com`), or
use email one-time PIN with a long session so staff re-authenticate rarely.

This is the layer that matters. With Access on, it stops mattering who finds
the hostname, and it closes the ungated `Log My Day` without touching `Code.gs`.

### Custom domain

Worker → **Settings → Domains & Routes → Add → Custom domain** →
`production.aquamentor.com`. The DNS record is created for you when the domain
is already on the same Cloudflare account, and the certificate is issued
automatically. Nothing in this repo needs to change — `config.js` points at
Apps Script, not at the app's own hostname.

## How to make it *yours*

Everything lives in the Google Sheet. Just edit the cells:

- **Products tab** — add a row to track more products. `ProductID` must be
  unique; set `Active = NO` to hide one. The **Line** column puts a product on a
  process: **Blank** (Cut→Glued), **TubeExo** (Meshed→…→Boxed), **TubeStd**
  (Patched→…→Boxed), **Shape** (CNC→Clean→Box, for foam mats & kickboards,
  deducting 4# foam by area), or **Chair** (Cut→Assemble→Box, deducting lumber
  + a hardware kit). **FeedsFrom** names the blank a product draws from. The
  Log-My-Day form shows only the stages for the picked product's line.
- **RawMaterials tab** — `OnHand` = current stock, `ReorderPoint` = low-warning
  level. Blank `OnHand` shows as "not counted." **Status** fills in
  automatically. Do a physical count and type real numbers in.
- **Stages tab** — a readable dump of each line's stages. **Reference only —
  nothing reads it.** The real definition is `LINES` in `Code.gs`. Editing this
  tab changes nothing; the rate columns are carried for reference and are not
  read either.
- **BOM tab** — the stage-aware recipe: `(ProductID, Stage, MaterialID,
  QtyPerUnit)`. Example: `XRT50EXO, Straps Attached, M014, 1.78` = a 50″ tube
  uses 1.78 yd of 1″ red webbing, deducted when "Straps Attached" is logged.
  Add a row per material a stage consumes.
- **Planning tab** — set **DailyTarget** per product **and stage**. Cut and
  Paint don't run at the same rate, so each stage carries its own goal.
- **Employees tab** — names shown in the app.

### The tube pipeline branches

A blank off the CNC is a *size* and nothing more — a 50″ blank can still become
either variant. The commit happens at **Meshed**: a tube that gets meshed is an
Exotube, one that doesn't is a Standard.

```
BLANK50   Cut → Glued ─┬─ XRT50EXO   Meshed → Patched → … → Boxed
                       └─ XRT50STD            Patched → … → Boxed
```

So the shared head is its own product (`BLANK50` / `BLANK40`) and each variant
picks up where the blank leaves off. **The variant is the presence of the Meshed
stage** — there's no separate variant column to keep in sync, and a Standard
never deducts mesh because it has no `Meshed` BOM row.

Your guys cutting 50″ blanks pick **50" Blank** and log Cut and Glued. Nobody
decides Exo vs Standard until a tube reaches mesh, which is when the decision
actually gets made on the floor.

Both variants draw from one pool of glued blanks, so what each can start depends
on what the other already took:

```
available to XRT50EXO at Meshed
  = glued BLANK50  −  XRT50EXO already Meshed  −  XRT50STD already Patched
```

That arithmetic is pinned by `apps-script/test-overview.js` — run
`node apps-script/test-overview.js` after touching `computeOverview()`.

> **Migrating an existing sheet.** `setup()` never overwrites an existing tab,
> so a sheet built before the split won't pick this up on its own. Run
> **Aquamentor → Migrate to Blank → Exo/Standard**. It rewrites Products,
> Stages, BOM and Planning, leaves RawMaterials, Employees and both logs alone,
> and warns you first if `StageLog` holds rows under the old `XRT50`/`XRT40`
> IDs (those would be orphaned by the rename).

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

## Estimated vs actual inventory

`OnHand` is an **estimate**. It moves by recipe: a stage gets logged, the BOM
says that stage eats 1.78 yd of webbing, 1.78 comes off. It is only ever as
good as the BOM — and several BOM numbers are openly approximate (the UV ink
rate is a top-down guess; the whole 40″ column is the 50″ column × 0.8). Add
scrap, offcuts and the odd unlogged day and it drifts from the shelf.

A **physical count** is the actual. The **Count** screen (manager-gated) lists
every material with its current estimate beside an empty box:

```
1" Red PP Webbing                    est. 100   [  88 ]  Yards
  last counted 2026-07-14 · var +6
```

Leave a box blank and that material is untouched — partial counts are normal.
Recording a count does three things:

1. appends a row to **`CountLog`** with the estimate, the count and the variance
2. **re-baselines** `OnHand` to the counted number
3. stamps `LastCounted`, `LastCountedAt`, `LastVariance` on the material

**Variance is `estimate − counted`.** Positive means the shelf holds *less* than
the recipe predicted — over-consumption, scrap or shrinkage. Negative means the
recipe is over-deducting.

### Why the log matters more than the correction

Without this you would type the real number straight into `OnHand`, and the
information that the estimate was ever wrong is gone.

A material that drifts the *same direction every count* is not shrinkage — it
is a wrong BOM number, and `CountLog` is the evidence to fix it. Anything off by
10%+ is flagged in the confirmation. Take the variance percentage, apply it to
that material's `QtyPerUnit` rows, and the estimate gets better each cycle.
That is the path to pinning down the ink rate and the 40″ figures with measured
numbers instead of guesses.

The arithmetic — variance sign, partial counts, re-baselining — is pinned by
`apps-script/test-count.js`. Run `node apps-script/test-count.js` after touching
`submitCount()`.

> **Turning it on for an existing sheet:** **Aquamentor → Enable count
> reconciliation**. It only *appends* the three columns to `RawMaterials` and
> creates `CountLog` — no existing cell is touched, so it needs no confirmation
> and is safe to run twice.

## Product families

`Products.Family` groups the picker and the Overview. It is **presentation
only** — `Line` says how a product is built and `FeedsFrom` says what it draws
from; nothing computational reads `Family`.

```
Rescue Tubes       BLANK50 · XRT50EXO · XRT50STD · BLANK40 · XRT40EXO
                   XRT40STD · STRAP6
Foam Mats          SHP16 · SHP24 · SHP36 · SHP4824 · SHP48 · SHP7236
Kickboards         KB914 · KB1116 · KB1220
Lifeguard Chairs   LGC30 · LGC40 · LGC50 · LGC60 · LGC72
```

Order comes from `FAMILY_ORDER` in `Code.gs`. A blank or unrecognised family
falls into **Other** and is appended rather than dropped, so a product added by
hand still shows up.

The product pickers use native `<optgroup>` headings — phones render those as
real section headers and screen readers announce them — and the Overview breaks
its cards under the same headings.

The strap sits under **Rescue Tubes** because that is where someone looks for
it. Move it to its own family by editing that one cell.

## Opening work-in-progress

The chain math — `waiting = completed(previous stage) − completed(this one)` —
assumes the floor was **empty** the day tracking started. It never is.

Aquamentor's first week showed 151 tubes getting straps when 85 had been meshed
and none patched. Not sloppy logging: those tubes were already mid-pipeline
before anyone opened the app. Uncorrected, every WIP figure is wrong, every
"upstream short" flag is noise, and any lead time built on them is confidently
wrong.

The **WIP** screen (manager-gated) fixes it with a one-time count per product.
It asks only what is physically countable — the pile standing at each station:

```
Waiting for Paint 1                        [ 40 ]
Waiting for Paint 2                        [ 25 ]
Waiting for Printed                        [ 10 ]
Waiting for Straps Attached                [  5 ]
Waiting for Boxed                          [  0 ]
Finished, past Boxed                       [  8 ]
```

Cumulative completions are then derived by walking the line **backwards** from
finished goods:

```
completed(last) = finished on hand
completed(i)    = completed(i+1) + pile waiting at stage i+1
```

so the counts above give `Patched 88 · Paint 1 48 · Paint 2 23 · Printed 13 ·
Straps 8 · Boxed 8`. Nobody has to know how many units ever passed a station —
only what is standing in front of it.

**Zero is a real answer.** An empty station means 0, not blank.

**The first stage isn't asked for.** On a variant line its input is the shared
blank pool, which the Overview already derives from the feeder; on a Blank line
it's raw foam, which isn't tracked as WIP.

Rows logged **before** a baseline are ignored — those units are already standing
in the piles that were counted, so including them would count the same tube
twice. Re-running a count for a product supersedes the previous one entirely.

The Overview marks any product still lacking one as **no WIP baseline**, and
`apps-script/test-wip.js` pins both the backward walk and the double-count guard.

## How much, how fast — and the dashboard feed

### Hours

Each stage row on **Log My Day** has a `hrs` box next to the count. Optional —
leave it blank and the day still records production, it just can't contribute
to a rate.

It matters because units per **day** is confounded by who worked and for how
long: one person for two hours and three people all day both read as "Cut: 60."
Units per **hour** is a rate you can multiply by planned staffing. It also
finally gives the `IdealRate_perHr` columns something real to be measured
against.

### Runway — "how much can I build right now?"

On the **Overview**, under each product:

> **53** buildable · limited by **1" Red PP Webbing** (96 Yards ÷ 1.78/unit)

Derived from `BOM × OnHand` — no new data entry. A material consumed at several
stages of one product (paint at Paint 1 *and* Paint 2) is **summed** across
them, so the per-unit figure is the true requirement.

Materials that have never been counted are **excluded and listed**, not read as
zero. Most of this sheet is uncounted; treating blank as empty would report a
runway of 0 almost everywhere.

The constraint is the actionable half. "Webbing is low" is a nag; "webbing stops
the line in 53 units" is a decision.

### `?action=metrics` — the dashboard endpoint

One read-only call returning a stable contract, independent of whatever the
phone screens happen to show:

```
GET …/exec?action=metrics
{
  "generatedAt": "…", "backendVersion": "2.3.0", "sheetId": "…",
  "products": [{ "id", "name", "feedsFrom", "finished",
                 "runway": { "buildable", "constraint", "uncounted", "materials" },
                 "stages": [{ "stage", "completed", "waiting", "target", "suggest",
                              "starved", "unitsPerHour", "unitsPerDay",
                              "daysObserved", "hoursLogged" }] }],
  "materials": [ … ],
  "throughput": [ … ],
  "coverage": { "stageLogRows", "rowsWithHours" }
}
```

`coverage` is there so a consumer can tell an empty pipeline from a broken one —
zero rows means nobody has logged yet, not that the call failed.

Every rate is **measured**, not configured, so all of it stays null until days
are actually logged. `apps-script/test-metrics.js` pins the arithmetic.

## Knowing what you're running

Every screen has a muted line at the bottom — `v1.1.0 · Aquamentor Production`.
Tap it to expand:

| Field | What it tells you |
|---|---|
| **App version** | Which front-end this device has. `APP_VERSION` in `app.js`. |
| **Backend version** | Which `Code.gs` the *deployed* web app is running. `BACKEND_VERSION`. |
| **Sheet** / **Sheet ID** | Which spreadsheet that backend is actually bound to. |
| **API** | The tail of the Apps Script deployment ID this device is calling. |
| **Cached shell** | The service-worker cache this device is serving from. |
| **Loaded** | When this page last actually loaded. |

Two mismatches are worth knowing how to read:

- **Cached shell says `v6` but you shipped `v7`** — that device is serving stale
  files. It'll correct itself on the next load; force it with DevTools →
  Application → Service Workers → Unregister.
- **Backend version says "not reported — redeploy Apps Script"** — the code in
  the editor was saved but never deployed, so the web app is still serving an
  older version. See below.

### Bumping versions

When you change a **shell file** (`index.html`, `app.js`, `style.css`,
`config.js`): bump `APP_VERSION` in `app.js` *and* `CACHE` in `sw.js` together.
Miss the `CACHE` bump and installed phones keep the old shell indefinitely — the
footer is how you'd catch it.

When you change **`Code.gs`**: bump `BACKEND_VERSION`. Menu items and anything
run from the editor pick up a plain **Save**, but the web app serves a pinned
version — for `doGet` and everything it calls, you need **Deploy → Manage
deployments → ✏️ Edit → Version: New version → Deploy**.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Phone shows a "paste your URL" banner | `config.js` `API_URL` is still empty. |
| Dropdowns show "—" or a timeout | Re-check Part 2: deployment access must be **Anyone**; re-copy the `/exec` URL. |
| Changed `Code.gs`, no effect | Re-deploy: **Deploy → Manage deployments → ✏ Edit → Version: New version → Deploy**. |
| Stock went negative | Your `OnHand` counts were low, or a BOM qty is too high. Correct the numbers in the Sheet. |
| Employee can't see a new product | It needs `Active = YES` in Products; then tap ⟳ on the phone. |

---

## Extending later (optional ideas)

- Add a **PIN field** to the phone form and check it in `submitProduction()`.
- Chart production over time with a Google Sheet chart on the Dashboard.
- Add an "undo last entry" action for quick correction of a mis-typed quantity.
- If you truly need offline scanning/barcodes, the same Sheet + Apps Script can
  back a native app later — the data model doesn't change.
