/**
 * Minimal .env loader for the CLI tools — no dependencies.
 *
 * Reads KEY=value lines from a .env in the cwd (or the repo root when run from
 * elsewhere) without overriding variables that are already in the real
 * environment. Real env always wins, so CI secrets beat a stray local file.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv(filename = '.env') {
  const loaded = {};
  for (const dir of new Set([process.cwd(), REPO_ROOT])) {
    let text;
    try { text = readFileSync(join(dir, filename), 'utf8'); } catch { continue; }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, '').trim(); // strip trailing comment
      }
      if (value && process.env[key] === undefined) { loaded[key] = value; process.env[key] = value; }
    }
    break; // first .env found wins
  }
  return loaded;
}

/**
 * Small argv parser shared by the CLI tools: `--flag value`, `--key=value`,
 * `--boolean-flag`, positionals. `spec` = { values: [...], booleans: [...], near: {} }.
 *
 * An unknown flag is an error, not a shrug. Silently ignoring `--min-confidence 0`
 * on a tool that has no confidence gate is the most expensive kind of typo in a
 * benchmark harness: it looks like it worked and quietly changes what you measured.
 */
export function parseArgs(argv, spec = {}) {
  const values = new Set(spec.values ?? []);
  const booleans = new Set(spec.booleans ?? []);
  const near = spec.near ?? {};
  const flags = {};
  const rest = [];
  const unknown = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) { rest.push(tok); continue; }
    const eq = tok.indexOf('=');
    const key = eq > 1 ? tok.slice(2, eq) : tok.slice(2);
    if (!values.has(key) && !booleans.has(key)) { unknown.push(tok); continue; }
    if (booleans.has(key)) {
      flags[key] = eq > 1 ? !['0', 'false', 'no', ''].includes(tok.slice(eq + 1).toLowerCase()) : true;
      continue;
    }
    const val = eq > 1 ? tok.slice(eq + 1) : argv[++i];
    if (val === undefined || val.startsWith('--')) throw new Error(`--${key} needs a value`);
    flags[key] = val;
  }

  if (unknown.length) {
    const known = [...values, ...booleans].sort();
    const lines = [`unknown flag ${unknown.join(', ')}`];
    for (const u of unknown) {
      const bare = u.replace(/^--/, '').split('=')[0];
      if (near[bare]) lines.push(`  --${bare} belongs to tools/${near[bare]}.js — this tool has no such gate`);
      else {
        const close = known.map((k) => [k, distance(bare, k)]).filter(([, d]) => d <= 3).sort((a, b) => a[1] - b[1])[0];
        if (close) lines.push(`  did you mean --${close[0]}?`);
      }
    }
    lines.push(`  accepted: ${known.map((k) => `--${k}`).join(' ')}`);
    throw new Error(lines.join('\n'));
  }
  return { flags, rest };
}

function distance(a, b) {
  const m = [...a]; const n = [...b];
  let prev = Array.from({ length: n.length + 1 }, (_, j) => j);
  for (let i = 1; i <= m.length; i++) {
    const cur = [i];
    for (let j = 1; j <= n.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (m[i - 1] === n[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n.length];
}
