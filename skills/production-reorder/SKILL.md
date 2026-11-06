---
name: production-reorder
description: Read the Reorder tab of the "Aquamentor Production" Google Sheet (materials at or under reorder point, floor work outrunning the shelf, or order-by date within 5 working days), group by supplier, build one DRAFT QBO purchase order per supplier with the suggested quantities, render the branded PO PDF, draft the vendor email, and stop at the send gate. Trigger when Dan says "run reorders", "what do I need to order", "build POs for what's low", "reorder run", "anything under reorder point", "Alex/John says we're low on X", or on the Monday-morning reorder schedule after the weekly counts. Also keeps one standing (unsent) QBO PO per supplier topped up to a full order from the SuggestedPOs tab: trigger on "update the standing POs", "refresh suggested POs", "top up POs", or the weekly standing-PO schedule. Never sends a PO or an email.
---

# Production reorder run

Source of truth: the **Reorder** tab of `Aquamentor Production`
(https://docs.google.com/spreadsheets/d/1dOou3HsIWdkbt_2joiqtRgV85-r1usxpB4O2ElRc-xk/edit).
The app's backend rebuilds it after every shelf count, every delivery, on the
Monday 6am schedule, and from the sheet menu (Maintenance → Rebuild the
Reorder tab now). The same list shows as a banner to Alex and John in the app.

Do NOT use the "Aquamentor Live Dashboard" sheet or the aquamentor-inventory-sync
skill for this; that is a different inventory.

## Columns (Reorder tab)

`Generated, MaterialID, MaterialName, Unit, OnHand, ReorderPoint, Committed,
DailyUse, OrderBy, Supplier, LeadDays, QBOItem, ReorderQty, SuggestedQty, Reason,
GoodStock, NextExpires, UsedBeforeHalfway`

- One row per material that is due. A single row reading "Nothing to reorder"
  means the list is empty.
- `SuggestedQty` = `ReorderQty` (Dan's usual order size, typed on RawMaterials)
  or, when blank, 4 weeks of observed use plus what the floor is owed, or back
  to twice the reorder point, whichever is larger. Blank = no basis; ask.
- `ReorderPoint` is the typed one, or (blank on RawMaterials) half of
  `ReorderQty` or of the last delivery; `Reason` says which.
- `UsedBeforeHalfway`: for a material that expires, how much the floor uses
  before a new lot would be halfway to expiring. A computed `SuggestedQty` is
  already cut to it; when `ReorderQty` is bigger, `Reason` says so. Mention it
  under FLAGGED so Dan can order less.
- `Supplier` is the QBO vendor display name. `QBOItem` is the QBO item name;
  blank means use `MaterialName` and confirm the match in QBO.
- Materials that were never counted are NOT on the list (the backend can't
  judge an uncounted shelf). The "Nothing to reorder" row says how many.

## Steps

1. **Read the tab with the Sheets API** (google-workspace skill, range
   `Reorder!A1:R200`). The Drive file reader truncates to ~11 rows per tab;
   don't trust it for this. If `Generated` is older than 8 days, say so and
   ask Dan to run Maintenance → Rebuild the Reorder tab now (or note it under
   FLAGGED and continue with the stale list, stamped stale).
2. **Check QBO is alive** before reading or writing: qbo_health is not enough;
   check `currentUrl` and `realmId`, or call `qbo_reload_session` and trust its
   `status`. Dead after one recover = DEAD stop, never "no POs needed".
3. **Group rows by Supplier.** Rows with no Supplier, no resolvable QBO item,
   or blank SuggestedQty go to FLAGGED, not into a PO. Offer to fill the
   missing Supplier / QBOItem / ReorderQty cells on RawMaterials (that is a
   sheet edit: ask first).
4. **Duplicate guard.** For each supplier, look for an open (not received/
   closed) QBO purchase order to that vendor from the last 21 days that
   already contains the item. If found, skip that line and list the existing
   PO with its deep link.
5. **Build one DRAFT QBO purchase order per supplier** through qbo-headless,
   the same way `vendor-dropship-po` builds POs: vendor = Supplier, one line
   per material (QBO item, SuggestedQty, the item's last purchase cost), ship-to
   the Garwood shop, memo `Reorder from production app <date>: <MaterialID>
   <Reason>`. Do not send it from QBO.
6. **Branded PO PDF** for each with `branded-po`.
7. **Vendor email DRAFT** per PO in Gmail (dan@aquamentor.com), following
   `aquamentor-email-style` (no em dashes, signature block, ask as a favor).
   Attach the branded PDF. Never send.
8. **Report once**, Dan's format:

```
DID: <n> draft POs built for <suppliers>, <m> lines

GATE: <n> vendor emails drafted, waiting on "send it" (links below)

FLAGGED: <rows skipped: no supplier / no QBO item / no qty / already on PO #>
```

Then one table row per PO: supplier, PO number with QBO deep link, lines
(material x qty), total, Gmail draft link.

## Standing POs (weekly top-up)

Dan, 2026-11-06: keep a PO per supplier "which the value gets changed weekly with
how much more inventory we need to get to 100%", even before a reorder point.

Source: the **SuggestedPOs** tab (rebuilt with the Reorder tab), range
`SuggestedPOs!A1:K300`. Columns `Generated, Supplier, MaterialID, MaterialName,
Unit, QBOItem, GoodStock, FullLevel, TopUpQty, DueNow, Note`. FullLevel is a full
order (ReorderQty, else the last delivery, else twice the reorder point);
TopUpQty is what gets the shelf back there, already cut for things that expire.
`DueNow` = YES means it is also on the Reorder tab.

1. Read the tab with the Sheets API; stale (`Generated` > 8 days) = say so.
2. QBO alive check, as in step 2 above.
3. Per supplier (skip blank / "(no supplier)", list them under FLAGGED), find
   the **standing PO**: an open, NOT emailed QBO PO to that vendor whose memo
   starts `Standing reorder PO (production app)`.
   - Found: make its lines match the tab exactly (QBOItem x TopUpQty, last
     purchase cost), drop lines no longer on the tab, and set the memo to
     `Standing reorder PO (production app), updated <date>`. Use the
     `expect_*` preconditions on update.
   - Not found: create it the same way as step 5, with that memo.
   - Supplier has no lines left: leave its standing PO as it is, memo
     `... nothing needed as of <date>`, and say so. Never delete or void it.
4. A PO that was emailed or partly received is a real order now: never edit
   it. Its open lines count as already ordered, so leave those materials off
   the new standing PO (duplicate guard, step 4 above).
5. No PDF and no vendor email in this mode. When Dan says to send a supplier's
   standing PO, run steps 6 and 7 for it and stop at the send gate.
6. Report: `DID: standing POs updated for <suppliers> (<n> lines, $<total>)`,
   then one row per supplier with the PO number, deep link, lines and total, and
   what changed since last week.

## Hard stops

- Never send a PO or an email. Never mark a PO sent. Drafts only.
- Never edit a PO that was emailed or received, and never delete or void one.
- Never change ReorderPoint, ReorderQty, Supplier or QBOItem without asking.
- An unreachable sheet or QBO session is never reported as "nothing to order".
