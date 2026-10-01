---
name: production-reorder
description: Read the Reorder tab of the "Aquamentor Production" Google Sheet (materials at or under reorder point, floor work outrunning the shelf, or order-by date within 5 working days), group by supplier, build one DRAFT QBO purchase order per supplier with the suggested quantities, render the branded PO PDF, draft the vendor email, and stop at the send gate. Trigger when Dan says "run reorders", "what do I need to order", "build POs for what's low", "reorder run", "anything under reorder point", "Alex/John says we're low on X", or on the Monday-morning reorder schedule after the weekly counts. Never sends a PO or an email.
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
DailyUse, OrderBy, Supplier, LeadDays, QBOItem, ReorderQty, SuggestedQty, Reason`

- One row per material that is due. A single row reading "Nothing to reorder"
  means the list is empty.
- `SuggestedQty` = `ReorderQty` (Dan's usual order size, typed on RawMaterials)
  or, when blank, 4 weeks of observed use plus what the floor is owed, or back
  to twice the reorder point, whichever is larger. Blank = no basis; ask.
- `Supplier` is the QBO vendor display name. `QBOItem` is the QBO item name;
  blank means use `MaterialName` and confirm the match in QBO.
- Materials that were never counted are NOT on the list (the backend can't
  judge an uncounted shelf). The "Nothing to reorder" row says how many.

## Steps

1. **Read the tab with the Sheets API** (google-workspace skill, range
   `Reorder!A1:O200`). The Drive file reader truncates to ~11 rows per tab;
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

## Hard stops

- Never send a PO or an email. Never mark a PO sent. Drafts only.
- Never change ReorderPoint, ReorderQty, Supplier or QBOItem without asking.
- An unreachable sheet or QBO session is never reported as "nothing to order".
