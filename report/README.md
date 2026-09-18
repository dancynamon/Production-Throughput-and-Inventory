# Floor Report

A one-page read of progress, throughput by station and bottlenecks, built
from the StageLog / Products / Stages / Planning tabs of the sheet.

Published as a private Claude artifact that reads the sheet live through the
viewer's Google Drive connector, with a baked-in snapshot as fallback:
https://claude.ai/artifact/86LAWmpX3EDEtbF5cfPW4G

- `../report-core.js` (repo root, also loaded by the app's Floor tab) — parses the Drive connector's markdown rendering of the
  sheet and computes the report. Same code runs in Node (snapshot) and in the
  page (live), so the two can never disagree.
- `floor-report.src.html` — the page, with `/*__CORE__*/` and
  `/*__SNAPSHOT__*/` placeholders.
- `build.js` — bakes core + a saved sheet markdown into `floor-report.html`.
  Expects the sheet markdown at `sheet-<date>.md` next to it (not committed —
  it is a copy of live data).

"Likely duplicates" = same person, product, stage, quantity and work date
saved more than once. The page drops them by default and lists them so they
can be reversed in the app.
