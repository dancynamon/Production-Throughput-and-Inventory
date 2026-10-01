# Aquamentor Production — working notes

Standing context for this project. Ephemeral containers mean a new session
starts from nothing; these are the facts that cost the most to rediscover.

## Always end a reply with the app URL

Dan asked for this explicitly — print it at the end of every response so it is
one click away.

**https://prod-through-inv-3.dan-daf.workers.dev**

Cloudflare Worker `prod-through-inv-3`, built from `main`. No custom domain
attached yet; `production.aquamentor.com` is discussed but not set up.

## The three moving parts

| Part | Where | Note |
|---|---|---|
| App (PWA) | Cloudflare Worker, from `main` | auto-deploys on push |
| Backend | Apps Script **bound to the sheet** | self-updates from `main` every 30 min |
| Data | Google Sheet | source of truth for everything hand-maintained |

**Sheet:** `Aquamentor Production` —
https://docs.google.com/spreadsheets/d/1dOou3HsIWdkbt_2joiqtRgV85-r1usxpB4O2ElRc-xk/edit

Tabs: `Products · Stages · RawMaterials · BOM · StageLog · ReceivingLog ·
Employees · Planning · CountLog · WipBaseline · FinishedGoods · ShipLog ·
Overview` (+ `SalesImport`, a paste target created on first use)

### Lookalike files — do not touch

- `Aquamentor Production — PRE-MIGRATION BACKUP 2026-07-19` — has a stale script
  copy, so pasting there looks like it worked and changes nothing
- `John — Open Orders & Foam Cut List (LIVE)` — the *order dashboard*, a
  different project with no bound script. Opening its Apps Script shows an
  empty editor. This has caused a wasted round already.

## Shipping a `Code.gs` change

