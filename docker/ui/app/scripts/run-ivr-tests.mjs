/**
 * Runs the IVR builder's self-tests (the *.assert.ts files under src/flow/).
 * Each one is a plain module that throws on the first failure. Run from
 * docker/ui/app:
 *
 *   node scripts/run-ivr-tests.mjs
 *
 * NODE_SUITES are dependency-free: Node's built-in type stripping runs them
 * with no bundler. VITE_SUITES import .tsx components or the builder store
 * (React Flow, zustand), so they run through Vite's SSR module loader — the
 * same trick as scripts/run-layout-test.mjs: no browser, no extra package.
 */
import { spawnSync } from 'node:child_process';

const NODE_SUITES = [
  'src/flow/compile/ivr.assert.ts',
  'src/flow/model/model.assert.ts',
  'src/flow/assist/assist.assert.ts',
];

const VITE_SUITES = ['src/flow/assist/assistUi.assert.ts'];

let failed = 0;
for (const suite of NODE_SUITES) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', suite], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed += 1;
    console.error(`✗ ${suite}`);
  }
}

if (VITE_SUITES.length) {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false, // no react/tailwind plugins: the suites render to strings
    root: process.cwd(),
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    for (const suite of VITE_SUITES) {
      try {
        await server.ssrLoadModule(`/${suite}`);
      } catch (err) {
        failed += 1;
        console.error(err instanceof Error ? err.message : err);
        console.error(`✗ ${suite}`);
      }
    }
  } finally {
    await server.close();
  }
}

process.exitCode = failed === 0 ? 0 : 1;
