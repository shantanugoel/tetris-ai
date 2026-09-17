/**
 * Neon Tetris — API server (no dependencies, Node >= 18).
 *
 *   node server.js            # http://localhost:8787
 *
 * Serves the game *and* exposes it as a REST API so that an external agent —
 * an LLM, a RL loop, a script — can play the very same game the human sees.
 * The browser can also attach to a server game ("remote" mode), so an API
 * player's moves are rendered live with all the effects.
 *
 * Games are turn-based over HTTP: gravity does not run server-side, so a
 * client can think as long as it likes. Each accepted action is applied in
 * order; illegal actions are reported, never silently applied.
 *
 *   POST   /api/games                       create            {seed, level, difficulty}
 *   GET    /api/games                       list ids + summaries
 *   GET    /api/games/:id                   state             ?since=<eventCursor>
 *   POST   /api/games/:id/actions           play              {actions:[...]} | {action:'left'}
 *   GET    /api/games/:id/candidates        every legal landing spot, scored
 *   POST   /api/games/:id/hint              built-in AI's move   {difficulty}
 *   POST   /api/games/:id/auto              let the built-in AI play  {moves|until:'game_over'}
 *   GET    /api/games/:id/replay            seed + full action log
 *   DELETE /api/games/:id                   close
 *   GET    /api/docs                        protocol reference (for agents)
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game, COLS, VISIBLE_ROWS, MAX_LEVEL, QUEUE_PREVIEW, gravityMs } from './src/core.js';
import { plan, advise, DIFFICULTY, sequenceTo } from './src/ai.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT || process.argv[2] || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_GAMES = Number(process.env.MAX_GAMES || 64);
const MAX_ACTIONS = 2000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// ---------------------------------------------------------------- registry

/** @type {Map<string, {id:string, game:Game, events:any[], cursor:number, createdAt:number, difficulty:string, client:string|null}>} */
const games = new Map();
let seq = 0;

function createGame(body = {}) {
  const id = `g${(++seq).toString(36)}${Date.now().toString(36).slice(-4)}`;
  const seed = String(body.seed ?? Math.random().toString(36).slice(2, 10));
  const level = Math.max(1, Math.min(MAX_LEVEL, Number(body.level ?? 1) || 1));
  const game = new Game({ seed, startLevel: level, gravity: false });
  const meta = {
    id,
    game,
    events: [],
    cursor: 0,
    createdAt: Date.now(),
    difficulty: body.difficulty && DIFFICULTY[body.difficulty] ? body.difficulty : 'hard',
    client: body.client ? String(body.client).slice(0, 64) : null,
    level,
  };
  journal(meta, game.drainEvents()); // so a fresh watcher sees the first spawn
  games.set(id, meta);
  // evict the oldest finished game if we are full
  if (games.size > MAX_GAMES) {
    for (const [k, v] of games) {
      if (v.game.over) { games.delete(k); break; }
    }
    if (games.size > MAX_GAMES) games.delete(games.keys().next().value);
  }
  return meta;
}

/** Games tick without gravity, but the UI still wants a clock. */
function journal(meta, evts) {
  for (const ev of evts) {
    meta.events.push({ id: ++meta.cursor, ...ev });
    if (meta.events.length > 400) meta.events.splice(0, meta.events.length - 400);
  }
}

function view(meta, since = 0) {
  const { game } = meta;
  const state = game.state();
  return {
    id: meta.id,
    ...state,
    difficulty: meta.difficulty,
    client: meta.client,
    over: game.over,
    startedAt: meta.createdAt,
    eventCursor: meta.cursor,
    events: meta.events.filter((e) => e.id > since).slice(0, 60),
    api: {
      actions: ['left', 'right', 'rotate_cw', 'rotate_ccw', 'rotate_180', 'soft_drop', 'hard_drop', 'hold'],
      next: `GET /api/games/${meta.id}?since=${meta.cursor}`,
    },
  };
}

function summary(meta) {
  return {
    id: meta.id, score: meta.game.score, lines: meta.game.lines, level: meta.game.level,
    pieces: meta.game.stats.pieces, over: meta.game.over, client: meta.client,
    difficulty: meta.difficulty, ageMs: Date.now() - meta.createdAt,
  };
}

// ------------------------------------------------------------------- http

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function send(res, code, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  res.writeHead(code, { ...JSON_HEADERS, ...headers });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error('body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch {
    // tolerate text/plain bodies like "hard_drop" or "left right hard_drop"
    const t = text.trim();
    if (/^[a-z_ ]+$/.test(t)) return { actions: t.split(/\s+/) };
    throw new Error('invalid JSON body');
  }
}

