/**
 * REST API contract tests: `node test/api.test.js`
 * Boots the real server on an ephemeral port and drives it exactly like an
 * external AI player would.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Game } from '../src/core.js';
import { advise } from '../src/ai.js';

const PORT = 8931 + Math.floor(Math.random() * 60);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = '') => c ? pass++ : (fail++, failures.push(`${n}${d ? ' — ' + d : ''}`));

const srv = spawn(process.execPath, ['server.js', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
srv.stdout.on('data', (d) => { out += d; });
srv.stderr.on('data', (d) => { out += d; });

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const jget = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json() }; };
const jpost = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json() };
};

if (!await waitUp()) {
  console.log('\n  api: server never came up\n' + out);
  process.exit(1);
}

// health + docs
{
  const h = await jget('/api/health');
  ok('health ok', h.status === 200 && h.body.ok === true);
  const d = await fetch(`${BASE}/api/docs`);
  const text = await d.text();
  ok('agent docs served as markdown', d.ok && text.includes('POST /api/games') && text.includes('ascii'));
}

// create + inspect
let id;
{
  const c = await jpost('/api/games', { seed: 'apitest', client: 'jest', difficulty: 'hard' });
  id = c.body.id;
  ok('create returns an id', c.status === 201 && !!id);
  ok('create returns playable state', Array.isArray(c.body.board) && c.body.board.length === 24 && !!c.body.active);
  ok('ascii is 20 visible rows of 10', c.body.ascii.split('\n').length === 20 && c.body.ascii.split('\n')[0].length === 10);
  ok('board is 10 columns wide', c.body.board[0].length === 10);
  ok('queue preview is 5', c.body.queue.length === 5);
  ok('legal actions listed', c.body.legalActions.includes('hard_drop'));
  ok('spawn event journaled', c.body.events.some((e) => e.type === 'spawn'));
  ok('next poll cursor provided', c.body.api?.next?.includes('since='));
}

// actions: legal, illegal, and event windowing
{
  const before = (await jget(`/api/games/${id}`)).body.eventCursor;
  const r = await jpost(`/api/games/${id}/actions`, { actions: ['left', 'left', 'rotate_cw', 'hard_drop', 'teleport', 'hard_drop'] });
  ok('legal actions applied', r.body.applied.length >= 3, JSON.stringify(r.body.applied));
  ok('illegal action reported, not applied', r.body.rejected?.some((x) => x.action === 'teleport' && x.reason === 'illegal'));
  ok('POST returns only events it produced', r.body.events.every((e) => e.id > before) && r.body.events.length > 0,
    `before=${before} got=${r.body.events.map((e) => e.id).join(',')}`);
  ok('events are ordered by id', r.body.events.every((e, i, a) => i === 0 || e.id > a[i - 1].id));
  ok('action count tracked', r.body.actions >= 4, `actions=${r.body.actions}`);
  ok('replay transcript records only applied actions', (await jget(`/api/games/${id}/replay`)).body.actions.every((a) => a !== 'teleport'));
}

// single-action shorthand + plain-text body
{
  const r = await jpost(`/api/games/${id}/actions`, { action: 'hold' });
  ok('{"action":"hold"} shorthand works', r.body.applied[0] === 'hold');
  const raw = await fetch(`${BASE}/api/games/${id}/actions`, { method: 'POST', body: 'left hard_drop' });
  const body = await raw.json();
  ok('plain-text action body works', raw.ok && body.applied.join(' ') === 'left hard_drop', JSON.stringify(body.applied ?? body.error));
}

// candidates + hint
{
  const c = await jget(`/api/games/${id}/candidates`);
  ok('candidates enumerated with boards', c.body.candidates.length > 8 && typeof c.body.candidates[0].ascii === 'string');
  ok('candidates are all reachable landings', c.body.candidates.every((p) => Number.isInteger(p.col) && Number.isInteger(p.rotation)));
  const h = await jpost(`/api/games/${id}/hint`, { difficulty: 'insane' });
  ok('hint returns an executable action list', Array.isArray(h.body.actions) && h.body.actions.at(-1) === 'hard_drop');
  const bad = await jpost(`/api/games/${id}/hint`, { difficulty: 'impossible-mode' });
  ok('bad difficulty falls back instead of 500', bad.status === 200);
}

// the hint must actually be playable verbatim
{
  const c = await jpost('/api/games', { seed: 'verbatim' });
  const cid = c.body.id;
  let mismatch = 0, games = 0;
  for (let piece = 0; piece < 12; piece++) {
    const h = await jpost(`/api/games/${cid}/hint`, { difficulty: 'hard' });
    const st0 = await jget(`/api/games/${cid}`);
    if (st0.body.over) break;
    const r = await jpost(`/api/games/${cid}/actions`, { actions: h.body.actions });
    games++;
    if (r.body.rejected) mismatch++;
  }
  ok('every hint executed verbatim (no rejected actions)', mismatch === 0, `${mismatch}/${games}`);
}

// auto play + over semantics
{
  const c = await jpost('/api/games', { seed: 'auto', difficulty: 'hard' });
  const aid = c.body.id;
  const t0 = Date.now();
  const r = await jpost(`/api/games/${aid}/auto`, { moves: 30 });
  ok('auto plays requested pieces', r.body.piecesPlayed === 30, `played ${r.body.piecesPlayed}`);
  ok('auto cleared lines', r.body.lines > 0, `lines ${r.body.lines}`);
  const r2 = await jpost(`/api/games/${aid}/auto`, { until: 'game_over', budgetMs: 1500 });
  ok('auto until game_over stops and reports why', ['game_over', 'budget'].includes(r2.body.stoppedBy), r2.body.stoppedBy);
  ok('auto respects its time budget', r2.body.piecesPlayed > 0 && Date.now() - t0 < 12000, `${r2.body.piecesPlayed} pieces`);
  ok('score survives to the replay endpoint', (await jget(`/api/games/${aid}/replay`)).body.score > 0);
}

// forcing a real game over: stack one column until it tops out
{
  const c = await jpost('/api/games', { seed: 'topout' });
  const tid = c.body.id;
  const spam = await jpost(`/api/games/${tid}/actions`, { actions: Array.from({ length: 300 }, () => 'hard_drop') });
  ok('repeated hard drops top the game out', spam.body.over === true, `over=${spam.body.over}`);
  ok('game_over event emitted', spam.body.events.some((e) => e.type === 'game_over'));
  const after = await jpost(`/api/games/${tid}/actions`, { actions: ['left', 'hard_drop'] });
  ok('actions after game over are rejected with reason "over"',
    after.body.applied.length === 0 && after.body.rejected.every((x) => x.reason === 'over'));
}

// determinism across the wire
{
  const play = async (seed) => {
    const { body } = await jpost('/api/games', { seed, difficulty: 'hard' });
    const g = new Game({ seed, gravity: false });
    let acts = [];
    for (let i = 0; i < 15 && !g.over; i++) {
      const a = advise(g, { difficulty: 'hard' });
      for (const x of a) g.apply(x);
      acts = acts.concat(a);
    }
    const r = await jpost(`/api/games/${body.id}/actions`, { actions: acts });
    return { api: r.body.score, local: g.score, lines: r.body.lines, apiLines: g.lines };
  };
  const [x, y] = [await play('mirror'), await play('mirror')];
  ok('same seed + same actions => same score over HTTP', x.api === y.api, `${x.api} vs ${y.api}`);
  ok('server engine agrees with the in-process engine', x.api === x.local && x.lines === x.apiLines,
    `http=${x.api} local=${x.local} lines=${x.lines}/${x.apiLines}`);
}

// lifecycle + errors
{
  const gone = await jget('/api/games/nope');
  ok('unknown game is 404 with a hint', gone.status === 404 && /POST \/api\/games/.test(gone.body.hint ?? ''));
  const noEndpoint = await jget('/api/nonsense');
  ok('unknown endpoint is 404', noEndpoint.status === 404);
  const empty = await jpost(`/api/games/${id}/actions`, {});
  ok('empty action list is a 400', empty.status === 400);
  const listed = await jget('/api/games');
  ok('games are listable', listed.body.games.some((g) => g.id === id));
  const del = await fetch(`${BASE}/api/games/${id}`, { method: 'DELETE' });
  ok('game can be closed', del.ok);
  ok('closed game is gone', (await jget(`/api/games/${id}`)).status === 404);
  const cors = await fetch(`${BASE}/api/health`);
  ok('CORS header present for browser agents', cors.headers.get('access-control-allow-origin') === '*');
}

srv.kill('SIGTERM');
console.log(`\n  api: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log('   ✗ ' + f);
process.exitCode = fail ? 1 : 0;
