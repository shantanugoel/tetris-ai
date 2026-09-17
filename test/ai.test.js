/**
 * AI tests + benchmark: `node test/ai.test.js`
 *  - every emitted action list must be legal AND land the placement the search chose
 *  - self-play must survive long, clear lines, and stay real-time fast
 */
import { Game, COLS, ROWS } from '../src/core.js';
import { plan, advise, selfPlay, sequenceTo, features } from '../src/ai.js';

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = '') => c ? pass++ : (fail++, failures.push(`${n}${d ? ' — ' + d : ''}`));
const boardKey = (g) => g.grid.map((r) => Array.from(r).join('')).join('|');

/** Reference board: teleport the piece to its landing spot, then lock. */
function directBoard(g, spot, useHold) {
  const sim = g.clone();
  if (useHold) sim.swapHold();
  let row = -4;
  while (!sim.collides(sim.active.name, spot.rotation, spot.col, row + 1)) row++;
  sim.active.rotation = spot.rotation;
  sim.active.col = spot.col;
  sim.active.row = row;
  sim.active.lastAction = 'move';
  sim.lock();
  return boardKey(sim);
}

// ---- 1. emitted sequences are legal and land the chosen placement ---------
{
  let checked = 0, illegal = 0, offTarget = 0;
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const g = new Game({ seed });
    for (let piece = 0; piece < 35 && !g.over; piece++) {
      const p = plan(g, { depth: 2, breadth: 4 });
      if (!p) break;
      const acts = [...(p.useHold ? ['hold'] : []), ...p.moves];
      const sim = g.clone();
      for (const a of acts) {
        if (!sim.apply(a) && a !== 'soft_drop') illegal++;
      }
      checked++;
      if (boardKey(sim) !== directBoard(g, p, p.useHold)) offTarget++;
      // the game state after an AI piece must be reachable (never corrupt)
      const flat = sim.state().board.flat();
      if (!flat.every((v) => v >= 0 && v <= 7)) illegal++;
      if (sim.over) break;
    }
  }
  ok(`${checked} AI plans executed legally`, illegal === 0, `illegal steps=${illegal}`);
  ok(`${checked} plans landed exactly on the chosen placement`, offTarget === 0, `off-target=${offTarget}`);
}

// ---- 2. sequenceTo covers every placement of the piece in hand -----------
{
  let illegal = 0, tests = 0, unreachable = 0;
  for (let s = 0; s < 10; s++) {
    const g = new Game({ seed: `seq${s}` });
    for (let i = 0; i < 20 && !g.over; i++) {
      for (const sp of g.placements().slice(0, 8)) {
        const seq = sequenceTo(g, sp);
        tests++;
        if (!seq) { unreachable++; continue; }
        const sim = g.clone();
        for (const a of seq) if (!sim.apply(a) && a !== 'soft_drop') { illegal++; break; }
      }
      g.apply('hard_drop');
    }
  }
  ok(`sequenceTo produced ${tests} legal sequences`, illegal === 0, `illegal=${illegal}`);
  // placements() is geometric: a landing spot can be legally unreachable under
  // an overhang. The planner itself filters through sequenceTo, so a small
  // unreachable rate here is expected and fine.
  ok('most sampled placements were reachable', unreachable / tests < 0.05, `${unreachable}/${tests} unreachable`);
}

// ---- 3. advise() is a drop-in for an external player ---------------------
{
  const g = new Game({ seed: 'advise' });
  let pieces = 0;
  while (!g.over && pieces < 150) {
    const acts = advise(g, { depth: 2, breadth: 4 });
    if (!acts.length) break;
    for (const a of acts) g.apply(a);
    pieces++;
  }
  ok('advise() played a full game', pieces >= 40, `pieces=${pieces} lines=${g.lines}`);
  ok('advise() never left the board in a bad state', g.state().board.flat().every((v) => v >= 0 && v <= 7));
}

// ---- 3b. tactics: it must take a Tetris when one is offered -------------
{
  let took = 0, tries = 0;
  for (const col of [0, 3, 9]) {
    for (const startRot of [0, 1]) {
      const g = new Game({ seed: `quad-${col}-${startRot}` });
      g.grid = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
      for (let y = ROWS - 4; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (x !== col) g.grid[y][x] = 2;
      g.active = { name: 'I', rotation: startRot, col: 3, row: 0, id: 1 };
      tries++;
      const acts = advise(g, { difficulty: 'hard' });
      for (const a of acts) g.apply(a);
      if (g.lines === 4) took++;
    }
  }
  ok('takes every available Tetris', took === tries, `${took}/${tries}`);
}

// ---- 4. self-play quality + speed ---------------------------------------
{
  const results = [];
  for (const seed of ['s1', 's2', 's3', 's4', 's5']) {
    const g = new Game({ seed, startLevel: 1 });
    const t0 = Date.now();
    selfPlay(g, { depth: 3, breadth: 6, maxPieces: 500 });
    const f = features(g.grid);
    results.push({
      seed, pieces: g.stats.pieces, lines: g.lines, score: g.score, ms: Date.now() - t0,
      tetrises: g.stats.tetrises, tspins: g.stats.tspins, maxCombo: g.stats.maxCombo,
      level: g.level, holes: f.holes, height: f.maxHeight, over: g.over, reason: g.overReason,
    });
  }
  const avg = (k) => results.reduce((a, r) => a + r[k], 0) / results.length;
  const msPerPiece = avg('ms') / avg('pieces');
  ok('survives >= 100 pieces on average', avg('pieces') >= 100, `avg ${avg('pieces').toFixed(0)}`);
  // theoretical ceiling is 0.4 lines/piece (4 cells per piece, 10 per row)
  ok('clears >= 0.28 lines/piece', avg('lines') / avg('pieces') >= 0.28, `${(avg('lines') / avg('pieces')).toFixed(2)} lines/piece`);
  ok('keeps holes low', avg('holes') <= 15, `avg holes ${avg('holes').toFixed(1)}`);
  ok('reaches at least level 4', avg('level') >= 4, `avg level ${avg('level').toFixed(1)}`);
  ok('fast enough for real-time (<25ms/piece)', msPerPiece < 25, `${msPerPiece.toFixed(1)} ms/piece`);
  console.log('\n  self-play sample:');
  for (const r of results) {
    console.log(`   ${r.seed.padEnd(3)} pieces=${String(r.pieces).padStart(4)} lines=${String(r.lines).padStart(4)}`
      + ` score=${String(r.score).padStart(7)} lvl=${String(r.level).padStart(2)}`
      + ` tetris=${String(r.tetrises).padStart(2)} tspin=${String(r.tspins).padStart(2)}`
      + ` combo=${String(r.maxCombo).padStart(2)} holes=${String(r.holes).padStart(2)}`
      + ` h=${String(r.height).padStart(2)} ${r.over ? `over(${r.reason})` : 'alive'}`
      + ` ${(r.ms / r.pieces).toFixed(1)}ms/pc`);
  }
}

console.log(`\n  ai: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log('   ✗ ' + f);
if (fail) process.exitCode = 1;
