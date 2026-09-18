// Bakes report-core.js and the current sheet snapshot into floor-report.html.
const fs = require('fs'), path = require('path');
const R = require('../report-core.js');
const dir = __dirname;
const mdFile = process.argv[2] || 'sheet-2026-09-18.md';
const md = fs.readFileSync(path.join(dir, mdFile), 'utf8');
const tables = R.parseSheet(md);
const snapshot = { at: 'Sep 18, 2026', tables };
const core = fs.readFileSync(path.join(dir, '..', 'report-core.js'), 'utf8').replace(/<\/script>/gi, '<\\/script>');
const src = fs.readFileSync(path.join(dir, 'floor-report.src.html'), 'utf8');
const json = JSON.stringify(snapshot).replace(/<\/script>/gi, '<\\/script>').replace(/<!--/g, '<\\!--');
const out = src.replace('/*__CORE__*/', () => core).replace('/*__SNAPSHOT__*/null', () => json);
fs.writeFileSync(path.join(dir, 'floor-report.html'), out);
console.log('wrote floor-report.html', out.length, 'bytes; stagelog rows', tables.stagelog.length);
