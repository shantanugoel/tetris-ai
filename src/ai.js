/**
 * Neon Tetris — AI engine.
 *
 * Two parts:
 *  1. `sequenceTo()` — BFS over the *real* move graph (left/right/both rotations/
 *     soft drop), so the action list it emits is always legal under SRS kicks.
 *     That means the autopilot, the REST API, and an external LLM player all
 *     get executable move strings, not just "column 4".
 *  2. `plan()` — pruned depth-N search over placements (root: every reachable
 *     landing spot, then top-K per ply, hold considered on the root ply only),
 *     scored with a tuned positional evaluation.
 *
 * No DOM, no Node APIs: runs identically in the browser and in the server.
 */

import { Game, COLS, ROWS, HIDDEN_ROWS, colRange, minCellRow } from './core.js';

/** Positional evaluation weights. Tuned for flat, low-hole stacks that
 *  still find Tetrises and T-spins (they get explicit bonuses). */
export const W = {
  aggHeight: -0.51,
  maxHeight: -0.42,
  holes: -1.35,
  bumpiness: -0.34,
  rowTransitions: -0.11,
  colTransitions: -0.16,
  // A well is only valuable while it can still be drained, so the bonus is
  // deliberately small and any capped (hole-ified) well is punished hard.
  wellDepth: 0.12,
  coveredWellPenalty: -1.10,
  clearBonus: [0, 12, 34, 66, 150, 240],
  quadWell: 0.15,
  holeCleared: 6.0,
  spinBonus: 14,
  perfectClear: 90,
  dangerStart: 14,
  danger: -3.6,
  topOut: -1e6,
};

/** Feature extraction over a settled board (post line-clear). */
export function features(grid) {
  let aggHeight = 0, maxHeight = 0, holes = 0, rowT = 0, colT = 0, wells = 0, coveredWells = 0;
  let quadWell = 0, quadWellCol = -1;
  const heights = new Array(COLS).fill(0);
  const colHoles = new Array(COLS).fill(0);

  for (let x = 0; x < COLS; x++) {
    let top = -1;
    for (let y = HIDDEN_ROWS; y < ROWS; y++) if (grid[y][x]) { top = y; break; }
    heights[x] = top < 0 ? 0 : ROWS - top;
    if (heights[x] > maxHeight) maxHeight = heights[x];
    aggHeight += heights[x];
    if (top >= 0) {
      for (let y = top + 1; y < ROWS; y++) if (!grid[y][x]) { holes++; colHoles[x]++; }
    }
  }

  let bumpiness = 0;
  for (let x = 0; x < COLS - 1; x++) bumpiness += Math.abs(heights[x] - heights[x + 1]);

  // horizontal transitions (rows)
  for (let y = HIDDEN_ROWS; y < ROWS; y++) {
    let prev = 1; // left wall is "filled"
    for (let x = 0; x < COLS; x++) {
      const cur = grid[y][x] ? 1 : 0;
      if (cur !== prev) rowT++;
      prev = cur;
    }
    if (prev !== 1) rowT++; // right wall
  }

  // vertical transitions (columns) + well depth
  for (let x = 0; x < COLS; x++) {
    let prev = 1;
    for (let y = HIDDEN_ROWS; y < ROWS; y++) {
      const cur = grid[y][x] ? 1 : 0;
      if (cur !== prev) colT++;
      prev = cur;
    }
    if (prev !== 1) colT++;

    // Wells: maximal runs of empty cells whose left AND right neighbours are
    // solid (walls count). Counted once per run, never per cell — per-cell
    // counting compounds quadratically and makes the bot dig hole towers.
    let wy = HIDDEN_ROWS;
    while (wy < ROWS) {
      if (grid[wy][x]) { wy++; continue; }
      const leftSolid = x === 0 || grid[wy][x - 1] !== 0;
      const rightSolid = x === COLS - 1 || grid[wy][x + 1] !== 0;
      if (!leftSolid || !rightSolid) { wy++; continue; }
      let end = wy;
      while (end < ROWS && !grid[end][x]) end++;
      const depth = end - wy;
      if (depth >= 2) {
        wells += depth;
        // a capped well is a hole, not a well
        if (wy > HIDDEN_ROWS && grid[wy - 1][x] !== 0) coveredWells += depth;
      }
      wy = end;
    }
  }

  // The "Tetris slot": one clean column far below nine level columns. Without
  // this term a height-based bot happily takes doubles and never sets up a quad.
  let flatMax = 0;
  for (let x = 0; x < COLS; x++) if (heights[x] > flatMax) flatMax = heights[x];
  if (flatMax >= 3) {
    for (let x = 0; x < COLS; x++) {
      const depth = flatMax - heights[x];
      if (depth < 3 || colHoles[x] > 0) continue;
      let flat = true;
      for (let o = 0; o < COLS; o++) {
        if (o === x) continue;
        // level within one row of the top and hole-free counts as "flat"
        if (heights[o] < flatMax - 1 || colHoles[o] > 0) { flat = false; break; }
      }
      if (flat) { quadWell = Math.max(quadWell, Math.min(depth, 8)); quadWellCol = x; }
    }
  }

  return { aggHeight, maxHeight, holes, bumpiness, rowTransitions: rowT, colTransitions: colT, wells, coveredWells, quadWell, quadWellCol, heights };
}

