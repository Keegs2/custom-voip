/**
 * Runner for the SIP-ladder layout fixture test.
 *
 * Uses Vite's SSR module loader so the TypeScript sources under src/ run
 * unmodified (handles TS, import.meta.env, path resolution) with zero extra
 * dependencies. Run from docker/ui/app:
 *
 *   node scripts/run-layout-test.mjs
 */
import { createServer } from 'vite';

const server = await createServer({
  configFile: false, // skip react/tailwind plugins — pure TS logic under test
  root: process.cwd(),
  logLevel: 'silent',
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});

try {
  const mod = await server.ssrLoadModule('/scripts/sipLadderLayout.fixture.test.ts');
  const failures = mod.run();
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await server.close();
}
