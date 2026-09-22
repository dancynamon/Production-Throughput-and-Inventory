// Builds help/crew.html and help/managers.html (full documents, served by the
// app's own site) from the fragments in help/src/. The fragments are also what
// gets published as Claude artifacts, which wrap their own document skeleton.
//   node help/build.js
const fs = require('fs'), path = require('path');
const src = path.join(__dirname, 'src');
const style = fs.readFileSync(path.join(src, '_style.html'), 'utf8');
['crew', 'managers'].forEach((name) => {
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
