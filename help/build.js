// Builds help/crew.html (the one public page, served by the app's own site)
// from the fragments in help/src/; the manager guide and the changelog are
// managers-only and never land on the site. The fragments are also what
// gets published as Claude artifacts, which wrap their own document skeleton.
//   node help/build.js
const fs = require('fs'), path = require('path');
const src = path.join(__dirname, 'src');
const style = fs.readFileSync(path.join(src, '_style.html'), 'utf8');
// Changelog page from changelog.js — same words the app shows.
const vm = require('vm');
const ctx = { window: {} }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'changelog.js'), 'utf8'), ctx);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const log = ctx.window.AQ_CHANGELOG || [];
const changelog = '<title>Aquamentor Changelog</title>\n<!--STYLE-->\n<div class="band"><div class="wrap"><div class="eyebrow">Aquamentor Production</div><h1>What changed</h1>'
  + '<p>Every version, newest first, in plain words. Managers see this list on the app\'s What\'s new tab.</p>'
  + '<a class="app-link" href="https://prod-through-inv-3.dan-daf.workers.dev" target="_blank" rel="noopener">Open the app</a></div></div>\n<div class="wrap">'
  + log.map((v) => '<section><h2>' + esc(v.version) + ' · ' + esc(v.title) + '</h2><p style="margin-top:2px;color:var(--muted);font-size:.88rem">' + esc(v.date) + '</p><ul>'
      + v.items.map((it) => '<li>' + esc(it.text) + (it.who === 'mgr' ? ' <span class="kbd">managers</span>' : '') + '</li>').join('') + '</ul></section>').join('')
  + '<footer>Aquamentor Production</footer></div>\n';
fs.writeFileSync(path.join(src, 'changelog.html'), changelog);
// The manager guide is NOT published on the site: it is baked into Code.gs
// and served only to listed managers who unlocked with their own PIN. The
// changelog page is written to help/_private/ only (managers-only since 2.24.2).
const PUBLIC = ['crew'];
const BAKED = ['managers'];
['crew', 'managers', 'changelog'].forEach((name) => {
  const frag = fs.readFileSync(path.join(src, name + '.html'), 'utf8');
  const titleMatch = /<title>([^<]+)<\/title>/.exec(frag);
  const body = frag.replace(/<title>[^<]*<\/title>\s*/, '').replace('<!--STYLE-->', '');
  const doc = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    + '<meta name="robots" content="noindex">\n<title>' + (titleMatch ? titleMatch[1] : name) + '</title>\n' + style + '</head>\n<body>\n' + body + '\n</body>\n</html>\n';
  if (PUBLIC.includes(name)) fs.writeFileSync(path.join(__dirname, name + '.html'), doc);
  else if (!BAKED.includes(name)) {
    fs.mkdirSync(path.join(__dirname, '_private'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '_private', name + '.html'), doc);
  } else {
    // Full document for the app's iframe (srcdoc resolves relative URLs against
    // the app, so image and page paths get the help/ prefix). Also written to
    // help/_private/ for the PDF, which is gitignored.
    const inApp = doc.replace(/src="img\//g, 'src="help/img/').replace(/href="(crew|changelog)\.html"/g, 'href="help/$1.html" target="_blank"');
    const gs = path.join(__dirname, '..', 'apps-script', 'Code.gs');
    const code = fs.readFileSync(gs, 'utf8');
    const start = code.indexOf('/*GUIDE:BEGIN*/'), end = code.indexOf('/*GUIDE:END*/');
    if (start === -1 || end === -1) throw new Error('GUIDE markers missing from Code.gs');
    const literal = JSON.stringify(inApp).replace(/<\/script/gi, '<\\/script');
    fs.writeFileSync(gs, code.slice(0, start) + '/*GUIDE:BEGIN*/\nvar MANAGER_GUIDE_HTML = ' + literal + ';\n' + code.slice(end));
    fs.mkdirSync(path.join(__dirname, '_private'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '_private', name + '.html'), doc);
  }
  // Artifact copy: fragment with the style inlined where the marker sits.
  fs.writeFileSync(path.join(__dirname, name + '.artifact.html'), frag.replace('<!--STYLE-->', style));
  console.log('built ' + name + (PUBLIC.includes(name) ? ' (public)' : BAKED.includes(name) ? ' (baked into Code.gs)' : ' (private)'));
});
