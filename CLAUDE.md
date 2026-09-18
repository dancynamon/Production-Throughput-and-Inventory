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
| Backend | Apps Script **bound to the sheet** | manual paste + redeploy, no sync |
| Data | Google Sheet | source of truth for everything hand-maintained |

**Sheet:** `Aquamentor Production` —
https://docs.google.com/spreadsheets/d/1dOou3HsIWdkbt_2joiqtRgV85-r1usxpB4O2ElRc-xk/edit

Tabs: `Products · Stages · RawMaterials · BOM · StageLog · ReceivingLog ·
Employees · Planning · CountLog · WipBaseline · Overview`

### Lookalike files — do not touch

- `Aquamentor Production — PRE-MIGRATION BACKUP 2026-07-19` — has a stale script
  copy, so pasting there looks like it worked and changes nothing
- `John — Open Orders & Foam Cut List (LIVE)` — the *order dashboard*, a
  different project with no bound script. Opening its Apps Script shows an
  empty editor. This has caused a wasted round already.

## Shipping a `Code.gs` change

**Since 2.22.0 the script updates itself from GitHub.** Sheet menu →
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
- Cloudflare Access / custom domain discussed, not set up
- `M044` was referenced by the BOM but had no RawMaterials row until 2.10.0,
  so straps were consumed and produced invisibly. `addMissingReferencedMaterials`
  now appends any recipe-referenced material that is missing, and submitDay
  warns instead of skipping silently. Same class of gap filled every blank
  `Family` cell — the column existed, the values never landed
- Strap is one size-independent SKU (`STRAP6` -> `M044`), confirmed by Dan.
  Its recipe uses the measured 50" webbing quantities; a real per-strap
  measurement would refine `STRAP_RECIPE` in `Code.gs`
