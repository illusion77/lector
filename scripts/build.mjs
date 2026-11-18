// Builds the extension for Chrome (dist/chrome) and Safari (dist/safari).
//
//   npm run build            both targets
//   npm run watch            rebuild on change
//
// The voice model is copied in from vendor/model (npm run fetch-model).

import { context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

const RUNTIME = ['index.js', 'worker.js', 'fetch.js', 'hub.js', 'wav.js', 'threads.js', 'device.js', 'simd.js', 'gpu', 'wasm', 'LICENSE-MIT', 'LICENSE-APACHE', 'THIRD_PARTY_LICENSES.md'];
const ICON_SIZES = [16, 32, 48, 96, 128, 256];

function manifest(target) {
  const icons = Object.fromEntries(ICON_SIZES.filter((s) => s <= 128).map((s) => [s, `icons/icon-${s}.png`]));
  const m = {
    manifest_version: 3,
    name: 'Lector',
    version: pkg.version,
    description: 'Read any page aloud, one sentence at a time, with a natural voice that runs on your device.',
    icons,
    action: { default_title: 'Read this page aloud', default_icon: { 16: icons[16], 32: icons[32], 48: icons[48] } },
    permissions: ['storage', 'scripting'],
    host_permissions: ['<all_urls>'],
    content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle', all_frames: true }],
    web_accessible_resources: [{ resources: ['player.html'], matches: ['<all_urls>'] }],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
  };
  if (target === 'chrome') {
    m.background = { service_worker: 'background.js' };
    m.permissions.push('contextMenus');
    m.minimum_chrome_version = '116';
  } else {
    // a non-persistent background page, not a service worker: on iOS, Safari stops the
    // worker after a while and doesn't always start it again, so taps on Lector go nowhere
    m.background = { scripts: ['background.js'], persistent: false };
    m.browser_specific_settings = { safari: { strict_min_version: '17.0' } };
  }
  return m;
}

/** Points the player's `phonon-tts` import at the copy shipped beside it. */
const phononExternal = {
  name: 'phonon-external',
  setup(build) {
    build.onResolve({ filter: /^phonon-tts$/ }, () => ({ path: './vendor/phonon-tts/index.js', external: true }));
  },
};

async function assets(out) {
  await mkdir(out, { recursive: true });
  for (const f of ['player.html', 'player.css']) await cp(path.join(ROOT, 'src/player', f), path.join(out, f));
  const runtime = path.join(ROOT, 'node_modules/phonon-tts');
  for (const f of RUNTIME) await cp(path.join(runtime, f), path.join(out, 'vendor/phonon-tts', f), { recursive: true });
  const model = path.join(ROOT, 'vendor/model');
  if (!existsSync(path.join(model, 'model.q8.gguf'))) {
    console.warn('! vendor/model is missing: run `npm run fetch-model` first');
  } else {
    await cp(model, path.join(out, 'model'), { recursive: true });
  }
  for (const s of ICON_SIZES) await cp(path.join(ROOT, `assets/icons/icon-${s}.png`), path.join(out, `icons/icon-${s}.png`));
}

async function buildTarget(target) {
  const out = path.join(ROOT, 'dist', target);
  if (!watch) await rm(out, { recursive: true, force: true });
  await assets(out);
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest(target), null, 2) + '\n');
  const common = {
    bundle: true,
    target: ['chrome116', 'safari17'],
    logLevel: 'warning',
    legalComments: 'none',
    define: {
      'process.env.NODE_ENV': '"production"',
      // LECTOR_DEBUG=http://host:port sends debug logs there (see src/shared/debug.ts)
      __LECTOR_DEBUG__: JSON.stringify(process.env.LECTOR_DEBUG ?? ''),
    },
  };
  const contexts = await Promise.all([
    context({ ...common, entryPoints: [path.join(ROOT, 'src/background.ts')], outfile: path.join(out, 'background.js'), format: 'iife' }),
    context({ ...common, entryPoints: [path.join(ROOT, 'src/content/main.ts')], outfile: path.join(out, 'content.js'), format: 'iife' }),
    context({ ...common, entryPoints: [path.join(ROOT, 'src/player/player.ts')], outfile: path.join(out, 'player.js'), format: 'esm', plugins: [phononExternal] }),
  ]);
  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
  }
  console.log(`built ${path.relative(ROOT, out)}`);
}

await buildTarget('chrome');
await buildTarget('safari');
if (watch) console.log('watching for changes…');
