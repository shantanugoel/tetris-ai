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