/** Score a settled position given its features and what the last piece did. */
export function scorePosition(f, info = {}, w = W) {
  let s = 0;
  s += w.aggHeight * f.aggHeight;
  s += w.maxHeight * f.maxHeight;
  s += w.holes * f.holes;
  s += w.bumpiness * f.bumpiness;
  s += w.rowTransitions * f.rowTransitions;
  s += w.colTransitions * f.colTransitions;
  s += w.wellDepth * f.wells;
  s += w.coveredWellPenalty * f.coveredWells;
  // Quadratic in depth: building a Tetris slot costs height on every step and
  // only pays off on the last one, so the incentive has to grow faster than the
  // height penalty or the bot never commits to a quad.
  s += w.quadWell * f.quadWell * f.quadWell;

  const cleared = info.cleared ?? 0;
  if (cleared > 0) {
    s += w.clearBonus[Math.min(5, cleared)] ?? 0;
    s += w.holeCleared * (info.holesCleared ?? 0);
    if (info.spin) s += w.spinBonus * (info.spin === 'full' ? 1.4 : 0.8);
    if (info.perfect) s += w.perfectClear;
  }
  if (f.maxHeight > w.dangerStart) s += w.danger * (f.maxHeight - w.dangerStart) ** 2;
  if (info.over) s += w.topOut;
  return s;
}

/** Holes above the settled surface, used to reward clearing them. */
function countHoles(grid) {
  let holes = 0;
  for (let x = 0; x < COLS; x++) {
    let top = -1;
    for (let y = HIDDEN_ROWS; y < ROWS; y++) if (grid[y][x]) { top = y; break; }
    if (top >= 0) for (let y = top + 1; y < ROWS; y++) if (!grid[y][x]) holes++;
  }
  return holes;
}

// --------------------------------------------------------------------------
// Move sequencing (BFS over the legal move graph)
// --------------------------------------------------------------------------

const SEQ_ACTIONS = ['left', 'right', 'rotate_cw', 'rotate_ccw', 'rotate_180', 'soft_drop'];
const SEQ_COST = { left: 1, right: 1, rotate_cw: 1, rotate_ccw: 1, rotate_180: 1.25, soft_drop: 0.4 };

/**
 * Shortest legal action list that parks the active piece in (rotation, col)
 * and then hard-drops it. Uses uniform-cost search with a small cost model so
 * 180s are slightly avoided and falling through a slide is cheap.
 * @returns {string[]|null}
 */
