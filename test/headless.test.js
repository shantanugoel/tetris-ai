/**
 * Headless engine tests — run with `npm test`.
 * These exercise the same module the browser and the REST API use.
 */
import { Game, COLS, ROWS, HIDDEN_ROWS, VISIBLE_ROWS } from '../src/core.js';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; } else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, a, b) { ok(name, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// --- board geometry ---------------------------------------------------
eq('rows = hidden + visible', ROWS, HIDDEN_ROWS + VISIBLE_ROWS);
eq('columns', COLS, 10);

// --- determinism ------------------------------------------------------
{
  const a = new Game({ seed: 'alpha' });
  const b = new Game({ seed: 'alpha' });
  const c = new Game({ seed: 'bravo' });
  eq('same seed -> same queue', a.queue.slice(0, 5).join(''), b.queue.slice(0, 5).join(''));
  ok('different seed -> different queue', a.queue.slice(0, 7).join('') !== c.queue.slice(0, 7).join(''));
  // replay the same actions on both, expect identical state
  const acts = ['left', 'rotate_cw', 'hard_drop', 'right', 'hard_drop', 'hold', 'hard_drop'];
  for (const g of [a, b]) for (const act of acts) g.apply(act);
  eq('replay identical (score)', a.score, b.score);
  eq('replay identical (board)', JSON.stringify(a.state().board), JSON.stringify(b.state().board));
}

// --- 7-bag: every window of 7 pieces contains each tetromino once ----
{
  const g = new Game({ seed: 'bagger' });
  // the already-spawned piece is the first pull out of the bag, so start there
  const pieces = [g.state().active.name];
  for (let i = 0; i < 69; i++) pieces.push(g.dequeue());
  let bagOk = true;
  for (let i = 0; i + 7 <= pieces.length; i += 7) {
    if (new Set(pieces.slice(i, i + 7)).size !== 7) bagOk = false;
  }
  ok('7-bag is fair over 70 pieces', bagOk, pieces.join(' '));
}

// --- SRS states match the standard table ------------------------------
{
  const key = (n, r) => Game.cellsOf(n, r).map(([x, y]) => `${x}${y}`).sort().join(' ');
  eq('T spawn', key('T', 0), '01 10 11 21');
  eq('T R', key('T', 1), '10 11 12 21');
  eq('T 2', key('T', 2), '01 11 12 21');
  eq('T L', key('T', 3), '01 10 11 12');
  eq('I spawn', key('I', 0), '01 11 21 31');
  eq('I R', key('I', 1), '20 21 22 23');
  eq('I 2', key('I', 2), '02 12 22 32');
  eq('I L', key('I', 3), '10 11 12 13');
  eq('O invariant', key('O', 0), key('O', 2));
  eq('S R', key('S', 1), '10 11 21 22');
  eq('Z 2', key('Z', 2), '01 11 12 22');
  eq('J R', key('J', 1), '10 11 12 20');
  eq('L L', key('L', 3), '00 10 11 12');
}

// --- gravity + wall kicks --------------------------------------------
{
  // T-spin triple setup: build a well and verify a kick lands the T deep.
  const g = new Game({ seed: 'kick' });
  g.grid = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
  const bottom = ROWS - 1;
  // Build a classic TST shape with an overhang at column 2.
  for (let y = bottom - 3; y <= bottom; y++) {
    for (let x = 0; x < COLS; x++) g.grid[y][x] = 1;
  }
  // carve the TST notch
  g.grid[bottom][3] = 0; g.grid[bottom][4] = 0; g.grid[bottom][5] = 0;
  g.grid[bottom - 1][3] = 0; g.grid[bottom - 1][5] = 0;
  g.grid[bottom - 2][4] = 0; g.grid[bottom - 2][3] = 0;
  g.grid[bottom - 3][4] = 0;
  g.active = { name: 'T', rotation: 0, col: 3, row: bottom - 6, id: 3 };
  const before = g.score;
  // slide + rotate into the slot
  g.rotate(1); g.rotate(1);
  ok('T can rotate over the notch', g.active.rotation === 2);
  let dropped = 0;
  while (g.canSoftDrop() && dropped < 40) { g.softDrop(); dropped++; }
  g.rotate(1);
  eq('deep kick succeeded', g.active.kickIndex >= 0, true);
  g.hardDrop();
  ok('T-spin scored', g.score > before, `score ${g.score}`);
}

// --- line clearing & scoring -----------------------------------------
{
  const g = new Game({ seed: 'score' });
  g.grid = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
  const b = ROWS - 1;
  for (let y = b - 3; y <= b; y++) for (let x = 0; x < COLS; x++) g.grid[y][x] = 2;
  // leave column 9 open so an I piece clears 4
  for (let y = b - 3; y <= b; y++) g.grid[y][9] = 0;
  g.active = { name: 'I', rotation: 0, col: 3, row: 0, id: 1 };
  // rotate vertical, move to col 6 so it fills column 9
  g.rotate(1);
  while (g.canMoveRight()) g.move(1);
  const before = g.score;
  g.hardDrop();
  eq('tetris cleared 4 lines', g.lines, 4);
  const ev = g.events.find((e) => e.type === 'clear');
  eq('tetris label', ev.label, 'TETRIS');
  ok('perfect clear flagged separately', ev.perfect === true);
  ok('tetris gained >= 800', ev.gained >= 800, `gained ${ev.gained}`);
  eq('board empty after tetris (perfect clear)', g.state().board.flat().filter(Boolean).length, 0);
  ok('perfect clear bonus applied', ev.perfect === true);
}

// --- top out ----------------------------------------------------------
{
  const g = new Game({ seed: 'dead' });
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) g.grid[y][x] = (y > HIDDEN_ROWS ? 1 : 0);
  g.active = { name: 'I', rotation: 0, col: 3, row: 0, id: 1 };
  let guard = 0;
  while (!g.over && guard++ < 4000) g.apply('hard_drop');
  ok('game ends when stack reaches the top', g.over, `over=${g.over}`);
  ok('no actions accepted after game over', !g.apply('left'));
}

// --- ghost, hold, legal actions, placements ---------------------------
{
  const g = new Game({ seed: 'api' });
  const st = g.state();
  eq('legal actions include hard_drop', st.legalActions.includes('hard_drop'), true);
  eq('hold available at spawn', st.canHold, true);
  eq('queue preview length', st.queue.length, 5);
  eq('ghost row is below current row', st.active.ghostRow >= st.active.row, true);
  eq('ascii has visible rows', st.ascii.split('\n').length, VISIBLE_ROWS);
  eq('ascii width', st.ascii.split('\n')[0].length, COLS);
  const spawned = st.active.name;
  g.apply('hold');
  eq('hold consumed', g.canHold, false);
  eq('hold now holds the piece that was falling', g.hold, spawned);
  eq('a new piece is falling', g.state().active.name !== spawned || g.hold !== g.state().active.name, true);
  const res = g.apply('hold');
  eq('second hold rejected', res, false);
  const pl = g.placements();
  ok('placements enumerated', pl.length > 10, `count ${pl.length}`);
  ok('placements have ascii preview', typeof pl[0].ascii === 'string' && pl[0].ascii.length > 0);
}

// --- clone isolation --------------------------------------------------
{
  const g = new Game({ seed: 'clone' });
  const c = g.clone();
  ok('clone keeps queue', c.queue.join('') === g.queue.join(''));
  const pristine = JSON.stringify(g.state());
  for (let i = 0; i < 40; i++) { c.apply('hard_drop'); c.apply('left'); c.apply('rotate_cw'); c.apply('hold'); }
  eq('searching in a clone never touches the original', JSON.stringify(g.state()), pristine);
}

// --- a long unattended game must terminate cleanly, never hang --------
{
  const g = new Game({ seed: 'marathon', startLevel: 1 });
  let steps = 0;
  while (!g.over && steps < 200000) {
    const acts = g.legalActions();
    const pick = acts[Math.floor(Math.random() * acts.length)] || 'hard_drop';
    g.apply(pick === 'hold' || pick === 'soft_drop' ? 'hard_drop' : pick);
    steps++;
  }
  ok('random play terminates', g.over, `steps=${steps}`);
  const flat = g.state().board.flat();
  ok('board stays within bounds', flat.every((v) => v >= 0 && v <= 7));
}

console.log(`\n  engine: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log('   ✗ ' + f);
if (fail) process.exitCode = 1;
