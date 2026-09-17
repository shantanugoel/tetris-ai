/**
 * Neon Tetris — deterministic core engine.
 *
 * Pure logic, zero DOM/Node dependencies: the exact same file runs in the
 * browser (rendered game) and in Node (REST API for external AI players).
 *
 * Ruleset: Tetris Guideline hybrid (SRS rotation + wall kicks, 7-bag,
 * lock delay with move reset, T-spins, back-to-back, combos, perfect clears).
 *
 * Determinism: given the same `seed` and the same action sequence, every
 * game is bit-for-bit identical — which is what makes an API-playable game
 * fair to reason about, replayable, and testable.
 */

export const COLS = 10;
export const VISIBLE_ROWS = 20;
export const HIDDEN_ROWS = 4;      // spawn buffer above the visible well
export const ROWS = VISIBLE_ROWS + HIDDEN_ROWS;
export const MAX_LEVEL = 20;
export const QUEUE_PREVIEW = 5;

export const PIECE_IDS = { I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7 };
export const PIECE_NAMES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L']; // index+1 === id

/** Spawn-state bitmaps. Rotation is derived by rotating the bounding box,
 *  which is exactly what SRS specifies (verified against the SRS state table). */
const BASE_SHAPES = {
  I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
  Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
  J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
  L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
};

/** Piece id -> 4 rotation states, each a list of [x, y] cells in box space. */
const SHAPES = (() => {
  const out = {};
  for (const [name, base] of Object.entries(BASE_SHAPES)) {
    const states = [];
    let m = base;
    for (let r = 0; r < 4; r++) {
      const cells = [];
      for (let y = 0; y < m.length; y++) {
        for (let x = 0; x < m.length; x++) if (m[y][x]) cells.push([x, y]);
      }
      states.push(cells);
      const n = m.length;
      const next = Array.from({ length: n }, () => new Array(n).fill(0));
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) next[y][x] = m[n - 1 - x][y];
      m = next;
    }
    out[name] = states;
  }
  return out;
})();

const BOX_SIZE = { I: 4, O: 2, T: 3, S: 3, Z: 3, J: 3, L: 3 };
const SPAWN_COL = { I: 3, O: 4, T: 3, S: 3, Z: 3, J: 3, L: 3 };
const SPAWN_ROW = 2; // bottom-most cell lands on the last hidden row

/**
 * SRS kick tables. Authored in SRS convention (y positive = up);
 * converted to grid deltas (y positive = down) in `kickFor`.
 */
const KICKS_JLSTZ = {
  '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};
const KICKS_I = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '2>3': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '3>2': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};
const KICKS_180 = {
  '0>2': [[0, 0], [0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0]],
  '1>3': [[0, 0], [-1, 0], [-1, 1], [-1, -1], [0, 1], [0, -1]],
  '2>0': [[0, 0], [0, 1], [-1, 1], [1, 1], [-1, 0], [1, 0]],
  '3>1': [[0, 0], [1, 0], [1, -1], [1, 1], [0, -1], [0, 1]],
};

function kickFor(name, from, to) {
  const key = `${from}>${to}`;
  let table = null;
  if (Math.abs(from - to) === 2) table = KICKS_180[key];
  else if (name === 'I') table = KICKS_I[key];
  else if (name === 'O') return [[0, 0]];
  else table = KICKS_JLSTZ[key];
  if (!table) return [[0, 0]];
  // SRS y is up; grid y is down.
  return table.map(([x, y]) => [x, -y]);
}