const API_DOCS = `# Neon Tetris — AI API

Play the game over HTTP. Games are turn-based: **gravity does not run server-side**,
so you may take as long as you like between actions.

## Quick start
    ID=$(curl -s localhost:${PORT}/api/games -X POST -d '{"seed":"demo"}' | jq -r .id)
    curl -s "localhost:${PORT}/api/games/$ID"            # read the board
    curl -s "localhost:${PORT}/api/games/$ID/actions" -X POST -d '{"actions":["left","rotate_cw","hard_drop"]}'

## Reading state
\`GET /api/games/:id\` returns:

| field | meaning |
|---|---|
| \`ascii\` | the visible well, top→bottom, 10 cols. Letters = settled blocks, the active piece is overlaid with its own letter, \`.\` = empty |
| \`board\` | same as ascii but numeric (0 empty, 1=I 2=O 3=T 4=S 5=Z 6=J 7=L) |
| \`active\` | \`{name, rotation, col, row, ghostRow, cells}\` — col/row are the piece's bounding-box origin |
| \`queue\` | next ${QUEUE_PREVIEW} pieces |
| \`hold\`, \`canHold\` | hold slot contents and whether swapping is still allowed this piece |
| \`legalActions\` | actions accepted right now |
| \`score, lines, level, combo, backToBack, stats\` | scoring |
| \`events\` | animation events since \`?since=<cursor>\` (spawn/lock/clear/hard_drop/hold/game_over) |

## Acting
\`POST /api/games/:id/actions\` with \`{"actions":["left","hard_drop"]}\` (or \`{"action":"hold"}\`,
or a plain-text body of space-separated actions).
Action names: \`left right rotate_cw rotate_ccw rotate_180 soft_drop hard_drop hold\`.
Response lists \`applied\`, \`rejected\` (with the index and reason), the new state, and new events.
Actions after a game-over are rejected with reason \`over\`.

## Getting help from the built-in engine
* \`GET /api/games/:id/candidates\` — every reachable landing spot with a score, its
  resulting \`ascii\` board, \`linesCleared\`/\`label\`, and the exact \`actions\` list that
  gets the piece there (so you can choose a spot without computing the path yourself).
* \`POST /api/games/:id/hint\` \`{"difficulty":"insane"}\` — a full executable action list
  for the next piece (\`easy|normal|hard|insane\`).
* \`POST /api/games/:id/auto\` \`{"moves":10}\` or \`{"until":"game_over"}\` — let the built-in
  AI play, useful for benchmarking your own agent against it.

## Bring your own model
This endpoint is all a model needs. Two working agents ship in \`tools/\`:
* \`tools/jev-play.js\` — code enumerates and measures the placements, Jev answers typed
  questions about them (Choice / Score / Noul), code executes the answer.
* \`tools/llm-play.js\` — a chat model reads the \`ascii\` board and replies with JSON actions.

## Watching it happen
Open \`http://localhost:${PORT}/?game=<id>\` in a browser to render this exact game live,
including your own agent's moves.

## Notes
* Rotation follows SRS with wall kicks; \`col\` is a bounding-box origin and may be
  negative (that is legal — it is how wall kicks work).
* \`hard_drop\` locks the piece immediately; there is no lock delay over HTTP.
* Deterministic: the same \`seed\` + the same action list always produces the same game.
  \`GET /api/games/:id/replay\` gives you the transcript.
`;

