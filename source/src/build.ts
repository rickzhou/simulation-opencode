#!/usr/bin/env tsx
/**
 * Rebuild the AI-bubble-bust dashboard.
 *
 * Runs simulate.ts to refresh the data, optionally runs fetchNews.ts for
 * current-situation data, then injects everything into dashboard_template.html
 * and writes the deployed HTML one folder up.
 *
 * Faithful TypeScript port of build.py.
 *
 * Usage (from the source/ folder):
 *   npm run build               # rebuild (runs simulate.ts)
 *   npm run build -- --news     # also fetch live news
 *   npm run build -- --skip-sim # skip simulate (use existing sim_data.json)
 *   npm run build -- --skip-sim --news
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));      // source/src
const SRC = join(HERE, '..');                              // source/
const OUT = join(HERE, '..', '..', 'AI-bubble-bust-simulation.html');
const TSX = join(SRC, 'node_modules', '.bin', 'tsx');
const SIM_DATA = join(SRC, 'sim_data.json');

const argv = process.argv.slice(2);
const skipSim = argv.includes('--skip-sim');
const wantNews = argv.includes('--news');

function run(args: string[], opts: { capture?: boolean } = {}): { code: number } {
  const res = spawnSync(TSX, args, {
    cwd: SRC,
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return { code: res.status ?? 1 };
}

if (!skipSim) {
  console.log('[1/3] running simulate.ts ...');
  const { code } = run([join('src', 'simulate.ts'), SIM_DATA]);
  if (code !== 0) { console.error('simulate.ts failed'); process.exit(code); }
} else {
  console.log('[1/3] skipping simulate.ts (--skip-sim)');
}

let newsData = 'null';
if (wantNews) {
  console.log('[2/3] running fetchNews.ts ...');
  run([join('src', 'fetchNews.ts'), '--stdout'], { capture: true });
} else {
  console.log('[2/3] skipping fetchNews.ts (use --news to fetch)');
}

const csPath = join(SRC, 'current_situation.json');
if (existsSync(csPath)) {
  newsData = readFileSync(csPath, 'utf8');
  console.log(`  loaded current_situation.json (${newsData.length} bytes)`);
} else {
  console.log('  no current_situation.json found');
}

console.log('[3/3] injecting data into dashboard_template.html ...');
const data = readFileSync(SIM_DATA, 'utf8');
const tpl = readFileSync(join(SRC, 'dashboard_template.html'), 'utf8');
let html = tpl.replace('/*__SIM_DATA__*/', () => data);
html = html.replace('/*__CURRENT_SITUATION__*/', () => newsData);
writeFileSync(OUT, html);
console.log(`written: ${OUT}  (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
