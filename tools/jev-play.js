#!/usr/bin/env node
/**
 * jev-play — play Neon Tetris with Jev (TypeSafe AI) making the decisions.
 *
 *   node server.js &                      # the game + its REST API
 *   node tools/jev-play.js --seed demo     # Jev plays, ~1 call per piece
 *   open "http://localhost:8787/?game=<id>"   # watch the model play, live
 *
 * Division of labour — this IS the design:
 *   code  enumerates the legal landings, measures the resulting stack (height,
 *         holes, bumpiness, well depth), validates the answer, executes it.
 *   Jev   answers the narrow judgments code cannot phrase: which landing to
 *         take (Choice), how close the stack is to topping out (Score), whether
 *         to hold (Noul) — all in ONE round trip per piece.
 * Jev does not generate, count, or search, so we never ask it to. Nothing it
 * returns is trusted unchecked: an unknown option, a low-confidence answer, or
 * a landing that ends the game all fall back to the built-in engine.
 *
 * Zero dependencies: one POST to /v1/systemone, one to the game API.
 *
 * Flags:
 *   --seed s --level n --pieces N --until over --difficulty hard
 *   --min-confidence .3     use Jev's pick above this confidence
 *   --danger-confidence .55 ...and above this once the stack is dangerous
 *   --danger-at 2           Score level at which the stack counts as dangerous
 *   --hold-threshold .6     Noul probability required to spend the hold
 *   --model jev-latest      pin jev-1.13.0 if you tune the thresholds
 *   --url http://host:port --delay ms --quiet --dry-run --no-engine-fallback
 */

import { pathToFileURL } from 'node:url';
import { loadEnv } from './env.js';
import { ApiClient } from './api-play.js';

loadEnv();

const JEV_URL = process.env.JEV_URL ?? 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = process.env.JEV_MODEL ?? 'jev-latest';
const INPUT_USD_PER_MTOK = 0.042; // TypeSafe bills input only; output is free

const RISK_LEVELS = [
  'Empty or nearly empty: plenty of room to place anything',
  'Low stack: comfortable, a few bad pieces are absorbable',
  'Getting high: a bad piece or two now would start to hurt',
  'Critical: one more wrong placement loses the game',
];

// ------------------------------------------------------------------ measuring

/** Numeric 24-row grid (server `board`) -> 20 visible rows of '.' / '#'. */
export function visibleRows(board) {
  return board.slice(-20).map((r) => r.map((v) => (v ? '#' : '.')).join(''));
}

/**
 * Stack measurements, computed in code because Jev is explicitly not a
 * calculator. `rows` are top->bottom, so a column's height is how far the
 * first filled cell sits above the floor.
 */
export function stackStats(rows) {
  const H = rows.length;
  const W = rows[0] ? rows[0].length : 0;
  const heights = new Array(W).fill(0);
  let holes = 0;
  for (let x = 0; x < W; x++) {
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < H; y++) if (rows[y][x] !== '.') { if (top < 0) top = y; bottom = y; }
    if (top < 0) continue;
    heights[x] = H - top;
    for (let y = top + 1; y < bottom; y++) if (rows[y][x] === '.') holes++;
  }
  let bumpiness = 0;
  for (let x = 1; x < W; x++) bumpiness += Math.abs(heights[x] - heights[x - 1]);
  let wellDepth = 0;
  let wellCol = -1;
  for (let x = 0; x < W; x++) {
    // An edge column only has one neighbour, and the wall of an edge well *is*
    // that neighbour — edge wells are the ones you actually want to keep open.
    const neighbours = [];
    if (x > 0) neighbours.push(heights[x - 1]);
    if (x < W - 1) neighbours.push(heights[x + 1]);
    const wall = neighbours.length ? Math.min(...neighbours) : 0;
    if (wall - heights[x] > wellDepth) { wellDepth = wall - heights[x]; wellCol = x; }
  }
  return {
    heights, holes, bumpiness, wellDepth, wellCol,
    maxHeight: Math.max(0, ...heights),
    aggHeight: heights.reduce((a, b) => a + b, 0),
  };
}