async function serveStatic(req, res, urlPath) {
  let rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  if (rel === '' || rel === '.') rel = 'index.html';
  const abs = join(ROOT, rel);
  if (!abs.startsWith(ROOT)) return send(res, 403, 'forbidden');
  try {
    const info = await stat(abs);
    if (info.isDirectory()) return serveStatic(req, res, `${urlPath.replace(/\/$/, '')}/index.html`);
    const body = await readFile(abs);
    res.writeHead(200, {
      'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    send(res, 404, 'not found');
  }
}

function parseSince(url) {
  const v = Number(url.searchParams.get('since'));
  return Number.isFinite(v) ? v : 0;
}

async function routeApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const seg = parts.slice(1);
  const method = req.method.toUpperCase();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-max-age': '600',
    });
    return res.end();
  }
  const cors = { 'access-control-allow-origin': '*' };

  if (method === 'GET' && (seg.join('/') === 'health' || seg.length === 0)) {
    return send(res, 200, {
      ok: true, name: 'neon-tetris', version: '1.0.0',
      games: games.size, engine: 'SRS + wall kicks + T-spins + B2B + combos',
      docs: '/api/docs',
    }, cors);
  }

  if (method === 'GET' && seg[0] === 'docs') return send(res, 200, API_DOCS, { ...cors, 'content-type': 'text/markdown; charset=utf-8' });

  if (seg[0] === 'games') {
    if (seg.length === 1 && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const meta = createGame(body);
      return send(res, 201, { id: meta.id, ...view(meta, 0) }, cors);
    }
    if (seg.length === 1 && method === 'GET') {
      return send(res, 200, { games: [...games.values()].map(summary) }, cors);
    }

    const meta = games.get(seg[1]);
    if (!meta) return send(res, 404, { error: 'no such game', hint: 'POST /api/games first' }, cors);

    if (seg.length === 2) {
      if (method === 'DELETE') { games.delete(meta.id); return send(res, 200, { closed: meta.id }, cors); }
      if (method === 'GET') return send(res, 200, view(meta, parseSince(url)), cors);
    }

    if (seg.length === 3 && seg[2] === 'actions' && method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }, cors); }
      const list = Array.isArray(body.actions) ? body.actions : body.action ? [body.action] : [];
      if (!list.length) return send(res, 400, { error: 'provide {"actions":[...]} or {"action":"..."}' }, cors);
      if (list.length > MAX_ACTIONS) return send(res, 400, { error: `too many actions (max ${MAX_ACTIONS})` }, cors);

      const eventsFromHere = meta.cursor; // default: only events this call produced
      const applied = []; const rejected = [];
      for (let i = 0; i < list.length; i++) {
        const a = String(list[i]);
        if (meta.game.over) { rejected.push({ index: i, action: a, reason: 'over' }); continue; }
        if (!meta.game.apply(a)) rejected.push({ index: i, action: a, reason: 'illegal' });
        else applied.push(a);
      }
      journal(meta, meta.game.drainEvents());
      const since = url.searchParams.has('since') ? parseSince(url) : eventsFromHere;
      return send(res, 200, { applied, rejected: rejected.length ? rejected : undefined, ...view(meta, since) }, cors);
    }

    if (seg.length === 3 && seg[2] === 'candidates' && method === 'GET') {
      const placements = meta.game.placements();
      // Each candidate carries `actions`: the shortest legal action list that
      // parks the piece there and locks it. An agent can therefore execute a
      // placement it picked, without re-deriving the path (and getting the SRS
      // wall kicks wrong while doing it).
      const ranked = placements
        .map((p) => ({ ...p, actions: sequenceTo(meta.game, p) ?? ['hard_drop'] }))
        .sort((a, b) => b.scoreGain - a.scoreGain || a.maxHeight - b.maxHeight);
      return send(res, 200, {
        piece: meta.game.active?.name ?? null,
        hold: meta.game.hold,
        candidates: ranked,
        hint: advise(meta.game, { difficulty: meta.difficulty }),
      }, cors);
    }

    if (seg.length === 3 && seg[2] === 'hint' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const difficulty = body.difficulty && DIFFICULTY[body.difficulty] ? body.difficulty : meta.difficulty;
      const p = plan(meta.game, { difficulty });
      if (!p) return send(res, 409, { error: 'game over' }, cors);
      return send(res, 200, { difficulty, actions: p.actions, decision: { piece: p.piece, col: p.col, rotation: p.rotation, useHold: p.useHold, linesCleared: p.linesCleared, label: p.label }, ranked: p.ranked }, cors);
    }

    if (seg.length === 3 && seg[2] === 'auto' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const difficulty = body.difficulty && DIFFICULTY[body.difficulty] ? body.difficulty : meta.difficulty;
      // Bound the work: the strongest engine is effectively immortal, so
      // `until: game_over` must still return promptly and say why it stopped.
      const untilOver = body.until === 'game_over';
      const maxPieces = untilOver
        ? Math.max(1, Math.min(4000, Number(body.maxPieces ?? 1200) || 1200))
        : Math.max(1, Math.min(500, Number(body.moves ?? 1) || 1));
      const budgetMs = Math.max(100, Math.min(20000, Number(body.budgetMs ?? 5000) || 5000));
      const deadline = Date.now() + budgetMs;
      let done = 0;
      let stoppedBy = 'moves';
      while (!meta.game.over && done < maxPieces) {
        const p = plan(meta.game, { difficulty });
        if (!p) { stoppedBy = 'no_moves'; break; }
        for (const a of p.actions) meta.game.apply(a);
        done++;
        if (Date.now() > deadline) { stoppedBy = 'budget'; break; }
      }
      if (meta.game.over) stoppedBy = 'game_over';
      journal(meta, meta.game.drainEvents());
      return send(res, 200, { piecesPlayed: done, stoppedBy, difficulty, budgetMs, ...view(meta, parseSince(url)) }, cors);
    }

    if (seg.length === 3 && seg[2] === 'replay' && method === 'GET') {
      return send(res, 200, {
        id: meta.id, seed: meta.game.seed, startLevel: meta.level,
        score: meta.game.score, lines: meta.game.lines, pieces: meta.game.stats.pieces,
        over: meta.game.over, overReason: meta.game.overReason,
        actions: meta.game.history, stats: meta.game.stats,
      }, cors);
    }
  }

  return send(res, 404, { error: 'unknown endpoint', docs: '/api/docs' }, cors);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api')) await routeApi(req, res, url);
    else await serveStatic(req, res, url.pathname);
  } catch (err) {
    send(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ◤ NEON TETRIS ◢`);
  console.log(`  game     http://${HOST}:${PORT}/`);
  console.log(`  live AI  http://${HOST}:${PORT}/?auto=1`);
  console.log(`  api docs http://${HOST}:${PORT}/api/docs`);
  console.log(`  engine   ${COLS}x${VISIBLE_ROWS} visible · gravity ${gravityMs(1)}ms @ level 1\n`);
});
