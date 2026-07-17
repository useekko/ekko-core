// Copy the built MV3 extension into the Safari app-extension target, so Safari on iOS (and
// macOS) runs the SAME code as Chrome — same adapters, same crypto, same popup.
//
//   npm run ios:safari      (build + sync)
//
// Generated: never hand-edit anything under ios/EkkoSafari/Resources.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = join(root, 'ios/EkkoSafari/Resources');

// Subdirectories that ios/project.yml declares as folder references. Anything else esbuild
// starts emitting would be silently dropped from the appex, so fail loudly instead.
const DECLARED_DIRS = ['icons', 'fonts', 'chunks'];

if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('dist/ is not built — run `npm run build` first.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(dist, out, { recursive: true });

// --- Safari difference 1: the background service worker cannot be an ES module ---
// esbuild.mjs builds background.js as ESM with code-splitting (great for Chrome: the crypto is a
// shared chunk with the popup). Safari rejects `"type": "module"` on a service worker outright,
// so the extension would load with NO background at all — meaning no keys, no decrypt, nothing.
// Rebuild it here as one self-contained IIFE. The popup and onboarding stay ESM: those are page
// scripts, and Safari has supported module scripts in pages for years.
await build({
  entryPoints: [join(root, 'src/background.ts')],
  outfile: join(out, 'background.js'),
  bundle: true,
  format: 'iife',
  target: ['safari18'],
  legalComments: 'none',
  logLevel: 'error',
});

// --- Safari difference 2: manifest keys ---
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version; // Chrome-only key; Safari warns on unknown keys
delete manifest.background.type; // see above — the SW is now a classic script

// Safari matches host patterns strictly. Widen the messenger matches so a user who reaches
// instagram.com without the "www." still gets the content script.
const widen = (m) => [...new Set(m.flatMap((p) => (p.includes('://www.') ? [p, p.replace('://www.', '://')] : [p])))];
for (const cs of manifest.content_scripts ?? []) cs.matches = widen(cs.matches);

writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// --- guard: the appex only ships the subdirectories project.yml knows about ---
const dirs = readdirSync(out, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const undeclared = dirs.filter((d) => !DECLARED_DIRS.includes(d));
if (undeclared.length) {
  console.error(
    `\n✗ new subdirectory in the extension build: ${undeclared.join(', ')}\n` +
      `  Add it as a folder reference under the EkkoSafari target in ios/project.yml, or Safari\n` +
      `  will ship without those files.`,
  );
  process.exit(1);
}

console.log(`synced dist/ → ios/EkkoSafari/Resources (v${manifest.version}, background rebuilt as IIFE)`);
console.log(`  content scripts: ${(manifest.content_scripts ?? []).flatMap((c) => c.matches).join(', ')}`);