/** One factual line per landing. No adjectives — Jev reads it literally. */
export function describeOption(before, cand) {
  const after = stackStats(cand.ascii.split('\n'));
  const delta = (key, label) => (after[key] === before[key]
    ? `${label} ${after[key]}`
    : `${label} ${after[key]} (was ${before[key]})`);
  const parts = [
    `column ${cand.col}, rotation ${cand.rotation}`,
    cand.linesCleared
      ? `clears ${cand.linesCleared} line${cand.linesCleared > 1 ? 's' : ''}${cand.label ? ` (${cand.label})` : ''}`
      : 'clears no lines',
    delta('maxHeight', 'stack height'),
    delta('holes', 'holes'),
    delta('bumpiness', 'bumpiness'),
  ];
  if (after.wellDepth >= 2) parts.push(`leaves an open well at column ${after.wellCol}, depth ${after.wellDepth}`);
  if (cand.over) parts.push('fills the spawn area and ends the game');
  return parts.join('; ');
}

// ------------------------------------------------------------------- asking

/**
 * Neutral option order: column, then rotation. The API returns candidates ranked
 * by the built-in engine, and we do not want that ranking leaking in as position
 * bias (or the first option looking like the recommended one). Both
 * buildRequest() and the caller's `legal` list run through here, so an option id
 * like "c7" means the same landing on both sides of the round trip.
 */
export function orderCandidates(candidates) {
  return [...candidates].sort((x, y) => x.col - y.col || x.rotation - y.rotation);
}

/**
 * One request, three questions. Adding the Score and the Noul costs tokens but
 * almost no latency, so they are asked every piece whether or not they end up
 * mattering (speculative fan-out).
 */
export function buildRequest(state, candidates, opts = {}) {
  const before = stackStats(visibleRows(state.board));
  const a = state.active;
  const criteria = {};
  const ordered = orderCandidates(candidates);
  ordered.forEach((c, i) => { criteria[`c${i}`] = describeOption(before, c); });

  const questions = {
    move: {
      type: 'choice',
      instructions: 'Which landing spot should the active piece take? A good landing keeps the stack low, avoids covered holes, keeps one deep open well for clearing lines, and clears lines when it can do so without raising the stack.',
      criteria,
    },
    risk: {
      type: 'score',
      instructions: 'How close is this well to becoming unplayable?',
      criteria: RISK_LEVELS,
    },
  };

  if (state.canHold && state.hold) {
    questions.hold = {
      type: 'noul',
      instructions: `Playing the held ${state.hold} piece as the next piece is better than playing the active ${a.name} piece as the next piece`,
      criteria: {
        true: `the ${state.hold} piece fits the open well or clears lines while the ${a.name} piece would only add height`,
        false: `the active ${a.name} piece has a landing that keeps the stack playable`,
      },
    };
  }

  return {
    model: opts.model ?? DEFAULT_MODEL,
    state: {
      game: 'Tetris. The well is 10 columns wide (column 0 is leftmost, column 9 rightmost) and 20 rows tall; the floor is under the last row.',
      board: visibleRows(state.board).join('\n'),
      legend: "'.' is empty, '#' is a settled block. board is top row first.",
      active: { piece: a.name, rotation: a.rotation, column: a.col, restRow: a.ghostRow },
      next: state.queue,
      hold: state.hold ?? null,
      stack: {
        height: before.maxHeight,
        holes: before.holes,
        bumpiness: before.bumpiness,
        columnHeights: before.heights,
        well: before.wellCol >= 0 ? `column ${before.wellCol} depth ${before.wellDepth}` : 'no open well',
      },
      score: state.score,
      lines: state.lines,
      level: state.level,
      combo: state.combo,
      backToBack: state.backToBack,
    },
    questions,
  };
}

