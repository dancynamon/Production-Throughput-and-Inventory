// Builds help/crew.html and help/managers.html (full documents, served by the
// app's own site) from the fragments in help/src/. The fragments are also what
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
  + '<p>Every version, newest first, in plain words. Items marked <b>managers</b> are behind the lock. The app shows the same list on its What\'s new tab.</p>'
  + '<a class="app-link" href="https://prod-through-inv-3.dan-daf.workers.dev" target="_blank" rel="noopener">Open the app</a></div></div>\n<div class="wrap">'
  + log.map((v) => '<section><h2>' + esc(v.version) + ' · ' + esc(v.title) + '</h2><p style="margin-top:2px;color:var(--muted);font-size:.88rem">' + esc(v.date) + '</p><ul>'
      + v.items.map((it) => '<li>' + esc(it.text) + (it.who === 'mgr' ? ' <span class="kbd">managers</span>' : '') + '</li>').join('') + '</ul></section>').join('')
  + '<footer>Aquamentor Production · <a href="crew.html">Crew guide</a> · <a href="managers.html">Manager guide</a></footer></div>\n';
fs.writeFileSync(path.join(src, 'changelog.html'), changelog);
['crew', 'managers', 'changelog'].forEach((name) => {
  const frag = fs.readFileSync(path.join(src, name + '.html'), 'utf8');
  const titleMatch = /<title>([^<]+)<\/title>/.exec(frag);
  const body = frag.replace(/<title>[^<]*<\/title>\s*/, '').replace('<!--STYLE-->', '');
  const doc = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    + '<meta name="robots" content="noindex">\n<title>' + (titleMatch ? titleMatch[1] : name) + '</title>\n' + style + '</head>\n<body>\n' + body + '\n</body>\n</html>\n';
  fs.writeFileSync(path.join(__dirname, name + '.html'), doc);
  // Artifact copy: fragment with the style inlined where the marker sits.
  fs.writeFileSync(path.join(__dirname, name + '.artifact.html'), frag.replace('<!--STYLE-->', style));
  console.log('wrote help/' + name + '.html');
});
