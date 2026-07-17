import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

// Content scripts: classic IIFE (content scripts can't be ES modules at runtime). One
// entry per messenger adapter; the shared code (Controller, glyph, dom, core) is bundled
// into each — they never run in the same tab, so there's nothing to code-split across them.
const contentCtx = await esbuild.context({
  entryPoints: {
    instagram: 'src/content/instagram.ts',
    whatsapp: 'src/content/whatsapp.ts',
    telegram: 'src/content/telegram.ts',
    messenger: 'src/content/messenger.ts',
    // Not a messenger adapter: the one-way bridge that carries a Google sign-in from the account
    // page back into the extension. Safari has no browser.identity, so a tab is the only road.
    'account-bridge': 'src/content/account-bridge.ts',
    // Not a messenger adapter either: the standalone "Seal for a contact" overlay, injected
    // on demand (activeTab) when the seal-anywhere shortcut fires on a page with no adapter.
    manual: 'src/content/manual.ts',
  },
  bundle: true,
  format: 'iife',
  target: ['chrome138', 'firefox133'],
  outdir: 'dist',
  legalComments: 'none',
  logLevel: 'info',
});

// Background SW + popup: ESM with code-splitting, so the shared crypto is one chunk and
// the popup's QR libraries load lazily (dynamic import) instead of on every popup open.
const moduleCtx = await esbuild.context({
  entryPoints: { background: 'src/background.ts', popup: 'src/popup/popup.ts', onboarding: 'src/onboarding/onboarding.ts' },
  bundle: true,
  format: 'esm',
  splitting: true,
  target: ['chrome138', 'firefox133'],
  outdir: 'dist',
  chunkNames: 'chunks/[name]-[hash]',
  legalComments: 'none',
  logLevel: 'info',
});

async function copyStatic() {
  await cp('manifest.json', 'dist/manifest.json');
  await cp('src/popup/popup.html', 'dist/popup.html');
  await cp('src/onboarding/onboarding.html', 'dist/onboarding.html');
  await cp('icons', 'dist/icons', { recursive: true });
  await cp('src/fonts', 'dist/fonts', { recursive: true });
}

if (watch) {
  await Promise.all([contentCtx.watch(), moduleCtx.watch()]);
  await copyStatic();
  console.log('watching…');
} else {
  await Promise.all([contentCtx.rebuild(), moduleCtx.rebuild()]);
  await copyStatic();
  await contentCtx.dispose();
  await moduleCtx.dispose();
  console.log('built → dist/');
}