// ----------------------------------------------------------------- deciding

/**
 * Turn answers into one decision. Everything is checked in code before it can
 * touch the game; anything suspicious becomes a call to the built-in engine.
 */
export function decide(answers, candidates, opts = {}) {
  const minConfidence = opts.minConfidence ?? 0.3;
  const dangerConfidence = opts.dangerConfidence ?? 0.55;
  const dangerAt = opts.dangerAt ?? 2;
  const holdThreshold = opts.holdThreshold ?? 0.6;
  const risk = Number(answers?.risk?.score ?? 0);
  const dangerous = risk >= dangerAt;

  const toEngine = (reason) => ({ kind: 'engine', reason, risk, dangerous });

  const move = answers?.move;
  if (!move || move.type !== 'choice') return toEngine('no choice answer');
  const idx = Number(String(move.choice).replace(/^c/, ''));
  const pick = candidates[idx];
  if (!pick) return toEngine(`unknown option "${move.choice}"`);
  if (pick.over) return toEngine(`option "${move.choice}" ends the game`);

  const floor = dangerous ? dangerConfidence : minConfidence;
  if (!(Number(move.confidence) >= floor)) {
    return toEngine(`confidence ${move.confidence} < ${floor}${dangerous ? ' while stack is dangerous' : ''}`);
  }

  if (answers.hold && Number(answers.hold.noul) >= holdThreshold) {
    return { kind: 'hold', reason: `hold ${answers.hold.noul} >= ${holdThreshold}`, risk, dangerous };
  }

  return {
    kind: 'candidate',
    actions: pick.actions,
    candidate: pick,
    option: move.choice,
    confidence: Number(move.confidence),
    probabilities: move.probabilities,
    reason: `${dangerous ? 'dangerous stack; ' : ''}choice ${move.choice} @ ${move.confidence}`,
    risk,
    dangerous,
  };
}

// ----------------------------------------------------------------- transport

/** POST to Jev with backoff on the documented 429/529 responses. */
export async function askJev(body, opts = {}) {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set (put it in .env, or use --dry-run)');
  const url = opts.url ?? JEV_URL;
  const attempts = opts.attempts ?? 4;
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
      });
    } catch (e) {
      lastErr = new Error(`jev request failed: ${e.message}`);
      continue;
    }
    const json = await res.json().catch(() => null);
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      const wait = Number(res.headers.get('retry-after'));
      lastErr = new Error(`jev ${res.status}: ${JSON.stringify(json ?? {}).slice(0, 200)}`);
      if (Number.isFinite(wait) && wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait * 1000, 8000)));
      continue;
    }
    if (!res.ok) throw new Error(`jev ${res.status}: ${JSON.stringify(json ?? {}).slice(0, 300)}`);
    return json;
  }
  throw lastErr ?? new Error('jev request failed');
}

// -------------------------------------------------------------------- player

const DEFAULTS = {
  pieces: 400,
  difficulty: 'hard',
  minConfidence: 0.3,
  dangerConfidence: 0.55,
  dangerAt: 2,
  holdThreshold: 0.6,
  delay: 0,
  quiet: false,
  dryRun: false,
  engineFallback: true,
};

/**
 * Play one game. `jev` and `api` are injectable so the loop can be driven
 * against a stub endpoint in tests.
 */
