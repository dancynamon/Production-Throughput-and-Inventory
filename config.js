/* ----------------------------------------------------------------------------
 *  Aegis Inventory — configuration
 *  ----------------------------------------------------------------------------
 *  Paste your deployed Google Apps Script Web-App URL between the quotes below.
 *  It looks like:  https://script.google.com/macros/s/AKfy...long.../exec
 *
 *  MIGRATION 2026-07: the backend moved into the "John — Open Orders & Foam
 *  Cut List (LIVE)" spreadsheet. The URL below must be the NEW deployment from
 *  THAT sheet's Apps Script. The old deployment (bound to the retired
 *  "Aquamentor Production" sheet, id AKfycbzBybH7zX1MZO0N45E_Z8cZc3ajbnQ9r8lt
 *  jq-9eclW-bq2mVFjn60tqbyl8xKtR60G) must be ARCHIVED in Manage deployments so
 *  nothing can write to the old sheet.
 * -------------------------------------------------------------------------- */
window.AEGIS_CONFIG = {
  API_URL: ""  // ← paste the NEW /exec URL here before redeploying the site
};
