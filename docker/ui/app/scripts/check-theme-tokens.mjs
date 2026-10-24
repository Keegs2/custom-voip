/**
 * Theme token checks (docker/ui/CLAUDE.md "Theming (light / dark)").
 * Plain Node, no dependencies. Run from docker/ui/app:
 *
 *   node scripts/check-theme-tokens.mjs
 *     Every name in src/styles/theme.ts THEME_TOKENS is defined in BOTH the
 *     light and the dark block of src/styles/theme.css, and neither block
 *     defines a token the TS list lacks. Exit 1 on any mismatch.
 *
 *   node scripts/check-theme-tokens.mjs --literals <file> [<file> …]
 *     Lists the colour literals (#hex incl. all-digit ones like #475569,
 *     rgb()/rgba(), hsl()/hsla()) still in the given CSS/TS/TSX files — the
 *     "convert a file" checklist's last step. Comments are stripped first
 *     (block comments everywhere, `//` line comments in TS/TSX), so prose
 *     such as "React #310" is ignored; `&#039;`-style HTML entities are
 *     ignored too. String contents ARE scanned. Exit 1 if any are found.
 *     A glob is not expanded for you — pass the files, e.g.
 *       node scripts/check-theme-tokens.mjs --literals $(git ls-files 'src/*.css' 'src/*.ts' 'src/*.tsx')
 */
import { readFileSync } from 'node:fs';

/**
 * Blanks out comments (keeping newlines, so line numbers hold). Block
 * comments everywhere; `//` line comments only in JS/TS (CSS has none, and
 * `url(//…)` must survive). Quote-aware so `'/*'` or `"//"` inside a string
 * is not a comment; '/" strings end at the newline (a stray quote in a regex
 * literal can't swallow the file), template literals may span lines.
 */
function stripComments(src, isScript) {
  let out = '';
  let i = 0;
  let quote = null; // ' " `
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === quote || (c === '\n' && quote !== '`')) quote = null;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const endAt = src.indexOf('*/', i + 2);
      const stop = endAt < 0 ? src.length : endAt + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (isScript && c === '/' && next === '/' && src[i - 1] !== ':') {
      const endAt = src.indexOf('\n', i);
      const stop = endAt < 0 ? src.length : endAt;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || (isScript && c === '`')) quote = c;
    out += c;
    i += 1;
  }
  return out;
}

const args = process.argv.slice(2);

if (args[0] === '--literals') {
  const files = args.slice(1);
  if (files.length === 0) {
    console.error('usage: node scripts/check-theme-tokens.mjs --literals <file> [<file> …]');
    process.exit(2);
  }
  const literal = /&?#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g;
  let total = 0;
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'), /\.(m?[jt]sx?)$/.test(file));
    code.split('\n').forEach((line, i) => {
      const hits = (line.match(literal) ?? []).filter((h) => !h.startsWith('&')); // &#039; entities
      if (hits.length) {
        total += hits.length;
        console.log(`${file}:${i + 1}: ${hits.join('  ')}`);
      }
    });
  }
  console.log(total ? `\n${total} colour literal(s) left.` : 'No colour literals.');
  process.exit(total ? 1 : 0);
}

const css = readFileSync('src/styles/theme.css', 'utf8');
const ts = readFileSync('src/styles/theme.ts', 'utf8');

const listStart = ts.indexOf('export const THEME_TOKENS = [');
const listEnd = ts.indexOf('] as const;', listStart);
const names = [...ts.slice(listStart, listEnd).matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);

// The two token blocks open on these marker comments (keep them).
const lightStart = css.indexOf('/* ─── LIGHT');
const darkStart = css.indexOf('/* ─── DARK');
const darkEnd = css.indexOf('/* ─── Theme switch', darkStart);
if (lightStart < 0 || darkStart < lightStart || darkEnd < darkStart) {
  console.error('theme.css layout changed — update scripts/check-theme-tokens.mjs');
  process.exit(2);
}
const defs = (block) => new Set([...block.matchAll(/^\s*--t-([a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
const light = defs(css.slice(lightStart, darkStart));
const dark = defs(css.slice(darkStart, darkEnd));

const problems = [];
const seen = new Set();
for (const n of names) {
  if (seen.has(n)) problems.push(`duplicate in THEME_TOKENS: ${n}`);
  seen.add(n);
  if (!light.has(n)) problems.push(`missing in LIGHT block: --t-${n}`);
  if (!dark.has(n)) problems.push(`missing in DARK block:  --t-${n}`);
}
for (const n of light) if (!seen.has(n)) problems.push(`LIGHT defines --t-${n}, not in THEME_TOKENS`);
for (const n of dark) if (!seen.has(n)) problems.push(`DARK defines --t-${n}, not in THEME_TOKENS`);

problems.forEach((p) => console.log(p));
console.log(`${names.length} tokens · light ${light.size} · dark ${dark.size} · ${problems.length} problem(s)`);
process.exit(problems.length ? 1 : 0);
