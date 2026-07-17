// Package the built extension into an uploadable .zip.
//   node scripts/package.mjs            → Chromium zip (Chrome Web Store, Edge, Brave, Opera, Arc…)
//   node scripts/package.mjs --firefox  → also a Firefox (AMO) variant (experimental — see note)
// Assumes `dist/` is freshly built; the npm `package` script runs the build first.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'artifacts');
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
const version = manifest.version;

// One reproducible zip of a folder's CONTENTS (manifest at the zip root, which the stores
// require). -X drops extra file attributes; we exclude macOS junk.
function zipDir(srcDir, zipPath) {
  rmSync(zipPath, { force: true }); // zip APPENDS otherwise
  execFileSync('zip', ['-r', '-X', '-q', zipPath, '.', '-x', '*.DS_Store'], { cwd: srcDir });
  return (statSync(zipPath).size / 1024).toFixed(0);
}

mkdirSync(OUT, { recursive: true });

// —— Chromium (Chrome/Edge/Brave/Opera/Arc/Vivaldi all install this same zip) ——
const chromeZip = join(OUT, `ekko-${version}-chromium.zip`);
const chromeKb = zipDir(DIST, chromeZip);
console.log(`✓ Chromium  artifacts/ekko-${version}-chromium.zip  (${chromeKb} KB)`);

// —— Firefox (experimental: same MV3 + service-worker background + a gecko id) ——
if (process.argv.includes('--firefox')) {
  const tmp = join(OUT, '.firefox-build');
  rmSync(tmp, { recursive: true, force: true });
  cpSync(DIST, tmp, { recursive: true });
  const ff = { ...manifest };
  delete ff.minimum_chrome_version; // Chrome-only key
  ff.browser_specific_settings = { gecko: { id: 'ekko@useekko.app', strict_min_version: '121.0' } };
  writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(ff, null, 2));
  const ffZip = join(OUT, `ekko-${version}-firefox.zip`);
  const ffKb = zipDir(tmp, ffZip);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`✓ Firefox   artifacts/ekko-${version}-firefox.zip   (${ffKb} KB)  [EXPERIMENTAL — needs a Firefox test]`);
}

console.log(`
Next:
  • Load unpacked (dev):   chrome://extensions → Developer mode → Load unpacked → pick dist/
  • Publish (Chrome):      upload the chromium .zip at chrome.google.com/webstore/devconsole
  • Any Chromium browser:  the same chromium .zip installs on Edge / Brave / Opera / Arc
  • Bump the version in manifest.json before each store upload (stores reject a re-used version).`);
