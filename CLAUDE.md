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

There is no GitHub↔Apps Script sync (no clasp). Copy-paste is the only bridge.

1. Paste from
   https://raw.githubusercontent.com/dancynamon/Production-Throughput-and-Inventory/main/apps-script/Code.gs
   → **Save** (wait for the dot on the file tab to clear)
2. Run **`upgradeSchema`** from the ▶ Run dropdown if any column was added
2b. `upgradeSchema` also self-applies on the first app request after a deploy
   (guarded on `BUILD_STAMP` in script properties), so forgetting it is no
   longer fatal — but running it by hand makes the change visible immediately
3. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**

`.github/workflows/deploy-apps-script.yml` automates 1 and 3 via clasp once
three repo secrets exist (`CLASP_CREDENTIALS`, `APPS_SCRIPT_ID`,
`APPS_SCRIPT_DEPLOYMENT_ID`). It skips green while unconfigured.

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
- `MANAGER_PIN` still the default `2468`
- Cloudflare Access / custom domain discussed, not set up
- `M044` was referenced by the BOM but had no RawMaterials row until 2.10.0,
  so straps were consumed and produced invisibly. `addMissingReferencedMaterials`
  now appends any recipe-referenced material that is missing, and submitDay
  warns instead of skipping silently. Same class of gap filled every blank
  `Family` cell — the column existed, the values never landed
- Strap is one size-independent SKU (`STRAP6` -> `M044`), confirmed by Dan.
  Its recipe uses the measured 50" webbing quantities; a real per-strap
  measurement would refine `STRAP_RECIPE` in `Code.gs`