export function sequenceTo(game, target) {
  const start = game.active;
  if (!start) return null;
  const needRot = target.rotation, needCol = target.col;
  if (start.name === 'O') {
    // O never rotates: pure horizontal walk.
    const moves = [];
    const step = needCol > start.col ? 'right' : 'left';
    const g = game.clone();
    while (g.active.col !== needCol) {
      if (!g.move(step > 'r' ? 1 : -1)) break;
      moves.push(step);
    }
    return g.active.col === needCol ? [...moves, 'hard_drop'] : null;
  }

  const key = (rot, col, row) => `${rot}|${col}|${row}`;
  const startKey = key(start.rotation, start.col, start.row);
  const dist = new Map([[startKey, 0]]);
  const from = new Map();
  const frontier = [{ rot: start.rotation, col: start.col, row: start.row, c: 0 }];
  let best = null;

  const rotate = (state, dir) => {
    const to = ((state.rot + dir) % 4 + 4) % 4;
    const probe = { name: start.name, rotation: state.rot, col: state.col, row: state.row };
    for (const [dx, dy] of kicksFor(start.name, state.rot, to)) {
      if (!game.collides(start.name, to, state.col + dx, state.row + dy)) {
        return { rot: to, col: state.col + dx, row: state.row + dy };
      }
    }
    void probe;
    return null;
  };

  let guard = 0;
  while (frontier.length && guard++ < 6000) {
    // cheap uniform-cost: pick lowest-cost node (state space is ~1k)
    let bi = 0;
    for (let i = 1; i < frontier.length; i++) if (frontier[i].c < frontier[bi].c) bi = i;
    const cur = frontier.splice(bi, 1)[0];
    const ck = key(cur.rot, cur.col, cur.row);
    if (dist.has(ck) && dist.get(ck) < cur.c) continue;

    if (cur.rot === needRot && cur.col === needCol) { best = cur; break; }

    const neighbours = [];
    const left = { rot: cur.rot, col: cur.col - 1, row: cur.row };
    if (!game.collides(start.name, cur.rot, left.col, left.row)) neighbours.push(['left', left, SEQ_COST.left]);
    const right = { rot: cur.rot, col: cur.col + 1, row: cur.row };
    if (!game.collides(start.name, cur.rot, right.col, right.row)) neighbours.push(['right', right, SEQ_COST.right]);
    const down = { rot: cur.rot, col: cur.col, row: cur.row + 1 };
    if (!game.collides(start.name, cur.rot, down.col, down.row)) neighbours.push(['soft_drop', down, SEQ_COST.soft_drop]);
    for (const [act, dir, cost] of [['rotate_cw', 1], ['rotate_ccw', -1], ['rotate_180', 2]]) {
      const n = rotate(cur, dir);
      if (n) neighbours.push([act, n, cost ?? SEQ_COST[act]]);
    }

    for (const [act, n, cost] of neighbours) {
      const nk = key(n.rot, n.col, n.row);
      const nc = cur.c + cost;
      if (dist.has(nk) && dist.get(nk) <= nc) continue;
      dist.set(nk, nc);
      from.set(nk, { prev: ck, act });
      frontier.push({ ...n, c: nc });
    }
  }

  if (!best) return null;
  // reconstruct
  const acts = [];
  let k = key(best.rot, best.col, best.row);
  while (from.has(k)) {
    const { prev, act } = from.get(k);
    acts.push(act);
    k = prev;
  }
  acts.reverse();
  return [...acts, 'hard_drop'];
}