**Live since 2026-09-22: the script updates itself from GitHub.** The
script runs on standard GCP project `aquamentor-deploy` (number
215385849169, Apps Script API on, consent screen Internal); auto-update
trigger is on. Push to `main` with a new `BUILD_STAMP` and it lands within
30 min; Dan gets one email per update. Sheet menu →
*Update from GitHub now*, or *Turn on auto-update from GitHub (every 30 min)*.
The script fetches `main/apps-script/Code.gs`, and when its `BUILD_STAMP`
differs from the one running: writes it into the project through the Apps
Script API (as the sheet owner, from inside Apps Script — the owner's API
toggle is on, and a trigger's grant has no reauth clock), cuts a new version,
moves the existing web-app deployment to it, and checks the live `/exec`
answers with the new stamp — else rolls the deployment back. Mails on a
change and once per distinct failure. `whatAmIRunning` shows the state.
The manifest is read back and written back untouched. One-time setup: the
project's `appsscript.json` must carry the `oauthScopes` in
`apps-script/appsscript.json` (Project Settings → Show manifest), then run
*Update from GitHub now* once to authorize. **So: push to `main` with a new
`BUILD_STAMP` and the backend follows within 30 minutes.** A push with a
broken Code.gs would be rolled back by the canary, but only if it fails to
answer `?action=config` — run the tests before pushing regardless.

Manual fallback, still works. Copy-paste:

1. Paste from
   https://raw.githubusercontent.com/dancynamon/Production-Throughput-and-Inventory/main/apps-script/Code.gs
   → **Save** (wait for the dot on the file tab to clear)
2. Run **`upgradeSchema`** from the ▶ Run dropdown if any column was added
2b. `upgradeSchema` also self-applies on the first app request after a deploy
   (guarded on `BUILD_STAMP` in script properties), so forgetting it is no
   longer fatal — but running it by hand makes the change visible immediately
3. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**

`.github/workflows/deploy-apps-script.yml` automates 1 and 3 via clasp, but is
**manual-only (`workflow_dispatch`) since 2026-08-23** — both auth paths are
dead (see below), so firing on push just mailed Dan a failure for a deploy
nobody was waiting on. Restore the `push` trigger if either path starts working.
It skips green while unconfigured. Always needs `APPS_SCRIPT_ID` and
`APPS_SCRIPT_DEPLOYMENT_ID`, plus **one** of:

- `GCP_SA_KEY` — a service-account JSON key. Preferred: no reauth clock.
  Requires the **spreadsheet** shared with the SA as Editor (the script is
  bound, so container permissions are the only permissions) and the Apps
  Script API enabled on the key's GCP project. clasp reads it through `--adc`,
  which is a *global* flag and so covers `deploy`, not just `push`
- `CLASP_CREDENTIALS` — a personal `clasp login`. Works, but Google expires
  the reauth proof: it died with `invalid_rapt` six days after being minted on
  2026-08-13, and only a browser session can clear that. The workflow warns
  when running on this path

Service accounts *cannot own* Apps Script projects — access comes only from
sharing.

**The service-account path is blocked, tried 2026-08-19.** Sharing the sheet
with the SA as Editor is not sufficient: the Apps Script API also gates on a
**per-user** toggle at `script.google.com/home/usersettings`, checked against
whoever is calling, and a service account has no such page. clasp pushes fail
with *"User has not enabled the Apps Script API"*. This is the real substance
behind the older "the API rejects service accounts" advice — `--adc` exists
and does cover `deploy`, but it cannot get past this. Ways round it, none
taken yet:

1. remove the reason the personal login expires — Admin console → Security →
   Access and data control → **Google Cloud session control** → never expire.
   That policy is what mints the `invalid_rapt`
2. domain-wide delegation so the SA impersonates a user who has enabled it —
   needs Workspace admin and more moving parts than clasp exposes
3. keep pasting `Code.gs` by hand; it changes rarely

Step 3 is the one that gets skipped. Saving never changes what the web app
serves — only a new version does. **Never "New deployment"**: it mints a new
URL and leaves `config.js` pointing at the old one. That cost several rounds.

## Telling what is actually running

- `Code.gs` header carries `BUILD: <timestamp>  version X.Y.Z` — regenerate it
  on every change to that file, Dan relies on it
- App footer shows `app X · backend Y`, expand for `Backend built`
- `whatAmIRunning` in the Run dropdown prints saved-code state
- Sheet menu → `What am I running? (diagnostics)`

**Sheet menu since 2.24.2** (backend): five everyday items on top (diagnostics,
update from GitHub, digest now, import sales, sync Shopify), then submenus
*Settings* (all the Set…), *Schedules* (one toggle each: digest, Shopify sync,
auto-update — `toggleDigest` etc. flip the trigger and toast the new state) and
*Maintenance* (setup, rebuild, add columns, migrate, erase). The old
`…On`/`…OffMenu` functions still exist for the Run dropdown and tests.

**Every version gets a `changelog.js` entry** (newest first, `who: crew|mgr`,
plain words). The app's *What's new* tab renders it and shows a dot until
read; **managers only since 2.24.2** (tab, dot and footer link follow the lock;
no public changelog page — `build.js` writes it to the gitignored `help/_private/`).
Guides live in `help/src/` (fragments) → `node help/build.js` → site pages
+ PDFs via the Playwright script; update them when a screen changes.
**The manager guide is not a public page since 2.24.0**: `build.js` bakes it into
`Code.gs` between the `GUIDE:BEGIN/END` markers (so rebuild, then commit
Code.gs), and the `guide` action serves it only to a name on `GUIDE_READERS`
(Script Property, default Dan,John,Alex; menu *Set manager-guide readers…*)
who unlocked with their own PIN. The PDF renders from the gitignored
`help/_private/managers.html`. `help/managers.html` must never come back.

Three independent version numbers: `APP_VERSION` (app.js), `BACKEND_VERSION` +
`BUILD_STAMP` (Code.gs), `CACHE` (sw.js). Changing any shell file means bumping
`APP_VERSION` **and** `CACHE` together, or installed phones keep the old shell.

## Tests

```
node apps-script/test-overview.js   # blank pool shared by Exo/Standard
node apps-script/test-count.js      # variance sign, partial counts
node apps-script/test-metrics.js    # runway, throughput
node apps-script/test-wip.js        # opening-WIP walk, double-count guard
node apps-script/test-strap.js      # strap sub-assembly totals
node apps-script/test-inventory.js  # count history order, drift runs
node apps-script/test-schema.js     # additive repairs, idempotence
node apps-script/test-purchasing.js # committed demand, shared-pool guard
node apps-script/test-summary.js    # shop-level vs line-level counting
node apps-script/test-capacity.js   # bottleneck, Little's Law, confidence
node apps-script/test-pin.js        # PIN from Script Properties, never code
node apps-script/test-receiving.js  # deliveries newest-first, last-received map
node apps-script/test-crew.js       # per-person rate only from hours-bearing rows
node apps-script/test-export.js     # tab-as-rows, ISO dates, allow-list
node apps-script/test-reverse.js    # negative row, recipe in reverse, bounded
node apps-script/test-wipwalk.js    # whole floor under ONE timestamp
node apps-script/test-replay.js     # same clientId twice logs once
node apps-script/test-targets.js    # update in place, append missing, refuse bad
node apps-script/test-digest.js     # digest HTML content, recipient fallback
node apps-script/test-notes.js      # per-stage note lands on its own row
node apps-script/test-report.js     # report-core: duplicates, reversals, opening counts
node apps-script/test-update.js     # self-update: replace file, keep manifest, canary, rollback
node apps-script/test-finished.js   # finished goods: storage, ship, count, imports, Shopify pull
node apps-script/test-menu.js       # sheet menu: short top level, handlers exist, schedule toggles
node apps-script/test-reconcile.js  # walk keeps the app's estimate; floor/shelf/storage scored; to-do
node apps-script/test-floor.js      # floor mode: clock in/out, 6pm + 14 h auto-close, floorPace dedupe, open access
node apps-script/test-timeclock.js  # login, PIN + lockout, geofence, requests/approval audit, edits, flags, timeExport, summary
```

`node --check` passes plenty of real bugs in this file — a missing comma
between array literals parses as a member access. Evaluate the constants and
assert on them rather than trusting the parser.

## Open items

- Materials stocktake never done — twelve materials sit negative from a missing
  opening baseline, not a recipe error. Twelve more have never had a number at
  all (blank OnHand). The first count of any material produces a meaningless
  variance; drift only becomes readable from the second count on
- WIP baselines not yet recorded for any product
- Manager PIN lives in Script Properties since 2.13.0 (menu: Set manager PIN…);
  `DEFAULT_PIN` 2468 applies until set, and the app nags managers until then.
  Per-person PINs since 2.17.0 (menu: Set a person's PIN…), stored as SHA-256
  under `PIN:<Name>`; unlock asks name + PIN, shared PIN stays as fallback.
  **Since 2.19.0 the lock is server-side**: `auth` returns a token derived
  from `TOKEN_SECRET` + the credential hash; every action outside
  `OPEN_ACTIONS` (config, today, submitDay, reverse, auth) needs `token` +
  `mgrName` or answers `{locked:true}`, which makes the app drop to employee
  view. Changing any PIN invalidates the tokens it earned. After a backend
  paste that crosses 2.19.0, every manager taps the lock and unlocks once
- Floor Report artifact (progress / throughput / bottlenecks, reads the sheet
  live via the Google Drive connector): https://claude.ai/artifact/86LAWmpX3EDEtbF5cfPW4G
  — source in `report/`, math in root `report-core.js`, which the app's
  **Floor** tab also loads. Since 2.21.0 the crew's Floor tab is **their own
  pace only** (open action `myPace`, returns that person's rows and no one
  else's); the whole-floor view (`floorData`) needs the manager token and is
  what a manager sees on the same tab. Likely duplicates (same
  person/product/stage/qty/day saved twice) are dropped from both views and
  a manager reverses them from Summary → Fix-ups. WIP tab is crew-visible
  since 2.20.0 so the floor count is theirs to take
- **Finished goods since 2.23.0.** `FinishedGoods` holds storage per
  sellable product (not a feeder, no OutputMaterial). Last stage of a
  sellable product → OnHand += qty (submitDay), reverse → −=. Crew **Ship**
  tab (open action `ship`, clientId replay guard) → `ShipLog` row with
  Channel ∈ Shopify/Amazon/QuickBooks/Wholesale/Sample/Other, OnHand −=.
  Manager Inventory tab → Finished goods panel: storage, produced/shipped
  30d by channel, storage count (`countFinished`, CountLog rows with
  Unit=finished). Channel orders: sheet menu *Import sales from SalesImport
  tab* recognises a Shopify orders export, an Amazon All Orders report, or a
  QBO Sales by Product/Service Detail report (shipped lines only), matches on
  `ShopifySKU`/`AmazonSKU`/`QBOItem` (comma lists) then ProductID then name,
  Key=channel|ref|productId so re-imports are no-ops, unmatched SKUs listed
  for mapping. *Set Shopify access…* + *Sync Shopify shipments now* / hourly
  trigger pull fulfilled line items straight from the store (custom app,
  read_orders). Amazon and QBO stay paste-based until a sync is worth it.
  Storage has never been counted — first counts set the baseline
- **2.25.0:** Inventory *Stocktake to-do* filter (never counted OR negative,
  `summary.stocktake`); `FinishedGoods.MinOnHand` (hand-typed, blank = none)
  flags storage under it in the panel and the weekly digest; `config` returns
  `wipCounted` so the WIP tab names products with no floor count; Summary
  exports gain *Shipments* and *Shipped by month* (pivot done in the app)
- **Reconcile since 2.25.1** (John's weekly loop). Manager tab, action
  `reconcile` → `getReconcile()`: floor (latest `WipBaseline` walk per product,
  `EstimatedAtCount` column added 2.25.1 and written by `writeWipRows` from
  `currentWaitingMap()`; rows without it, and `(finished)`, are not scored),
  shelf (`getInventory` history[0] per material), storage (CountLog rows with
  Unit=finished, plus made/shipped since the count), each with close =
  within 10% or one unit, worst first, words short/extra relative to the
  app's number, and a `todo` (floor due after 14 days, shelf/storage after 7).
  **Count-only view**: Script Property `VIEW:<Name>` = `count` (menu
  Settings → *Set a person's view…*), returned by `auth` as `view`, stored as
  `aq_view`; app then shows Log My Day, Ship, Reconcile only, lands on
  Reconcile, and the WIP/Inventory screens get a back button and lose their
  side matter (`body.view-count` CSS). Dan meant this for John
- **Floor mode since 3.01.0** (versions jumped 2.25.2 -> 3.01.0; strings, not numbers, everywhere) (`/floor` -> `floor.html` + `floor.js` + `floor.css`): the crew's
  one-screen page; opening the root URL without a manager unlock redirects to `/floor` (`?full=1` escapes; Floor has a "Full app (managers)" link), only for speed. Logs through the SAME `submitDay` (Meshed / Patched / Boxed,
  XRT50EXO / XRT40EXO, or the STD pair; `notes` = `floor <id>` so two identical +12 taps are not
  read as a duplicate by the recon dedupe) and undoes through `reverse`. New open actions `clock`
  (TimeLog tab: Timestamp, WorkDate, Employee, In, Out, Hours, Source, ClientId; open shift
  closed at 14 h with Source `auto`) and `floorPace` (deduped StageLog + TimeLog). Like `submitDay`
  they carry no PIN. Targets: Script Properties `FLOOR_WEEKLY_TARGET` (default 320) and
  `FLOOR_DAILY_TARGET` (default weekly / 5); the Planning seeds are placeholders and are not read.
  **3.01.0 made the clock the real time clock:** every `clock` in/out needs the person's own 4-digit
  PIN (`Employees.PinHash`, `salt:sha256`, never returned; 5 wrong = 15 min lock in CacheService) and
  a GPS fix inside `SHOP_LAT`/`SHOP_LNG`/`SHOP_RADIUS_M` (150 m; accuracy over 300 m or no fix is
  refused; shop not set yet = allowed but `NoGeofence`). `submitDay` stays PIN-free. Forgot-to-punch
  = `timeRequest` (open, needs PIN) -> `TimeRequests` tab -> manager `timeDecide`. Manager-only
  (token) actions: `timeView`, `setClockPin`, `setShopLocation`, `timeDecide`, `timeEdit` (reason
  required; `OriginalIn/OriginalOut/EditedBy/EditedAt/EditReason/EditLog` keep the trail), `timeExport`
  (from/to -> hours per person per day). `sendDailyTimeSummary` at 6pm New York via menu
  Settings -> Install daily 6pm time summary; extra recipients in Script Property `SUMMARY_TO`.
  Par = clocked hours x weekly target / `FLOOR_WEEKLY_CREW_HOURS` (default 165), no wall-clock window.
- **3.01.1: log in on load, three tabs.** Floor mode asks name + clock PIN once (open action
  `login` -> `crewLogin`, same `verifyClockPin` lockout) and remembers the person under
  `aq_floor_login` until "log out"; an old backend answering "Unknown action" lets them in
  unchecked with a warning so production still logs. Punches still ask the PIN. The full app shows
  only a login card (manager `auth`, name + PIN) until unlocked; top bar is Floor / Summary / Time.
  The other screens' HTML and JS are still in place, just off the bar. Guides rewritten for
  3.01.8 (new screenshots `help/img/floor-*.png`, `mgr-*.png`; PDFs rendered with Playwright
  `page.pdf` from `help/crew.html` and `help/_private/managers.html`)
- **3.01.2:** Reconcile + Inventory back on the manager bar (John's loop; count-only view shows
  just those two and lands on Reconcile). Login epochs (`aq_login_epoch` in index.html,
  `aq_floor_epoch` in floor.js) log every phone out once when bumped
- **3.01.3 / backend 3.01.2:** two different PINs, easy to mix up. Manager PIN (`PIN:<Name>`,
  full-app login) = menu *Settings → Set a manager's PIN (full app)*. Crew clock PIN
  (`Employees.PinHash`, Floor login + punches) = app *Time tab → Clock PINs* (needs backend
  3.01.x) or menu *Settings → Set a crew clock PIN (Floor mode)* (`setCrewClockPin`). Count-only
  view shows Reconcile, Inventory, Time. Anyone other than the sheet owner running a sheet menu
  item gets Google's consent screen for GCP project `aquamentor-deploy`; its app name comes from
  that project's OAuth branding; John reported an "n8n" authorization prompt on 2026-10-01 (unverified)
- **3.01.4:** Cloudflare 307s `/index.html` -> `/` and `/floor.html` -> `/floor`. The service
  worker had cached those redirects and served them to page loads, which Chrome refuses ("site
  can't be reached"; curl looks fine because it skips the SW). Shell URLs and links are now
  extensionless (`./`, `floor`, `./?full=1`, manifest `start_url` `./`) and `sw.js` never serves
  or stores a redirected response. Don't reintroduce `.html` links to shell pages
- **3.01.5 (app + backend):** Floor mode Job dropdown = every tube job (`JOBS` in floor.js):
  Cut/Glued -> `BLANK50/40`, Meshed..Boxed -> `XRT{50,40}{EXO,STD}`, Strap made -> `STRAP6`.
  Shapes and chairs are not on Floor yet. Full-app login is **PIN only**: `checkPin('', pin)`
  -> `pinOwners` finds the owner among `PIN:<Name>` props and the clock PINs of names on Script
  Property `MANAGERS` (default Dan,John,Alex); two owners = refused; none = shared PIN.
  `credentialHash` uses the manager's clock hash when they have no `PIN:<Name>`, so changing it
  locks their phone. One-time `MIGRATED_MANAGERS_3015` in upgradeSchema drops `VIEW:John/Alex`
  = count. RawMaterials gets `Active`; `materialRetired()` hides NO, and M001 Glue Pods while
  blank (YES brings it back); filtered in `getStock` and `config`
- **3.01.6:** Floor *Making* dropdown (`flProd`): "Rescue tube" (tube `JOBS`, size + Exo/Std) or
  any active product whose line is not Blank/TubeExo/TubeStd/Strap/Tube, grouped by Family; those
  offer their own line's stages from `config.lines`. Last pick kept in `aq_floor_prod`. The
  clock-out "how many boxed" prompt only fires on Rescue tube
- **3.01.7 (app + backend):** auto clock-out at 6pm New York (`CLOCK_CUTOFF_HOUR`, default 18,
  `off` disables). `autoCloseAt(s)` = min(in + 14 h, cutoff that day if clocked in before it);
  open-shift hours everywhere use `openHours()`; the close is written by `sweepOpenShifts()` from
  `getFloorPace` (Floor polls it every minute), `getTimeView`, `sendDailyTimeSummary`, and in
  `clockShift`. Source `auto6pm`, flag `autoOut`. test-floor/test-timeclock set it `off` for
  their legacy 14 h blocks; the 6pm block is at the end of test-floor.js
- Cloudflare Access / custom domain discussed, not set up
- `M044` was referenced by the BOM but had no RawMaterials row until 2.10.0,
  so straps were consumed and produced invisibly. `addMissingReferencedMaterials`
  now appends any recipe-referenced material that is missing, and submitDay
  warns instead of skipping silently. Same class of gap filled every blank
  `Family` cell — the column existed, the values never landed
- Strap is one size-independent SKU (`STRAP6` -> `M044`), confirmed by Dan.
  Its recipe uses the measured 50" webbing quantities; a real per-strap
  measurement would refine `STRAP_RECIPE` in `Code.gs`