export async function playGame(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const api = o.api ?? new ApiClient(o.url);
  const jev = o.jev ?? ((body) => askJev(body, o));
  const log = o.log ?? ((line) => { if (!o.quiet) console.log(line); });

  const created = await api.create({ seed: o.seed, level: o.level, client: 'jev-play', difficulty: o.difficulty });
  const id = created.id;
  let cursor = created.eventCursor ?? 0;
  log(`game ${id} — watch live: ${o.url ?? 'http://127.0.0.1:8787'}/?game=${id}`);

  const tally = {
    game: id, seed: created.seed, pieces: 0, fromJev: 0, fromEngine: 0, fromCode: 0, holds: 0,
    calls: 0, inputTokens: 0, outputTokens: 0, model: null, latencyMs: 0, providerErrors: 0, consecutiveErrors: 0, lines: 0, score: 0, level: 1,
    stats: {}, over: false, overReason: null,
  };

  for (let n = 0; n < o.pieces; n++) {
    const state = await api.state(id, cursor);
    cursor = state.eventCursor;
    if (state.over) { Object.assign(tally, { over: true, overReason: state.overReason }); break; }

    const { candidates: all } = await api.candidates(id);
    const legal = orderCandidates(all.filter((c) => !c.over));
    if (!legal.length) { // nothing left to reason about; the engine has it too
      const r = await api.actions(id, ['hard_drop'], cursor);
      cursor = r.eventCursor;
      tally.pieces++; tally.fromCode++;
      continue;
    }

    // Code can decide this one: a single landing means there is no judgment left.
    if (legal.length === 1) {
      const r = await api.actions(id, legal[0].actions, cursor);
      cursor = r.eventCursor;
      tally.pieces++; tally.fromCode++;
      continue;
    }

    const body = buildRequest(state, legal, o);
    if (o.dryRun) {
      console.log(JSON.stringify(body, null, 2));
      tally.dryRun = true;
      break;
    }

    // A provider outage is a bad turn, not a dead game: hand that piece to the
    // engine and keep playing. Eight in a row is an outage, not noise, and we
    // stop rather than play 200 engine pieces and report it as a Jev run.
    const t0 = Date.now();
    let answer = null;
    let jevError = null;
    try {
      answer = await jev(body);
    } catch (e) {
      jevError = e;
      tally.providerErrors++;
      tally.consecutiveErrors++;
      if (tally.consecutiveErrors >= 8) throw new Error(`${tally.consecutiveErrors} consecutive provider failures — ${e.message}`);
    }
    const latency = Date.now() - t0;
    if (answer) {
      tally.consecutiveErrors = 0;
      tally.calls++;
      tally.latencyMs += latency;
      tally.model = answer.model ?? tally.model;
      tally.inputTokens += answer.usage?.input_tokens ?? 0;
      tally.outputTokens += answer.usage?.output_tokens ?? 0;
    }

    let decision = answer
      ? decide(answer.answers, legal, o)
      : { kind: 'engine', reason: `provider error: ${String(jevError.message).slice(0, 80)}` };
    if (answer && decision.kind === 'engine' && !o.engineFallback && legal.length) {
      decision = { ...decision, kind: 'candidate', actions: legal[0].actions, candidate: legal[0], reason: `no fallback: ${decision.reason}` };
    }

    // A hold swaps the piece and costs nothing else, so it does not consume a
    // piece from the budget: the swapped-in piece is judged on the next pass.
    if (decision.kind === 'hold') {
      const r = await api.actions(id, ['hold'], cursor);
      cursor = r.eventCursor;
      tally.holds++;
      log(`  ${String(r.pieces).padStart(4)} ${state.active.name} → hold ${state.hold}  (${decision.reason})`);
      n--;
      continue;
    }

    let actions; let label;
    if (decision.kind === 'candidate') {
      actions = decision.actions;
      const c = decision.candidate;
      label = `col ${c.col} rot ${c.rotation}${c.label ? ` ${c.label}` : c.linesCleared ? ` ${c.linesCleared} line${c.linesCleared > 1 ? 's' : ''}` : ''}`;
      tally.fromJev++;
    } else {
      const h = await api.hint(id, o.difficulty);
      actions = h.actions;
      label = `engine: col ${h.decision.col} rot ${h.decision.rotation}${h.decision.label ? ` ${h.decision.label}` : ''}`;
      tally.fromEngine++;
    }

    const res = await api.actions(id, actions, cursor);
    cursor = res.eventCursor;
    const rejected = res.rejected?.length ? ` REJECTED ${JSON.stringify(res.rejected)}` : '';
    tally.pieces++;
    Object.assign(tally, { lines: res.lines, score: res.score, level: res.level, stats: res.stats });
    log(`  ${String(res.pieces).padStart(4)} ${state.active.name} → ${label}`
      + `${decision.confidence !== undefined ? `  conf ${decision.confidence.toFixed(2)}` : ''}`
      + `${decision.risk ? `  risk ${decision.risk.toFixed(1)}` : ''}`
      + `  ${answer ? `${latency}ms` : 'no call'}${decision.kind === 'engine' ? `  (${decision.reason})` : ''}${rejected}`);

    if (res.over) { Object.assign(tally, { over: true, overReason: res.overReason }); break; }
    if (o.delay) await new Promise((r) => setTimeout(r, o.delay));
  }

  tally.costUsd = (tally.inputTokens / 1e6) * INPUT_USD_PER_MTOK;
  tally.avgLatencyMs = tally.calls ? tally.latencyMs / tally.calls : 0;
  return tally;
}

