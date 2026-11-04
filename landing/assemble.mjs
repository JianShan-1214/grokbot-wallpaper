// Assembles the public site into one folder. `/` is a tiny page that forwards to the 3D office at
// office/ and keeps location.search and location.hash (the topic never goes to the server). The live
// wallpaper is at face/. Both load shared files from ../assets/. The marketing landing (landing/index.html,
// its fonts, media, icon and og image) is not published. The same tree goes to GitHub Pages
// (.github/workflows/pages.yml). Only these files go out: no journal, keys, source art, test pages or
// preview renders. A new file the site needs is added here.
//   node landing/assemble.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.argv[2] || '_site');
const parts = [
  // [from, to, which files, { deep: also its subfolders, optional: may not exist yet }]
  ['landing', '.', /^office-redirect\.html$/],             // copied, then published as /index.html below
  ['web/face', 'face', /^(index\.html|face\.css|face\.js)$/],
  ['web/data', 'data', /^demo-(state|looks)\.json$|^demo-events\.jsonl$/],
  ['lively/dist', 'download', /^grokbot-wallpaper-windows\.zip$/],   // the public Lively package (lively/build-public.ps1)
  // the 3D office: its page and modules (no *.html test pages), its demo data
  ['web', 'office', /^(index\.html|app\.js|styles\.css|wallpaper\.js|feed\.js)$/],
  ['web/lib', 'office/lib', /\.(js|css|json)$/, { deep: true, optional: true }],
  ['web/scene', 'office/scene', /\.(js|css)$/],
  ['web/ui', 'office/ui', /\.(js|css)$/],
  ['web/audio', 'office/audio', /\.(js|m4a)$/],
  ['web/share', 'office/share', /\.(js|css)$/],
  ['web/data', 'office/data', /^demo-(state|looks)\.json$|^demo-events\.jsonl$/],
  // assets, shared by the wallpaper and the office (no preview renders, no office-v1.glb)
  ['assets/face', 'assets/face', /^(sphere(-black)?\.png|eye-.+\.png|eyes\.json|grain\.png)$/],
  ['assets/blobs', 'assets/blobs', /\.glb$/],
  ['assets/blobs/thumbs', 'assets/blobs/thumbs', /\.png$/],
  ['assets/blobs/lib', 'assets/blobs/lib', /\.(png|json)$/, { optional: true }],
  ['assets/office', 'assets/office', /^office\.glb$/],
  ['assets/office/night', 'assets/office/night', /\.jpg$/],
  ['assets/brand', 'assets/brand', /\.(png|svg)$/],
  ['assets/earth', 'assets/earth', /^(day|night)\.jpg$/],
];

function copy(src, dst, keep, deep) {
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) { if (deep) n += copy(path.join(src, e.name), path.join(dst, e.name), keep, deep); continue; }
    if (!keep.test(e.name)) continue;
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
    n++;
  }
  return n;
}

// Drop marketing files a previous assemble may have left at the site root.
for (const rel of ['icon.png', 'og.png', 'PROMPT.md', 'fonts', 'media']) {
  fs.rmSync(path.join(out, rel), { recursive: true, force: true });
}

let total = 0;
for (const [from, to, keep, { deep = false, optional = false } = {}] of parts) {
  const src = path.join(repo, from);
  const n = fs.existsSync(src) ? copy(src, path.join(out, to), keep, deep) : 0;
  if (!n && !optional) throw new Error(`nothing to copy from ${from}/ (expected ${keep})`);
  total += n;
}

// `/` must be the forwarder, not landing/office-redirect.html and not the marketing page.
fs.renameSync(path.join(out, 'office-redirect.html'), path.join(out, 'index.html'));
console.log(`assembled ${total} files into ${out}`);
