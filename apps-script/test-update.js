/* Self-update from GitHub. Pinned: nothing happens when the stamp on GitHub
 * is the one running; an update replaces the one script file and keeps the
 * manifest verbatim, cuts a version, moves the existing deployment, and
 * proves the web app answers with the new stamp; a failed canary rolls the
 * deployment back; a file that is not Code.gs is never deployed; the
 * deployment is found without configuration when there is exactly one.
 *
 * Run:  node apps-script/test-update.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let store = {}, calls = [], mails = [], triggers = [];
let github = null, canary = null;
const sandbox = {
  UrlFetchApp: { fetch: (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || 'get', payload: opts && opts.payload ? JSON.parse(opts.payload) : undefined });
    if (url.indexOf('/config.js') !== -1) return { getResponseCode: () => 200, getContentText: () => 'window.AEGIS_CONFIG={API_URL:"https://script.google.com/macros/s/' + (sandbox.__configDep || 'DEP') + '/exec"};' };
    if (url.indexOf('raw.githubusercontent.com') !== -1) return { getResponseCode: () => github.code, getContentText: () => github.body };
    // The live web app answers with whatever is DEPLOYED: the old stamp until
    // the deployment is moved to version 8, then whatever `canary` says.
    if (url.indexOf('/exec?action=config') !== -1) return sandbox.__deployedVersion === 8
      ? { getResponseCode: () => canary.code, getContentText: () => canary.body }
      : { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, buildStamp: sandbox.__liveStamp }) };
    const m = /projects\/SID\/(.*)$/.exec(url); const p = m ? m[1] : '';
    const method = (opts.method || 'get').toLowerCase();
    let body = {};
    if (p === 'content' && method === 'get') body = { files: [
      { name: 'Code', type: 'SERVER_JS', source: 'old source' },
      { name: 'appsscript', type: 'JSON', source: '{"webapp":{"access":"ANYONE_ANONYMOUS"}}' } ] };
    else if (p === 'deployments' && method === 'get') body = sandbox.__deployments;
    else if (p === 'deployments/DEP' && method === 'get') body = { deploymentId: 'DEP', deploymentConfig: { versionNumber: 7, description: 'Prod' } };
    else if (p === 'versions' && method === 'post') body = { versionNumber: 8 };
    if (p === 'deployments/DEP' && method === 'put') sandbox.__deployedVersion = JSON.parse(opts.payload).deploymentConfig.versionNumber;
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
  } },
  ScriptApp: { getOAuthToken: () => 'tok', getScriptId: () => 'SID',
    getProjectTriggers: () => triggers.map((h) => ({ getHandlerFunction: () => h })), deleteTrigger: () => {},
    newTrigger: (h) => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => triggers.push(h) }), onWeekDay: () => ({ atHour: () => ({ create() {} }) }) }) }),
    WeekDay: { MONDAY: 1 } },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: (k) => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = v; }, deleteProperty: (k) => { delete store[k]; } }) },
  MailApp: { sendEmail: (m) => mails.push(m) },
  SpreadsheetApp: { getActive: () => ({ toast() {} }), getActiveSpreadsheet: () => ({ getName: () => 'S', getId: () => 'ID', getSheetByName: () => null }), getUi: () => ({}) },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'dan@example.com' }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Logger: { log() {} }, ContentService: { MimeType: {}, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
  console, JSON, Math, Number, String, Object, Array, Date, isNaN, isFinite, RegExp, Error
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox);
sandbox.readObjects = () => [];
sandbox.__deployments = { deployments: [
  { deploymentId: 'HEAD', deploymentConfig: {}, entryPoints: [{ entryPointType: 'WEB_APP' }] },
  { deploymentId: 'DEP', deploymentConfig: { versionNumber: 7 }, entryPoints: [{ entryPointType: 'WEB_APP' }] } ] };

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(actual)}  want ${JSON.stringify(expected)}`);
}
const running = sandbox.BUILD_STAMP;
const newSrc = (stamp) => `header\nfunction doGet(e) {}\nvar BACKEND_VERSION = '9.9.9';\nvar BUILD_STAMP = '${stamp}';\n`;
const reset = () => { calls = []; mails = []; store = {}; sandbox.__deployedVersion = 7; sandbox.__liveStamp = running; sandbox.__configDep = 'DEP'; };
const wroteContent = () => calls.some((c) => c.method === 'put' && /\/content$/.test(c.url));
const cutVersion = () => calls.some((c) => c.method === 'post' && /\/versions$/.test(c.url));

/* --- Same stamp: nothing moves ---------------------------------------------- */
reset(); github = { code: 200, body: newSrc(running) };
check('same stamp live: nothing written, no version cut',
  [sandbox.updateFromGitHub().changed, wroteContent(), cutVersion()], [false, false, false]);
check('the deployment was taken from config.js on GitHub, among two candidates', store.DEPLOYMENT_ID, 'DEP');

/* --- Saved code ahead of the deployment (a run that died mid-way) ---------- */
reset(); github = { code: 200, body: newSrc(running) }; sandbox.__liveStamp = '2000-01-01 00:00 UTC'; canary = { code: 200, body: JSON.stringify({ buildStamp: running }) };
const resumed = sandbox.updateFromGitHub();
check('GitHub equals the saved code but the live app is behind: cut the version without rewriting the code',
  [resumed.changed, wroteContent(), cutVersion(), resumed.versionNumber], [true, false, true, 8]);