export function formatTally(t) {
  const pct = t.pieces ? (100 * t.fromJev / t.pieces).toFixed(0) : '0';
  return [
    ``,
    `  ${t.over ? `game over (${t.overReason})` : 'still running'} after ${t.pieces} pieces`,
    `  score ${t.score}   lines ${t.lines}   level ${t.level}   tetrises ${t.stats.tetrises ?? 0}   t-spins ${t.stats.tspins ?? 0}`,
    `  decisions: ${t.fromJev} Jev (${pct}%)   ${t.fromEngine} engine fallback   ${t.fromCode} decided in code   ${t.holds} holds`,
    `  ${t.calls} Jev calls on ${t.model ?? '—'}   ${t.avgLatencyMs.toFixed(0)}ms avg   ${t.inputTokens} in / ${t.outputTokens} out tokens   ~$${t.costUsd.toFixed(5)}${t.providerErrors ? `   ${t.providerErrors} provider errors` : ''}`,
    `  watch live: ${t.watchUrl ?? ''}`,
  ].join('\n');
}

// ---------------------------------------------------------------------- cli

export async function main(argv = process.argv.slice(2)) {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
    } else rest.push(argv[i]);
  }
  const num = (v, d) => (v === undefined ? d : Number(v));
  const opts = {
    seed: flags.seed ?? rest[0],
    level: num(flags.level, 1),
    pieces: num(flags.pieces, flags.until ? 4000 : DEFAULTS.pieces),
    difficulty: flags.difficulty ?? DEFAULTS.difficulty,
    url: flags.url,
    model: flags.model,
    delay: num(flags.delay, 0),
    minConfidence: num(flags['min-confidence'], DEFAULTS.minConfidence),
    dangerConfidence: num(flags['danger-confidence'], DEFAULTS.dangerConfidence),
    dangerAt: num(flags['danger-at'], DEFAULTS.dangerAt),
    holdThreshold: num(flags['hold-threshold'], DEFAULTS.holdThreshold),
    quiet: Boolean(flags.quiet),
    dryRun: Boolean(flags['dry-run']),
    engineFallback: flags['no-engine-fallback'] !== true,
  };

  if (flags['dry-run'] && !process.env.TYPESAFE_API_KEY) opts.engineFallback = true;

  const tally = await playGame(opts);
  tally.watchUrl = `${opts.url ?? 'http://127.0.0.1:8787'}/?game=${tally.game}`;
  if (flags['dry-run']) return tally;
  console.log(formatTally(tally));
  if (!flags.quiet) console.log(`\n  replay:  node tools/api-play.js replay ${tally.game} --url ${opts.url ?? 'http://127.0.0.1:8787'}\n`);
  return tally;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
}
