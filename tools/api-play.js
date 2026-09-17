#!/usr/bin/env node
/**
 * api-play — terminal client for the Neon Tetris AI API.
 *
 *   node tools/api-play.js new [--seed x] [--difficulty insane] [--level 3]
 *   node tools/api-play.js board <id>            render the well + stats
 *   node tools/api-play.js play  <id> left left rotate_cw hard_drop
 *   node tools/api-play.js hint  <id> [difficulty]
 *   node tools/api-play.js auto  <id> [pieces]
 *   node tools/api-play.js close <id>
 *   node tools/api-play.js ls
 *
 * Also usable as a module: `import { ApiClient } from './api-play.js'`.
 */
import { pathToFileURL } from 'node:url';
import { loadEnv } from './env.js';

loadEnv();
const BASE = process.env.TETRIS_URL ?? 'http://127.0.0.1:8787';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  I: '\x1b[96m', O: '\x1b[93m', T: '\x1b[95m', S: '\x1b[92m', Z: '\x1b[91m', J: '\x1b[94m', L: '\x1b[38;5;208m',
};

export class ApiClient {
  constructor(base = BASE) { this.base = base ?? BASE; }
  async req(method, path, body) {
    const r = await fetch(this.base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${r.status} ${j.error ?? r.statusText}`);
    return j;
  }
  health() { return this.req('GET', '/api/health'); }
  create(opts = {}) { return this.req('POST', '/api/games', opts); }
  state(id, since = 0) { return this.req('GET', `/api/games/${id}?since=${since}`); }
  async actions(id, actions, since) {
    const cursor = since ?? (await this.state(id)).eventCursor;
    return this.req('POST', `/api/games/${id}/actions?since=${cursor}`, { actions });
  }
  hint(id, difficulty) { return this.req('POST', `/api/games/${id}/hint`, difficulty ? { difficulty } : {}); }
  auto(id, moves) { return this.req('POST', `/api/games/${id}/auto`, typeof moves === 'number' ? { moves } : { until: 'game_over' }); }
  candidates(id) { return this.req('GET', `/api/games/${id}/candidates`); }
  replay(id) { return this.req('GET', `/api/games/${id}/replay`); }
  close(id) { return this.req('DELETE', `/api/games/${id}`); }
  list() { return this.req('GET', '/api/games'); }
}

const CH_BLOCK = process.platform === 'darwin' ? '▪' : '#';

function drawBoard(s, limit, flags = {}) {
  let rows = s.ascii.split('\n');
  let offset = 0;
  if (limit && limit < rows.length) { offset = rows.length - limit; rows = rows.slice(offset); }
  const out = [`    ${C.dim}0123456789${C.reset}`];
  rows.forEach((r, i) => {
    // one character per cell, so the column ruler stays truthful
    const line = [...r].map((ch) => (ch === '.' ? `${C.dim}·${C.reset}` : `${C[ch] ?? ''}${C.bold}${CH_BLOCK}${C.reset}`)).join('');
    out.push(`${String(i + offset).padStart(3)} ${line}  ${flags.raw === true ? r : ''}`);
  });
  return out.join('\n');
}

function summarize(s) {
  const a = s.active;
  return [
    `${C.bold}score${C.reset} ${String(s.score).padStart(9)}   ${C.bold}lines${C.reset} ${String(s.lines).padStart(4)}   `
      + `${C.bold}level${C.reset} ${String(s.level).padStart(3)}   ${C.bold}pieces${C.reset} ${String(s.pieces).padStart(4)}`,
    `${C.bold}combo${C.reset} ${s.combo > 0 ? `${s.combo}x` : '—'}   ${C.bold}b2b${C.reset} ${s.backToBack || '—'}   `
      + `${C.bold}hold${C.reset} ${s.hold ?? '—'}${s.canHold ? '' : ' (used)'}   ${C.bold}queue${C.reset} ${s.queue.join(' ')}`,
    a
      ? `${C.bold}active${C.reset} ${a.name} rot=${a.rotation} col=${a.col} row=${a.row - 4}→${a.ghostRow - 4} (visible)`
        + `   ${C.dim}legal: ${s.legalActions.join(' ')}${C.reset}`
      : `${C.bold}active${C.reset} —`,
    s.over ? `\n${C.bold}${C.Z}GAME OVER${C.reset} (${s.overReason})` : '',
  ].join('\n');
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { flags[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true; }
    else rest.push(args[i]);
  }
  const api = new ApiClient(flags.url);

  switch (cmd) {
    case 'health': {
      const h = await api.health();
      console.log(JSON.stringify(h));
      break;
    }
    case 'new': {
      const g = await api.create({
        seed: flags.seed, difficulty: flags.difficulty, level: flags.level ? Number(flags.level) : undefined,
        client: flags.client ?? 'api-play',
      });
      console.log(g.id);
      if (flags.quiet !== true) console.error(`\nwatch it live:  ${BASE}/?game=${g.id}\n`);
      break;
    }
    case 'ls': {
      const { games } = await api.list();
      for (const g of games) console.log(`${g.id.padEnd(9)} score=${String(g.score).padStart(8)} lines=${String(g.lines).padStart(4)} lvl=${String(g.level).padStart(2)} ${g.over ? 'over' : 'live '} ${g.client ?? ''}`);
      if (!games.length) console.log('(no games)');
      break;
    }
    case 'board': {
      const s = await api.state(rest[0], flags.since ? Number(flags.since) : 0);
      console.log(summarize(s));
      console.log();
      console.log(drawBoard(s, flags.rows ? Number(flags.rows) : 0, flags));
      if (s.events?.length) console.log(`\n${C.dim}events: ${s.events.map((e) => e.type + (e.label ? `(${e.label})` : '')).join(', ')}${C.reset}`);
      break;
    }
    case 'play': {
      const id = rest[0];
      const acts = rest.slice(1);
      const r = await api.actions(id, acts);
      console.log(`${C.dim}applied: ${r.applied.join(' ')}${r.rejected ? `${C.reset}\n${C.Z}rejected: ${JSON.stringify(r.rejected)}` : ''}${C.reset}`);
      for (const ev of r.events ?? []) {
        if (ev.type === 'clear') console.log(`${C.bold}${C.gr ?? ''}✔ ${ev.label} +${ev.gained}${C.reset}`);
        else if (ev.type === 'level_up') console.log(`${C.bold}▲ level ${ev.level}${C.reset}`);
        else if (ev.type === 'game_over') console.log(`${C.bold}${C.Z}✖ game over (${ev.reason})${C.reset}`);
      }
      if (flags.board === true || flags.b === true) {
        const s = await api.state(id);
        console.log();
        console.log(summarize(s));
        console.log();
        console.log(drawBoard(s, flags.rows ? Number(flags.rows) : 0, flags));
      }
      break;
    }
    case 'hint': {
      const h = await api.hint(rest[0], rest[1]);
      console.log(`${C.bold}${h.actions.join(' ')}${C.reset}`);
      console.log(`${C.dim}${JSON.stringify(h.decision)}${C.reset}`);
      break;
    }
    case 'candidates': {
      const c = await api.candidates(rest[0]);
      for (const p of c.candidates.slice(0, Number(flags.limit ?? 10))) {
        console.log(`col ${String(p.col).padStart(2)} rot ${p.rotation}  gain ${String(p.scoreGain).padStart(5)}  clears ${p.linesCleared} ${p.label ?? ''}  maxH ${p.maxHeight} ${p.over ? 'OVER' : ''}`);
      }
      break;
    }
    case 'auto': {
      const moves = rest[1] === 'all' ? 'all' : Number(rest[1] ?? 10);
      const r = await api.auto(rest[0], moves === 'all' ? 'all' : moves);
      console.log(`${C.dim}pieces played: ${r.piecesPlayed}${C.reset}`);
      console.log();
      console.log(summarize(r));
      console.log();
      console.log(drawBoard(r, flags.rows ? Number(flags.rows) : 0, flags));
      break;
    }
    case 'replay': {
      const r = await api.replay(rest[0]);
      console.log(JSON.stringify({ seed: r.seed, score: r.score, lines: r.lines, pieces: r.pieces, stats: r.stats }, null, 2));
      console.log(`\n${r.actions.join(' ')}`);
      break;
    }
    case 'close':
      console.log(JSON.stringify(await api.close(rest[0])));
      break;
    default:
      console.log(`api-play — Neon Tetris API client

  new     [--seed s] [--difficulty easy|normal|hard|insane] [--level n]
  board   <id> [--since n] [--rows n]
  play    <id> <action> [...actions]        [--board] [--rows n]
  hint    <id> [difficulty]
  auto    <id> [pieces|all]
  cand    <id> [--limit n]
  replay  <id>
  ls | health | close <id> |  [--url http://host:port]`);
  }
}

// only run the CLI when executed directly, so importing ApiClient stays clean
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
}
