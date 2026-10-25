/**
 * Runs the IVR builder's dependency-free self-tests (the *.assert.ts files
 * under src/flow/). Each one is a plain module that throws on the first
 * failure; Node's built-in type stripping runs them with no bundler.
 * Run from docker/ui/app:
 *
 *   node scripts/run-ivr-tests.mjs
 */
import { spawnSync } from 'node:child_process';

const SUITES = ['src/flow/compile/ivr.assert.ts', 'src/flow/model/model.assert.ts', 'src/flow/assist/assist.assert.ts'];

let failed = 0;
for (const suite of SUITES) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', suite], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed += 1;
    console.error(`✗ ${suite}`);
  }
}
process.exitCode = failed === 0 ? 0 : 1;