/* --- New stamp: the full round ---------------------------------------------- */
reset(); github = { code: 200, body: newSrc('2099-01-01 00:00 UTC') }; canary = { code: 200, body: '{"ok":true,"buildStamp":"2099-01-01 00:00 UTC"}' };
const r = sandbox.updateFromGitHub();
check('reports the move', [r.changed, r.version, r.versionNumber, r.previous], [true, '9.9.9', 8, 7]);
const put = calls.filter((c) => c.method === 'put' && /\/content$/.test(c.url))[0];
check('the script file is replaced and the manifest kept verbatim',
  put.payload.files.map((f) => [f.name, /BUILD_STAMP = '2099/.test(f.source) ? 'NEW' : f.source]),
  [['Code', 'NEW'], ['appsscript', '{"webapp":{"access":"ANYONE_ANONYMOUS"}}']]);
check('the one versioned web-app deployment is found and remembered', store.DEPLOYMENT_ID, 'DEP');
const dep = calls.filter((c) => c.method === 'put' && /deployments\/DEP$/.test(c.url));
check('the existing deployment is moved to the new version — never a new deployment',
  [dep.length, dep[0].payload.deploymentConfig.versionNumber, dep[0].payload.deploymentConfig.manifestFileName], [1, 8, 'appsscript']);
check('the canary hit the live web app anonymously', calls.some((c) => /macros\/s\/DEP\/exec\?action=config/.test(c.url)), true);
check('the result is remembered for diagnostics', /9\.9\.9/.test(store.LAST_AUTO_UPDATE), true);

/* --- Canary fails: roll back ------------------------------------------------ */
reset(); canary = { code: 200, body: '{"ok":true,"buildStamp":"' + running + '"}' };
let err = null; try { sandbox.updateFromGitHub(); } catch (e) { err = e.message; }
const puts = calls.filter((c) => c.method === 'put' && /deployments\/DEP$/.test(c.url)).map((c) => c.payload.deploymentConfig.versionNumber);
check('a web app still answering the old stamp rolls the deployment back', [puts, /rolled the deployment back to version 7/i.test(err)], [[8, 7], true]);

reset(); canary = { code: 500, body: 'boom' };
err = null; try { sandbox.updateFromGitHub(); } catch (e) { err = e.message; }
check('a web app that errors rolls back too', /HTTP 500/.test(err) && /back to version 7/.test(err), true);

/* --- Guard rails ------------------------------------------------------------ */
reset(); github = { code: 404, body: 'nope' };
err = null; try { sandbox.updateFromGitHub(); } catch (e) { err = e.message; }
check('GitHub down: nothing deployed', [/404/.test(err), calls.length], [true, 1]);
reset(); sandbox.__deployments = { deployments: [] }; github = { code: 200, body: newSrc('2099-02-02 00:00 UTC') };
err = null; try { sandbox.updateFromGitHub(); } catch (e) { err = e.message; }
check('no deployment to move: fails BEFORE writing code, so saved code never runs ahead of live', [/Deploy once by hand/.test(err), wroteContent()], [true, false]);
sandbox.__deployments = { deployments: [
  { deploymentId: 'DEP', deploymentConfig: { versionNumber: 7 }, entryPoints: [{ entryPointType: 'WEB_APP' }] },
  { deploymentId: 'DEP2', deploymentConfig: { versionNumber: 3 }, entryPoints: [{ entryPointType: 'WEB_APP' }] } ] };
reset(); sandbox.__configDep = 'DEP9'; err = null; try { sandbox.updateFromGitHub(); } catch (e) { err = e.message; }
check('two deployments and config.js names neither: asks for the ID instead of guessing', /none matches config.js/.test(err), true);
reset(); sandbox.__configDep = 'DEP2'; github = { code: 200, body: newSrc(running) };
sandbox.updateFromGitHub();
check('two deployments: the one config.js names wins', store.DEPLOYMENT_ID, 'DEP2');
sandbox.__deployments = { deployments: [
  { deploymentId: 'HEAD', deploymentConfig: {}, entryPoints: [{ entryPointType: 'WEB_APP' }] },
  { deploymentId: 'DEP', deploymentConfig: { versionNumber: 7 }, entryPoints: [{ entryPointType: 'WEB_APP' }] } ] };
reset(); github = { code: 200, body: '<html>not a script</html>' };
err = null; try { sandbox.updateFromGitHub(); } catch (e) { err = e.message; }
check('a page that is not Code.gs is refused', /does not look like Code.gs/.test(err), true);

/* --- The trigger mails once per distinct failure ---------------------------- */
reset(); github = { code: 404, body: 'nope' };
sandbox.autoUpdateFromGitHub(); sandbox.autoUpdateFromGitHub();
check('the same failure twice is one email', mails.length, 1);
github = { code: 200, body: newSrc(running) }; sandbox.autoUpdateFromGitHub();
check('nothing to do sends nothing', mails.length, 1);
sandbox.__deployments = { deployments: [{ deploymentId: 'DEP', deploymentConfig: { versionNumber: 7 }, entryPoints: [{ entryPointType: 'WEB_APP' }] }] };
sandbox.__deployedVersion = 7; github = { code: 200, body: newSrc('2099-03-03 00:00 UTC') }; canary = { code: 200, body: '2099-03-03 00:00 UTC' };
sandbox.autoUpdateFromGitHub();
check('a real update mails a note and clears the remembered failure', [mails.length, /updated to 9\.9\.9/.test(mails[1].subject), store.AUTO_UPDATE_ERROR], [2, true, undefined]);
sandbox.autoUpdateOn();
check('turning it on installs exactly one trigger', triggers.filter((h) => h === 'autoUpdateFromGitHub').length, 1);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