/** Deterministic PRNG (mulberry32) over a hashed seed. */
export function makeRng(seed = Math.random().toString(36).slice(2)) {
  const str = String(seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Legal bounding-box columns for a piece/rotation (the box may hang outside the
 *  well as long as every cell is inside — that is what makes wall kicks work). */
export function colRange(name, rotation) {
  const cells = Game.cellsOf(name, rotation);
  let minX = Infinity, maxX = -Infinity;
  for (const [x] of cells) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
  return [-minX, COLS - 1 - maxX];
}

export function minCellRow(name, rotation) {
  let minY = Infinity;
  for (const [, y] of Game.cellsOf(name, rotation)) if (y < minY) minY = y;
  return minY;
}

export function gravityMs(level) {
  if (level >= MAX_LEVEL) return 25;
  return Math.max(25, 1000 * Math.pow(0.8 - (level - 1) * 0.007, level - 1));
}

/** Line clear / action scoring (Guideline-flavoured, level-multiplied). */
const CLEAR_SCORE = [0, 100, 300, 500, 800];
const TSPIN_SCORE = [400, 800, 1200, 1600];      // T-spin single/double/triple (index = lines)
const TSPIN_MINI_SCORE = [100, 200, 400, 600];   // mini variant
const PERFECT_CLEAR = [0, 800, 1200, 1800, 2000, 3000];

const CLEAR_LABEL = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'TETRIS'];
const CLEAR_COLOR = ['', '#7de3ff', '#7cf6c0', '#ffd166', '#c58cff'];

export class Game {
  constructor(options = {}) {
    const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
    this.options = {
      seed: Math.random().toString(36).slice(2),
      startLevel: 1,
      lockDelayMs: 500,
      maxResets: 15,
      gravity: true,            // false = turn-based (external AI controls descent)
      infinite: false,          // survive top-out by trimming? (default off)
      ...given,
    };
    this.reset();
  }

  reset(overrides = {}) {
    Object.assign(this.options, Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)));
    const { seed, startLevel } = this.options;
    this.seed = String(seed);
    this.rng = makeRng(this.seed);
    this.grid = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
    this.score = 0;
    this.lines = 0;
    this.level = Math.max(1, Math.min(MAX_LEVEL, startLevel | 0));
    this.combo = -1;
    this.backToBack = 0;         // number of consecutive difficult clears
    this.b2bActive = false;
    this.pieceCount = 0;
    this.hold = null;
    this.canHold = true;
    this.queue = [];
    this.bag = [];
    this.active = null;
    this.over = false;
    this.overReason = null;
    this.gravityTimer = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.grounded = false;
    this.elapsedActionMs = 0;
    this.actionCount = 0;
    this.events = [];
    this.history = [];           // full action log => replayable
    this.lastClear = null;
    this.stats = {
      pieces: 0,
      tetrises: 0,
      tspins: 0,
      maxCombo: 0,
      perfectClears: 0,
      clears: [0, 0, 0, 0, 0],
    };
    while (this.queue.length < QUEUE_PREVIEW + 2) this.queue.push(this.#pullFromBag());
    this.#spawn();
    return this;
  }

  // ---------------------------------------------------------------- bag
  #pullFromBag() {
    if (this.bag.length === 0) {
      this.bag = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
    }
    return this.bag.pop();
  }

  // ------------------------------------------------------------ helpers
  static cellsOf(name, rotation) {
    return SHAPES[name][((rotation % 4) + 4) % 4];
  }

  #cells(active = this.active) {
    return Game.cellsOf(active.name, active.rotation).map(([x, y]) => [active.col + x, active.row + y]);
  }

  collides(name, rotation, col, row, grid = this.grid) {
    for (const [cx, cy] of Game.cellsOf(name, rotation)) {
      const x = col + cx;
      const y = row + cy;
      if (x < 0 || x >= COLS || y >= ROWS) return true;
      if (y >= 0 && grid[y][x]) return true;
    }
    return false;
  }

  #pushEvent(ev) {
    this.events.push(ev);
    return ev;
  }

  drainEvents() {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  // ------------------------------------------------------------- spawn
  /** Pop the next piece off the queue and keep the queue topped up. */
  dequeue() {
    const name = this.queue.shift();
    while (this.queue.length < QUEUE_PREVIEW + 2) this.queue.push(this.#pullFromBag());
    return name;
  }

  #spawn(forced = null) {
    const name = forced ?? this.dequeue();
    const active = { name, rotation: 0, col: SPAWN_COL[name], row: SPAWN_ROW, id: PIECE_IDS[name] };
    this.pieceCount++;
    this.stats.pieces++;
    if (this.collides(active.name, active.rotation, active.col, active.row)) {
      this.active = active;
      this.#gameOver('topout');
      return false;
    }
    this.active = active;
    this.gravityTimer = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.grounded = false;
    this.canHold = true;
    this.#pushEvent({ type: 'spawn', piece: name });
    return true;
  }

  #gameOver(reason) {
    if (this.over) return;
    this.over = true;
    this.overReason = reason;
    this.#pushEvent({ type: 'game_over', reason });
  }

  // ------------------------------------------------------------ actions
  /** Every legal action name for the current position (used by AI/API clients). */
  legalActions() {
    if (this.over || !this.active) return [];
    const a = this.active;
    const acts = [];
    if (this.canMoveLeft()) acts.push('left');
    if (this.canMoveRight()) acts.push('right');
    if (this.canRotate(1)) acts.push('rotate_cw');
    if (this.canRotate(-1)) acts.push('rotate_ccw');
    if (this.canRotate(2)) acts.push('rotate_180');
    if (this.canSoftDrop()) acts.push('soft_drop');
    acts.push('hard_drop');
    if (this.canHold) acts.push('hold');
    return acts;
  }

  canMoveLeft() {
    return !this.over && this.active && !this.collides(this.active.name, this.active.rotation, this.active.col - 1, this.active.row);
  }
  canMoveRight() {
    return !this.over && this.active && !this.collides(this.active.name, this.active.rotation, this.active.col + 1, this.active.row);
  }
  canSoftDrop() {
    return !this.over && this.active && !this.collides(this.active.name, this.active.rotation, this.active.col, this.active.row + 1);
  }
  canRotate(dir) {
    if (this.over || !this.active) return false;
    const a = this.active;
    if (a.name === 'O') return false; // O has no rotation states
    const to = ((a.rotation + dir) % 4 + 4) % 4;
    for (const [dx, dy] of kickFor(a.name, a.rotation, to)) {
      if (!this.collides(a.name, to, a.col + dx, a.row + dy)) return true;
    }
    return false;
  }

  #resetLock() {
    if (this.grounded && this.lockResets < this.options.maxResets) {
      this.lockTimer = 0;
      this.lockResets++;
    }
  }

  move(dx) {
    if (this.over || !this.active) return false;
    const a = this.active;
    const ncol = a.col + dx;
    if (this.collides(a.name, a.rotation, ncol, a.row)) return false;
    a.col = ncol;
    a.lastAction = 'move';
    this.#afterMove();
    return true;
  }

  rotate(dir) {
    if (this.over || !this.active) return false;
    const a = this.active;
    if (a.name === 'O') return false;
    const to = ((a.rotation + dir) % 4 + 4) % 4;
    const kicks = kickFor(a.name, a.rotation, to);
    for (let i = 0; i < kicks.length; i++) {
      const [dx, dy] = kicks[i];
      if (this.collides(a.name, to, a.col + dx, a.row + dy)) continue;
      a.rotation = to;
      a.col += dx;
      a.row += dy;
      a.lastAction = 'rotate';
      a.kickIndex = i;
      this.#afterMove();
      return true;
    }
    return false;
  }

  #afterMove() {
    this.grounded = !this.canSoftDrop();
    this.#resetLock();
  }

  softDrop() {
    if (!this.canSoftDrop()) return false;
    this.active.row++;
    this.active.lastAction = 'move';
    this.score += 1;
    this.gravityTimer = 0;
    this.#afterMove();
    return true;
  }

  hardDrop() {
    if (this.over || !this.active) return false;
    const a = this.active;
    let dist = 0;
    while (!this.collides(a.name, a.rotation, a.col, a.row + 1)) {
      a.row++;
      dist++;
    }
    if (dist) {
      this.score += dist * 2;
      a.lastAction = 'move';
    }
    this.#pushEvent({ type: 'hard_drop', fromRow: a.row - dist, toRow: a.row, distance: dist });
    this.lock();
    return true;
  }

  /** Swap the active piece with hold. (Named swapHold() because `hold` is a field.) */
  swapHold() {
    if (this.over || !this.active || !this.canHold) return false;
    const cur = this.active.name;
    const swap = this.hold;
    this.hold = cur;
    this.#pushEvent({ type: 'hold', piece: cur, took: swap });
    if (swap) this.#spawn(swap);
    else this.#spawn();
    this.canHold = false;
    return true;
  }

  /** Apply a named action. Returns true if it changed the game. */
  apply(action) {
    if (this.over) return false;
    this.actionCount++;
    let ok = false;
    switch (action) {
      case 'left': ok = this.move(-1); break;
      case 'right': ok = this.move(1); break;
      case 'rotate_cw': ok = this.rotate(1); break;
      case 'rotate_ccw': ok = this.rotate(-1); break;
      case 'rotate_180': ok = this.rotate(2); break;
      case 'soft_drop': ok = this.softDrop(); break;
      case 'hard_drop': ok = this.hardDrop(); break;
      case 'hold': ok = this.swapHold(); break;
      default: return false;
    }
    if (ok) this.history.push(action);
    return ok;
  }

  /** Real-time gravity + lock delay. `dt` in ms. */
  tick(dt) {
    if (this.over || !this.active) return false;
    let changed = false;
    const g = this.options.gravity ? gravityMs(this.level) : Infinity;
    this.gravityTimer += dt;
    while (this.gravityTimer >= g) {
      this.gravityTimer -= g;
      if (this.canSoftDrop()) {
        this.active.row++;
        this.active.lastAction = 'move';
        changed = true;
      } else break;
    }
    this.grounded = !this.canSoftDrop();
    if (this.grounded) {
      this.lockTimer += dt;
      if (this.lockTimer >= this.options.lockDelayMs) {
        this.lock();
        return true;
      }
    } else {
      this.lockTimer = 0;
    }
    return changed;
  }

  // -------------------------------------------------------------- lock
  ghostRow() {
    if (!this.active) return 0;
    const a = this.active;
    let row = a.row;
    while (!this.collides(a.name, a.rotation, a.col, row + 1)) row++;
    return row;
  }

  lock() {
    if (this.over || !this.active) return;
    const a = this.active;
    const cells = this.#cells();
    const isTSpin = a.name === 'T' && a.lastAction === 'rotate' && this.#tSpinKind(cells);
    const spinKind = isTSpin ? (this.#tSpinMini() ? 'mini' : 'full') : null;

    let allHidden = true;
    for (const [x, y] of cells) {
      if (y < 0) continue;
      this.grid[y][x] = a.id;
      if (y >= HIDDEN_ROWS) allHidden = false;
    }
    this.#pushEvent({ type: 'lock', piece: a.name, cells: cells.map(([x, y]) => [x, y]), spin: spinKind });
    this.active = null;

    const clearedRows = [];
    for (let y = 0; y < ROWS; y++) {
      let full = true;
      for (let x = 0; x < COLS; x++) if (!this.grid[y][x]) { full = false; break; }
      if (full) clearedRows.push(y);
    }

    const n = clearedRows.length;
    let gained = 0;
    let label = '';
    let color = CLEAR_COLOR[n] ?? '#fff';

    if (n > 0) {
      const perfect = this.#isPerfectClear(clearedRows);
      // Combo
      this.combo++;
      if (this.combo > this.stats.maxCombo) this.stats.maxCombo = this.combo;
      const difficult = n === 4 || (spinKind !== null && n > 0);
      if (this.b2bActive && difficult) this.backToBack++;
      else if (difficult) this.backToBack = 1;
      else this.backToBack = 0;
      this.b2bActive = difficult;

      let base;
      if (spinKind === 'full') base = TSPIN_SCORE[n] ?? TSPIN_SCORE[3];
      else if (spinKind === 'mini') base = TSPIN_MINI_SCORE[n] ?? TSPIN_MINI_SCORE[3];
      else base = CLEAR_SCORE[n];

      gained += base * this.level;
      if (difficult && this.backToBack > 1) gained += Math.round(base * this.level * 0.5);
      if (this.combo > 0) gained += 50 * this.combo * this.level;
      if (perfect) { gained += PERFECT_CLEAR[n] * this.level; this.stats.perfectClears++; }

      const prefix = spinKind ? (spinKind === 'mini' ? 'MINI T-SPIN ' : 'T-SPIN ') : '';
      label = `${this.combo > 0 ? `${this.combo}X COMBO · ` : ''}${this.backToBack > 1 ? 'B2B ' : ''}${prefix}${CLEAR_LABEL[n]}`;
      if (spinKind) this.stats.tspins++;
      if (n === 4) this.stats.tetrises++;
      this.stats.clears[n]++;
      this.lines += n;
      this.score += gained;
      for (const y of clearedRows) {
        this.grid.splice(y, 1);
        this.grid.unshift(new Uint8Array(COLS));
      }
      const newLevel = Math.min(MAX_LEVEL, 1 + Math.floor(this.lines / 10));
      const levelled = newLevel > this.level;
      this.level = newLevel;
      this.lastClear = { count: n, label, color, gained, combo: this.combo, spin: spinKind, perfect };
      this.#pushEvent({
        type: 'clear', rows: clearedRows.slice(), count: n, label, color, gained,
        combo: this.combo, spin: spinKind, perfect, b2b: this.backToBack,
        levelUp: levelled ? newLevel : null,
      });
      if (levelled) this.#pushEvent({ type: 'level_up', level: newLevel });
    } else {
      this.combo = -1;
      this.#pushEvent({ type: 'no_clear', cells: cells.map(([x, y]) => [x, y]) });
    }

    if (allHidden) {
      this.#gameOver('lockout');
      return;
    }
    this.#spawn();
  }

  #isPerfectClear(clearedRows) {
    // Board is empty once the cleared rows are removed.
    const cleared = new Set(clearedRows);
    for (let y = 0; y < ROWS; y++) {
      if (cleared.has(y)) continue;
      for (let x = 0; x < COLS; x++) if (this.grid[y][x]) return false;
    }
    return true;
  }

  /** The T's hub: the only cell with three orthogonal neighbours in the piece. */
  static #tCenter(cells) {
    for (const [x, y] of cells) {
      let n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (cells.some(([cx, cy]) => cx === x + dx && cy === y + dy)) n++;
      }
      if (n === 3) return [x, y];
    }
    return null;
  }

  occupiedAt(x, y) {
    if (x < 0 || x >= COLS || y >= ROWS || y < 0) return true; // walls & floor count as filled
    return this.grid[y][x] !== 0;
  }

  /** Guideline 3-corner rule (evaluated against the pre-clear grid). */
  #tSpinKind(cells) {
    const center = Game.#tCenter(cells);
    if (!center) return false;
    const [cx, cy] = center;
    let filled = 0;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      if (this.occupiedAt(cx + dx, cy + dy)) filled++;
    }
    return filled >= 3;
  }

  /**
   * Mini unless both front corners (the side the nub points at) are filled,
   * or unless the rotation used the 5th SRS test (TST/DSL deep kick), which
   * always counts as a full T-spin.
   */
  #tSpinMini() {
    const a = this.active;
    if (!a) return false;
    if ((a.kickIndex ?? 0) >= 4) return false;
    const cells = this.#cells(a);
    const center = Game.#tCenter(cells);
    if (!center) return false;
    const [cx, cy] = center;
    const [fx, fy] = [[0, -1], [1, 0], [0, 1], [-1, 0]][a.rotation];
    const corners = fy !== 0
      ? [[cx - 1, cy + fy], [cx + 1, cy + fy]]
      : [[cx + fx, cy - 1], [cx + fx, cy + 1]];
    let frontFilled = 0;
    for (const [x, y] of corners) if (this.occupiedAt(x, y)) frontFilled++;
    return frontFilled < 2;
  }

  // -------------------------------------------------------- inspection
  /** Clone the whole game cheaply (used by search). */
  clone() {
    const g = new Game({ ...this.options, gravity: false });
    g.grid = this.grid.map((r) => r.slice());
    g.score = this.score; g.lines = this.lines; g.level = this.level;
    g.combo = this.combo; g.backToBack = this.backToBack; g.b2bActive = this.b2bActive;
    g.pieceCount = this.pieceCount; g.hold = this.hold; g.canHold = this.canHold;
    g.queue = this.queue.slice(); g.bag = this.bag.slice();
    g.over = this.over; g.overReason = this.overReason;
    g.gravityTimer = this.gravityTimer; g.lockTimer = this.lockTimer;
    g.lockResets = this.lockResets; g.grounded = this.grounded;
    g.actionCount = this.actionCount; g.stats = JSON.parse(JSON.stringify(this.stats));
    g.active = this.active ? { ...this.active } : null;
    g.rngStateSeed = this.seed;
    return g;
  }

  /**
   * Serializable snapshot. `ascii` is deliberately included: it is the single
   * most useful representation for an LLM-based API player.
   */
  state(opts = {}) {
    const { includeAscii = true, includeBoard = true } = opts;
    const s = {
      seed: this.seed,
      over: this.over,
      overReason: this.overReason,
      score: this.score,
      lines: this.lines,
      level: this.level,
      gravityMs: gravityMs(this.level),
      combo: this.combo,
      backToBack: this.b2bActive ? this.backToBack : 0,
      pieces: this.stats.pieces,
      hold: this.hold,
      canHold: this.canHold,
      queue: this.queue.slice(0, QUEUE_PREVIEW),
      actions: this.actionCount,
      legalActions: this.legalActions(),
      stats: this.stats,
      lastClear: this.lastClear,
    };
    if (this.active) {
      s.active = {
        name: this.active.name,
        rotation: this.active.rotation,
        col: this.active.col,
        row: this.active.row,
        ghostRow: this.ghostRow(),
        cells: this.#cells(),
      };
    } else s.active = null;
    if (includeBoard) s.board = this.grid.map((r) => Array.from(r));
    if (includeAscii) s.ascii = this.toAscii();
    return s;
  }

  /** Rows top->bottom, only the visible well. `#` filled, `.` empty, piece overlaid. */
  toAscii() {
    const rows = [];
    const overlay = new Map();
    if (this.active) for (const [x, y] of this.#cells()) overlay.set(`${x},${y}`, this.active.name);
    for (let y = HIDDEN_ROWS; y < ROWS; y++) {
      let line = '';
      for (let x = 0; x < COLS; x++) {
        const key = `${x},${y}`;
        if (overlay.has(key)) line += overlay.get(key);
        else if (this.grid[y][x]) line += PIECE_NAMES[this.grid[y][x] - 1];
        else line += '.';
      }
      rows.push(line);
    }
    return rows.join('\n');
  }

  /** Empty board + every legal (rotation, column) landing for the active piece. */
  placements() {
    if (!this.active || this.over) return [];
    const out = [];
    const a = this.active;
    const seen = new Set();
    for (let rot = 0; rot < 4; rot++) {
      if (a.name === 'O' && rot > 0) break;
      const [colMin, colMax] = colRange(a.name, rot);
      for (let col = colMin; col <= colMax; col++) {
        if (this.collides(a.name, rot, col, 0)) continue;
        let row = -minCellRow(a.name, rot) - 1;
        while (!this.collides(a.name, rot, col, row + 1)) row++;
        if (row < 0) continue;
        const key = `${rot}:${col}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sim = this.clone();
        sim.active = { ...a, rotation: rot, col, row, lastAction: 'move' };
        const before = sim.score;
        sim.lock();
        const ev = sim.events.find((e) => e.type === 'clear') || null;
        out.push({
          rotation: rot,
          col,
          row: Math.max(row, 0),
          cells: Game.cellsOf(a.name, rot).map(([x, y]) => [col + x, Math.max(0, row + y)]),
          linesCleared: ev ? ev.count : 0,
          label: ev ? ev.label : null,
          spin: ev ? ev.spin : null,
          scoreGain: sim.score - before,
          maxHeight: (() => {
            for (let y = 0; y < ROWS; y++) {
              for (let x = 0; x < COLS; x++) if (sim.grid[y][x]) return ROWS - y;
            }
            return 0;
          })(),
          over: sim.over,
          ascii: sim.toAscii(),
          key,
        });
      }
    }
    return out;
  }
}

export const COLORS = {
  I: '#3fe0ff', O: '#ffd23f', T: '#b06bff', S: '#42e69b', Z: '#ff5470', J: '#4b7bff', L: '#ff9f45',
};
