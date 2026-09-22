/* What changed, version to version, in words the floor can use.
 * Read by the app's "What's new" tab and by help/build.js for the site page.
 * Newest first. `who`: crew = everyone sees it, mgr = behind the lock. */
window.AQ_CHANGELOG = [
  { version: '2.24.0', date: '2026-09-22', title: 'What\'s new, and the guides', items: [
    { who: 'crew', text: 'This tab. A dot on it means something changed since you last looked.' },
    { who: 'crew', text: 'Crew guide and manager guide, linked at the bottom of every screen.' }
  ]},
  { version: '2.23', date: '2026-09-22', title: 'Storage and shipping', items: [
    { who: 'crew', text: 'Ship tab: record product leaving storage — how many, and whether it went to Shopify, Amazon, QuickBooks, wholesale, or as a sample.' },
    { who: 'crew', text: 'Boxing a tube (or boxing a chair or mat) now puts it into storage automatically.' },
    { who: 'mgr',  text: 'Inventory: a Finished goods panel at the top — what\'s in storage per product, made and shipped in the last 30 days by channel, and a storage count.' },
    { who: 'mgr',  text: 'Shopify orders can pull in on their own every hour. Amazon and QuickBooks orders import from a pasted report in the sheet.' },
    { who: 'mgr',  text: 'The sheet now updates its own code from GitHub, so new versions land without a paste.' }
  ]},
  { version: '2.21', date: '2026-09-18', title: 'Your own pace', items: [
    { who: 'crew', text: 'Floor tab shows your own numbers only: today, this week, hours, and your pace at each station against the target.' },
    { who: 'mgr',  text: 'Managers see the whole floor on the same tab: piles worst-first, pace by station, finished per day.' }
  ]},
  { version: '2.20', date: '2026-09-18', title: 'Floor tab, fix-ups, floor count', items: [
    { who: 'crew', text: 'WIP tab is open to everyone: walk the whole floor and count what\'s at each station when a manager asks.' },
    { who: 'mgr',  text: 'Summary → Fix-ups lists entries logged more than once with a one-tap Reverse.' },
    { who: 'mgr',  text: 'Repeated entries are left out of the Floor numbers automatically.' }
  ]},
  { version: '2.19', date: '2026-09-17', title: 'Manager lock, for real', items: [
    { who: 'mgr',  text: 'The manager tabs are locked on the server now, not just hidden on the phone. Changing a PIN logs every phone out.' }
  ]},
  { version: '2.18', date: '2026-09-13', title: 'Notes, digest, order-by', items: [
    { who: 'crew', text: 'A pencil ✎ on each station row on Log My Day: a note that lands on that station\'s entry.' },
    { who: 'crew', text: 'The app reloads itself when a new version lands, so the footer never lags behind.' },
    { who: 'mgr',  text: 'Buy says "order by <date>" from the burn rate and each material\'s lead time. "Order today" when late.' },
    { who: 'mgr',  text: 'A Monday-morning email digest from the sheet: last week, the floor, stock, and the buy list.' }
  ]},
  { version: '2.17', date: '2026-09-13', title: 'Targets, shift line, personal PINs', items: [
    { who: 'crew', text: 'Today\'s totals shows your own line: units and entries today.' },
    { who: 'mgr',  text: 'Tap a target on Overview to change it.' },
    { who: 'mgr',  text: 'A PIN per manager. Unlock asks name, then PIN.' }
  ]},
  { version: '2.16', date: '2026-09-13', title: 'Works without signal', items: [
    { who: 'crew', text: 'No connection? Submit anyway. The entry waits on the phone and sends itself when you\'re back in range.' },
    { who: 'crew', text: 'WIP: walk the whole floor in one pass instead of one product at a time.' },
    { who: 'mgr',  text: 'Overview hides products with nothing on the floor.' }
  ]},
  { version: '2.15', date: '2026-09-13', title: 'Undo, count next, buy by supplier', items: [
    { who: 'crew', text: 'Tap a chip under Today\'s totals to take back a double-tap. The materials go back too.' },
    { who: 'mgr',  text: 'Inventory: "Count next" picks the five materials most worth counting.' },
    { who: 'mgr',  text: 'Buy groups shortfalls by supplier with a copyable order list.' }
  ]},
  { version: '2.14', date: '2026-09-13', title: 'Deliveries, rates, export', items: [
    { who: 'mgr',  text: 'Receive shows recent deliveries. Capacity shows per-person rates. Summary exports CSVs.' }
  ]},
  { version: '2.13', date: '2026-09-02', title: 'Capacity', items: [
    { who: 'mgr',  text: 'Capacity tab: rates, the bottleneck per line, and a calculator for when an order could ship.' },
    { who: 'mgr',  text: 'The manager PIN moved out of the code and into the sheet\'s settings.' }
  ]},
  { version: '2.12', date: '2026-08-23', title: 'Summary', items: [
    { who: 'mgr',  text: 'Summary tab: last 7 days, the floor, stock, buying, and how much of it to trust.' }
  ]},
  { version: '2.11', date: '2026-08-22', title: 'Buy', items: [
    { who: 'mgr',  text: 'Buy tab: what the work already on the floor still needs, against the shelf.' }
  ]},
  { version: '2.10', date: '2026-08-19', title: 'Straps counted', items: [
    { who: 'mgr',  text: 'Straps made at the strap station now count as stock, and get used up when they\'re attached.' }
  ]},
  { version: '2.9', date: '2026-08-13', title: 'Inventory', items: [
    { who: 'mgr',  text: 'Inventory tab: every material, estimate vs actual, count it in place.' },
    { who: 'crew', text: 'Products grouped by family in the picker.' }
  ]},
  { version: '2.0', date: '2026-08-08', title: 'The app', items: [
    { who: 'crew', text: 'Log My Day, Today\'s totals, hours per station.' },
    { who: 'mgr',  text: 'Overview, Receive, WIP baselines, and the sheet behind it all.' }
  ]}
];
