/* ----------------------------------------------------------------------------
 *  Aegis Inventory — configuration
 *  ----------------------------------------------------------------------------
 *  Paste your deployed Google Apps Script Web-App URL between the quotes below.
 *  It looks like:  https://script.google.com/macros/s/AKfy...long.../exec
 *
 *  (Full step-by-step in README.md — "Deploy the backend".)
 * -------------------------------------------------------------------------- */
// ⚠ MIGRATION IN PROGRESS: the backend now lives in the Apps Script bound to
// "John — Open Orders & Foam Cut List (LIVE)". Create its Web-app deployment
// (Deploy → New deployment → Web app, Execute as Me, Access: Anyone) and paste
// the new /exec URL below. Until then API_URL is intentionally blank so the
// app shows its setup banner instead of silently writing to the retired sheet.
//
// OLD deployment (retired standalone spreadsheet) — for reference/rollback:
//   https://script.google.com/macros/s/AKfycbzBybH7zX1MZO0N45E_Z8cZc3ajbnQ9r8ltjq-9eclW-bq2mVFjn60tqbyl8xKtR60G/exec
window.AEGIS_CONFIG = {
  API_URL: ""
};