/** Kick lookup mirrored from core for the BFS (kept in sync intentionally). */
function kicksFor(name, from, to) {
  const key = `${from}>${to}`;
  const T = {
    '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
    '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    '2>3': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
    '3>2': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
    '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  };
  const J = {
    '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  };
  const ONE80 = {
    '0>2': [[0, 0], [0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0]],
    '1>3': [[0, 0], [-1, 0], [-1, 1], [-1, -1], [0, 1], [0, -1]],
    '2>0': [[0, 0], [0, 1], [-1, 1], [1, 1], [-1, 0], [1, 0]],
    '3>1': [[0, 0], [1, 0], [1, -1], [1, 1], [0, -1], [0, 1]],
  };
  let table;
  if (Math.abs(from - to) === 2) table = ONE80[key];
  else if (name === 'O') return [[0, 0]];
  else if (name === 'I') table = T[key];
  else table = J[key];
  if (!table) return [[0, 0]];
  return table.map(([x, y]) => [x, -y]);
}

// --------------------------------------------------------------------------
// Search
// --------------------------------------------------------------------------

/** All landing spots for the piece currently in hand. */
function spotsFor(g) {
  if (!g.active) return [];
  const out = [];
  const name = g.active.name;
  const maxRot = name === 'O' ? 1 : 4;
  for (let rot = 0; rot < maxRot; rot++) {
    const [colMin, colMax] = colRange(name, rot);
    for (let col = colMin; col <= colMax; col++) {
      if (g.collides(name, rot, col, 0)) continue;
      let row = -minCellRow(name, rot) - 1;
      while (!g.collides(name, rot, col, row + 1)) row++;
      if (row < 0) continue;
      out.push({ rotation: rot, col, row });
    }
  }
  return out;
}

/** Drop `spot` into a cloned game and return the resulting position score. */
function evaluateSpot(g, spot, useHold, w = W) {
  const sim = g.clone();
  sim.events.length = 0;
  if (useHold) sim.swapHold();
  if (!sim.active || sim.over) return { score: W.topOut, sim };
  if (sim.collides(sim.active.name, spot.rotation, spot.col, spot.row)) return { score: W.topOut, sim };
  const holesBefore = countHoles(sim.grid);
  sim.active.rotation = spot.rotation;
  sim.active.col = spot.col;
  sim.active.row = spot.row;
  sim.active.lastAction = spot.spinHint ? 'rotate' : 'move';
  sim.active.kickIndex = 0;
  sim.lock();
  if (sim.over) return { score: W.topOut, sim };
  const ev = sim.events.find((e) => e.type === 'clear');
  const cleared = ev ? ev.count : 0;
  const holesAfter = countHoles(sim.grid);
  const f = features(sim.grid);
  const score = scorePosition(f, {
    cleared,
    holesCleared: Math.max(0, holesBefore - holesAfter),
    spin: ev ? ev.spin : null,
    perfect: ev ? ev.perfect : false,
    over: false,
  }, w);
  return { score, sim, cleared, label: ev ? ev.label : null };
}

/**
 * Choose the next move.
 * @param {Game} game
 * @param {object} opts {depth=3, breadth=6, allowHold=true}
 * @returns {{actions:string[], planScore:number, decision:object, ranked:object[]}|null}
 */
/**
 * Benchmark-derived difficulties (see tools/bench.js). Roughly, at level 1:
 * easy ~85 pieces, normal ~135, hard ~230, insane ~350.
 */
export const DIFFICULTY = {
  easy: { depth: 1, breadth: 4, blunder: 0.35 },
  normal: { depth: 2, breadth: 6, blunder: 0.08 },
  hard: { depth: 3, breadth: 8, blunder: 0.01 },
  insane: { depth: 4, breadth: 5, style: 'tetris', blunder: 0 },
};

/** Deterministic pseudo-noise so blunders stay replayable. */
function noise(a, b) {
  let h = 2166136261 >>> 0;
  const s = `${a}:${b}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

export function plan(game, options = {}) {
  const opts = { ...(DIFFICULTY[options.difficulty] ?? {}), ...options };
  const w = opts.weights ? { ...W, ...opts.weights } : W;
  const depth = opts.depth ?? 3;
  const breadth = opts.breadth ?? 6;
  const allowHold = opts.allowHold ?? true;
  if (game.over || !game.active) return null;

  const rootPiece = game.active.name;

  // ---- Tetris-style hold discipline -------------------------------------
  // When a clean deep slot exists, no other clear is even possible, so a human
  // parks the current piece in hold and waits for an I (or swaps an already
  // held I out). Doing this explicitly is what produces Tetrises instead of an
  // endless stream of singles.
  const style = opts.style ?? 'balanced';
  let forcedHold = false;
  if (style === 'tetris' && game.canHold && game.active.name !== 'I') {
    const f = features(game.grid);
    const ceiling = opts.holdCeiling ?? 13;
    if (f.quadWell >= (opts.quadWait ?? 4) && f.maxHeight <= ceiling) forcedHold = true;
  }

  const roots = [];
  for (const spot of spotsFor(game)) {
    const r = evaluateSpot(game, spot, false, w);
    roots.push({ ...spot, score: r.score, cleared: r.cleared, label: r.label, useHold: false, sim: r.sim, piece: rootPiece });
  }
  if (allowHold && game.canHold && (game.hold || forcedHold)) {
    const heldPiece = game.hold;
    for (const spot of spotsFor(game)) {
      const r = evaluateSpot(game, spot, true, w);
      if (r.score <= W.topOut / 2) continue;
      roots.push({ ...spot, score: r.score, cleared: r.cleared, label: r.label, useHold: true, sim: r.sim, piece: heldPiece });
    }
  }
  if (forcedHold) {
    const held = roots.filter((r) => r.useHold);
    if (held.length) roots.length = 0, roots.push(...held);
  }
  if (!roots.length) return null;
  roots.sort((a, b) => b.score - a.score);

  const toView = (r) => ({
    piece: r.piece,
    rotation: r.rotation,
    col: r.col,
    row: r.row,
    useHold: r.useHold,
    immediateScore: +r.score.toFixed(2),
    planScore: null,
    linesCleared: r.cleared,
    label: r.label,
  });

  // Standard elite pruning: only the top candidates by immediate score are
  // worth looking ahead at, and the winner is chosen *within* that elite set
  // (comparing a look-ahead total against a bare immediate score is meaningless).
  // Handicap: occasionally settle for a random legal spot, deterministically,
  // so "easy" is beatable by a human and replays still match.
  const blunder = opts.blunder ?? 0;
  if (blunder > 0 && roots.length > 1 && noise(game.seed, game.stats.pieces) < blunder) {
    const pick = roots[Math.floor(noise(game.seed, `b${game.stats.pieces}`) * roots.length)];
    const exec = game.clone();
    if (pick.useHold) exec.swapHold();
    const moves = sequenceTo(exec, pick) ?? ['hard_drop'];
    return {
      piece: pick.piece, rotation: pick.rotation, col: pick.col, row: pick.row, useHold: pick.useHold,
      immediateScore: +pick.score.toFixed(2), planScore: null, linesCleared: pick.cleared, label: pick.label,
      blundered: true, moves, actions: [...(pick.useHold ? ['hold'] : []), ...moves],
      ranked: roots.slice(0, 8).map((r) => ({ piece: r.piece, rotation: r.rotation, col: r.col, useHold: r.useHold, immediateScore: +r.score.toFixed(2), planScore: null, linesCleared: r.cleared, label: r.label })),
    };
  }

  const elite = roots.slice(0, Math.min(roots.length, opts.elite ?? 12));
  const discount = opts.discount ?? 0.9;
  for (const r of elite) {
    r.plan = +(r.score + discount * lookahead(r.sim, depth - 1, breadth, discount, w)).toFixed(2);
  }
  elite.sort((a, b) => b.plan - a.plan);

  const winner = (() => {
    // The best spot may be unreachable under an overhang; take the highest-ranked
    // elite whose move sequence actually exists.
    for (const cand of elite) {
      const exec = game.clone();
      if (cand.useHold) exec.swapHold();
      if (sequenceTo(exec, cand)) return cand;
    }
    return elite[0];
  })();

  const exec = game.clone();
  if (winner.useHold) exec.swapHold();
  const moves = sequenceTo(exec, winner) ?? ['hard_drop'];
  const actions = [...(winner.useHold ? ['hold'] : []), ...moves];

  const shown = elite.slice(0, 8).map((r) => ({ ...toView(r), planScore: r.plan }));
  return { ...toView(winner), planScore: winner.plan, moves, actions, ranked: shown };
}

/**
 * Best achievable discounted position score over the next `ply` pieces.
 * Returns the sum of future positional scores (0 when nothing is left to play).
 */
function lookahead(game, ply, breadth, discount, w) {
  if (ply <= 0 || !game.active || game.over) return 0;
  const kids = [];
  for (const spot of spotsFor(game)) {
    const r = evaluateSpot(game, spot, false, w);
    if (r.score <= W.topOut / 2) continue;
    kids.push(r);
  }
  if (!kids.length) return W.topOut;
  kids.sort((a, b) => b.score - a.score);
  let best = -Infinity;
  for (const k of kids.slice(0, breadth)) {
    const total = k.score + discount * lookahead(k.sim, ply - 1, breadth, discount, w);
    if (total > best) best = total;
  }
  return best;
}

/** Convenience for API consumers: just the action list for one piece. */
export function advise(game, opts) {
  const p = plan(game, opts);
  return p ? p.actions : [];
}

/** Play the current game to completion (used by the server for demos/tests). */
export function selfPlay(game, opts = {}) {
  const maxPieces = opts.maxPieces ?? 2000;
  let pieces = 0;
  while (!game.over && pieces < maxPieces) {
    const acts = advise(game, opts);
    for (const a of acts) game.apply(a);
    pieces++;
    if (opts.onPiece) opts.onPiece(game, pieces);
  }
  return game;
}
