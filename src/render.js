/**
 * Neon Tetris — canvas renderer.
 *
 * The renderer owns a *visual* board that is driven by the game's event stream
 * (spawn / lock / clear / hard_drop / hold / game_over) rather than by reading
 * the logical board every frame. That is what makes line clears animatable:
 * the logic removes rows instantly, while the renderer gets to shatter them,
 * flash them, and only then collapse the stack.
 *
 * The same event stream is produced whether the game runs in the browser or on
 * the server behind the REST API, so a remote AI's game renders identically.
 *
 * Performance: block art (gradient + bevel + specular + bloom) is baked once
 * per colour into an offscreen sprite, so a frame is ~200 drawImage calls.
 */

import { COLS, ROWS, VISIBLE_ROWS, HIDDEN_ROWS, COLORS, Game, gravityMs } from './core.js';

const PAD = 0.42;            // sprite glow padding, in cells
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function shift(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(((n >> 16) & 255) + amt * 255, 0, 255);
  const g = clamp(((n >> 8) & 255) + amt * 255, 0, 255);
  const b = clamp((n & 255) + amt * 255, 0, 255);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Bake one tetromino-coloured block (with bloom) into an offscreen canvas. */
function bakeBlock(cell, color, dpr) {
  const pad = cell * PAD;
  const size = cell + pad * 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = Math.ceil(size * dpr);
  const c = cv.getContext('2d');
  c.scale(dpr, dpr);
  c.translate(pad, pad);

  c.save();
  c.shadowColor = rgba(color, 0.8);
  c.shadowBlur = cell * 0.55;
  c.fillStyle = rgba(color, 0.55);
  roundRect(c, cell * 0.1, cell * 0.1, cell * 0.8, cell * 0.8, cell * 0.2);
  c.fill();
  c.restore();

  const g = c.createLinearGradient(0, 0, cell * 0.35, cell);
  g.addColorStop(0, shift(color, 0.34));
  g.addColorStop(0.42, color);
  g.addColorStop(1, shift(color, -0.34));
  roundRect(c, cell * 0.06, cell * 0.06, cell * 0.88, cell * 0.88, cell * 0.2);
  c.fillStyle = g;
  c.fill();

  c.save();
  roundRect(c, cell * 0.06, cell * 0.06, cell * 0.88, cell * 0.88, cell * 0.2);
  c.clip();
  // top-left bevel
  const bevel = c.createLinearGradient(0, 0, cell * 0.6, cell * 0.6);
  bevel.addColorStop(0, 'rgba(255,255,255,0.62)');
  bevel.addColorStop(0.45, 'rgba(255,255,255,0.07)');
  bevel.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = bevel;
  c.fillRect(0, 0, cell, cell);
  // bottom-right shade
  const shade = c.createLinearGradient(cell * 0.4, cell * 0.4, cell, cell);
  shade.addColorStop(0, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.5)');
  c.fillStyle = shade;
  c.fillRect(0, 0, cell, cell);
  // specular streak
  c.globalAlpha = 0.5;
  c.fillStyle = 'rgba(255,255,255,0.85)';
  roundRect(c, cell * 0.17, cell * 0.13, cell * 0.5, cell * 0.1, cell * 0.05);
  c.fill();
  c.restore();

  c.strokeStyle = 'rgba(255,255,255,0.22)';
  c.lineWidth = Math.max(1, cell * 0.035);
  roundRect(c, cell * 0.06, cell * 0.06, cell * 0.88, cell * 0.88, cell * 0.2);
  c.stroke();

  return { canvas: cv, pad, size };
}

/** Draw a whole piece into an (already sized) preview canvas — HOLD / NEXT slots. */
export function renderMiniPiece(canvas, name, opts = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(cssW * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!name) return;

  const cells = Game.cellsOf(name, 0);
  const xs = cells.map(([x]) => x);
  const ys = cells.map(([, y]) => y);
  const w = Math.max(...xs) - Math.min(...xs) + 1;
  const h = Math.max(...ys) - Math.min(...ys) + 1;
  const cell = Math.min((cssW * 0.72) / w, (cssH * 0.72) / h);
  const ox = (cssW - w * cell) / 2 - Math.min(...xs) * cell;
  const oy = (cssH - h * cell) / 2 - Math.min(...ys) * cell;
  const sprite = bakeBlock(cell, COLORS[name], dpr);
  const dim = opts.dim ? 0.42 : 1;
  ctx.globalAlpha = dim;
  for (const [x, y] of cells) {
    ctx.drawImage(sprite.canvas, ox + x * cell - sprite.pad, oy + y * cell - sprite.pad, sprite.size, sprite.size);
  }
  ctx.globalAlpha = 1;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.cell = 24;
    this.sprites = new Map();
    this.ids = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
    this.flash = Array.from({ length: ROWS }, () => new Float32Array(COLS));
    this.particles = [];
    this.texts = [];
    this.beams = [];
    this.trails = [];
    this.ripples = [];
    this.clearing = [];
    this.shake = { t: 0, mag: 0 };
    this.flashScreen = 0;
    this.flashColor = '#fff';
    this.spawnPop = 0;
    this.time = 0;
    this.danger = 0;
    this.pendingResync = false;
    this.gameOverAt = 0;
  }

  resize() {
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.cell = w / COLS;
    this.sprites.clear();
    this.cssW = w;
    this.cssH = h;
  }

  sprite(color) {
    const key = `${color}|${this.cell.toFixed(2)}|${this.dpr}`;
    let s = this.sprites.get(key);
    if (!s) { s = bakeBlock(this.cell, color, this.dpr); this.sprites.set(key, s); }
    return s;
  }

  /** Hard-copy the logical board into the visual board. */
  syncBoard(board) {
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        this.ids[y][x] = board[y]?.[x] ?? 0;
        this.flash[y][x] = 0;
      }
    }
    this.clearing.length = 0;
  }

  clearEffects() {
    this.particles.length = 0; this.texts.length = 0; this.beams.length = 0;
    this.trails.length = 0; this.ripples.length = 0; this.clearing.length = 0;
    this.shake = { t: 0, mag: 0 }; this.flashScreen = 0; this.gameOverAt = 0;
  }

  // ------------------------------------------------------------- events
  pushEvents(events, state) {
    for (const ev of events ?? []) {
      switch (ev.type) {
        case 'spawn':
          this.spawnPop = 1;
          break;

        case 'hard_drop': {
          const a = state?.active;
          const name = a?.name ?? 'I';
          const color = COLORS[name] ?? '#fff';
          if (ev.distance > 0) {
            this.trails.push({ from: ev.fromRow, to: ev.toRow, cells: a?.cells ?? [], color, t: 1 });
          }
          this.shake.t = Math.min(1, 0.25 + ev.distance * 0.045);
          this.shake.mag = Math.min(9, 1.6 + ev.distance * 0.34);
          break;
        }

        case 'lock': {
          for (const [x, y] of ev.cells ?? []) {
            if (y < 0 || y >= ROWS || x < 0 || x >= COLS) continue;
            this.ids[y][x] = { I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7 }[ev.piece] ?? 1;
            this.flash[y][x] = 1;
          }
          const color = COLORS[ev.piece] ?? '#fff';
          for (const [x, y] of ev.cells ?? []) {
            if (y < 0) continue;
            this.burst((x + 0.5) * this.cell, (y + 1) * this.cell, 2, color, 0.6);
          }
          break;
        }

        case 'clear': {
          const rows = ev.rows ?? [];
          const big = ev.count >= 4 || ev.spin;
          this.clearing.push({
            rows, t: 0, dur: big ? 0.52 : 0.4, color: ev.color ?? '#fff',
            count: ev.count, label: ev.label ?? '', gained: ev.gained ?? 0,
            perfect: !!ev.perfect, spin: ev.spin ?? null,
          });
          this.flashScreen = big ? 1 : 0.45;
          this.flashColor = ev.color ?? '#fff';
          this.shake.t = 1; this.shake.mag = big ? 11 : 5;
          for (const row of rows) {
            this.beams.push({ row, t: 0, dur: big ? 1.0 : 0.7, color: ev.color ?? '#fff', big });
            for (let x = 0; x < COLS; x++) {
              const id = this.ids[row][x];
              const col = COLORS[Object.keys(COLORS)[id - 1]] ?? ev.color ?? '#fff';
              this.burst((x + 0.5) * this.cell, (row - HIDDEN_ROWS + 0.5) * this.cell + HIDDEN_ROWS * this.cell, big ? 9 : 6, col, big ? 1.5 : 1);
            }
          }
          // one label + one sub-line, on a rotating lane so bursts never overlap
          const NAMES = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'TETRIS'];
          const head = ev.spin
            ? `${ev.spin === 'mini' ? 'MINI ' : ''}T-SPIN ${NAMES[ev.count] ?? ''}`.trim()
            : (NAMES[ev.count] ?? 'CLEAR');
          const sub = [
            ev.perfect ? 'PERFECT CLEAR' : null,
            ev.b2b > 1 ? 'BACK·TO·BACK' : null,
            ev.combo > 0 ? `${ev.combo}× COMBO` : null,
            ev.gained ? `+${ev.gained.toLocaleString()}` : null,
          ].filter(Boolean).join('   ');
          const lane = (this.textLane = ((this.textLane ?? 0) + 1) % 3);
          const live = this.texts.filter((t) => t.sub !== undefined && t.kind === 'clear');
          while (live.length >= 2) {
            const old = live.shift();
            this.texts.splice(this.texts.indexOf(old), 1);
          }
          this.texts.push({ kind: 'clear',
            text: head, sub,
            x: this.cssW / 2, y: this.cssH * (0.36 + lane * 0.055), vy: -20, t: 0,
            dur: big ? 1.65 : 1.25, color: ev.color ?? '#fff', size: big ? 1 : 0.74,
          });
          break;
        }

        case 'level_up':
          this.ripples.push({ x: this.cssW / 2, y: this.cssH / 2, t: 0, dur: 1.15, color: '#7cf6c0' });
          this.texts.push({
            kind: 'level', text: `LEVEL ${ev.level}`, sub: `GRAVITY ${(gravityMs(ev.level) / 1000).toFixed(2)}s`,
            x: this.cssW / 2, y: this.cssH * 0.66, vy: -18, t: 0, dur: 1.5,
            color: '#7cf6c0', size: 0.66,
          });
          this.flashScreen = 0.5; this.flashColor = '#7cf6c0';
          break;

        case 'hold':
          this.spawnPop = 1;
          break;

        case 'game_over':
          this.gameOverAt = this.time;
          this.shake.t = 1.2; this.shake.mag = 14;
          this.flashScreen = 0.8; this.flashColor = '#ff4d6d';
          for (let i = 0; i < 90; i++) {
            this.particles.push({
              x: Math.random() * this.cssW, y: this.cssH * (0.2 + Math.random() * 0.8),
              vx: (Math.random() - 0.5) * 90, vy: -Math.random() * 210 - 40,
              life: 1, decay: 0.45 + Math.random() * 0.5, size: 2 + Math.random() * 4,
              color: Math.random() < 0.5 ? '#ff4d6d' : '#ffd166', gravity: 460,
            });
          }
          this.texts.push({ text: 'GAME OVER', x: this.cssW / 2, y: this.cssH * 0.44, vy: -8, t: 0, dur: 3.2, color: '#ff4d6d', size: 1.05 });
          break;
      }
    }
  }

  burst(x, y, n, color, power = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (40 + Math.random() * 190) * power;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 60 * power,
        life: 1, decay: 1.1 + Math.random() * 1.4,
        size: (1.4 + Math.random() * 3.2) * (this.cell / 26),
        color, gravity: 620,
      });
    }
  }

  // ------------------------------------------------------------- update
  update(dt, state) {
    this.time += dt;
    this.spawnPop = Math.max(0, this.spawnPop - dt * 4.2);
    this.flashScreen = Math.max(0, this.flashScreen - dt * 2.3);
    this.shake.t = Math.max(0, this.shake.t - dt * 3.4);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.vy += p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.life -= p.decay * dt;
      if (p.life <= 0 || p.y > this.cssH + 60) this.particles.splice(i, 1);
    }
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.t += dt; t.y += t.vy * dt; t.vy *= 0.965;
      if (t.t > t.dur) this.texts.splice(i, 1);
    }
    for (let i = this.beams.length - 1; i >= 0; i--) {
      this.beams[i].t += dt;
      if (this.beams[i].t > this.beams[i].dur) this.beams.splice(i, 1);
    }
    for (let i = this.trails.length - 1; i >= 0; i--) {
      this.trails[i].t -= dt * 4.4;
      if (this.trails[i].t <= 0) this.trails.splice(i, 1);
    }
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      this.ripples[i].t += dt;
      if (this.ripples[i].t > this.ripples[i].dur) this.ripples.splice(i, 1);
    }

    // finish line-clear animations: collapse the visual stack, then verify
    for (let i = this.clearing.length - 1; i >= 0; i--) {
      const c = this.clearing[i];
      c.t += dt;
      if (c.t >= c.dur) {
        for (const row of c.rows) {
          if (row < 0 || row >= ROWS) continue;
          this.ids.splice(row, 1);
          this.ids.unshift(new Uint8Array(COLS));
          this.flash.splice(row, 1);
          this.flash.unshift(new Float32Array(COLS));
        }
        this.clearing.splice(i, 1);
        this.pendingResync = true;
      }
    }
    if (this.pendingResync && state?.board && !this.clearing.length) {
      let mismatch = false;
      for (let y = 0; y < ROWS && !mismatch; y++) {
        for (let x = 0; x < COLS; x++) if (this.ids[y][x] !== (state.board[y]?.[x] ?? 0)) { mismatch = true; break; }
      }
      if (mismatch) this.syncBoard(state.board);
      this.pendingResync = false;
    }

    // stack height -> danger meter
    let top = ROWS;
    for (let y = 0; y < ROWS; y++) { let any = false; for (let x = 0; x < COLS; x++) if (this.ids[y][x]) { any = true; break; } if (any) { top = y; break; } }
    const height = ROWS - top;
    const target = clamp((height - 12) / 7, 0, 1);
    this.danger = lerp(this.danger, target, 1 - Math.pow(0.001, dt));

    // per-cell lock flash decay
    for (let y = 0; y < ROWS; y++) {
      const f = this.flash[y];
      for (let x = 0; x < COLS; x++) if (f[x] > 0) f[x] = Math.max(0, f[x] - dt * 3.2);
    }
  }

  // --------------------------------------------------------------- draw
  draw(state) {
    const { ctx, cssW: W, cssH: H, cell } = this;
    if (!W) return;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const INSET = cell * 0.2;
    const SC = (W - INSET * 2) / W;
    const sh = this.shake.t > 0 ? this.shake.mag * this.shake.t * this.shake.t : 0;
    const sx = sh ? (Math.random() - 0.5) * sh : 0;
    const sy = sh ? (Math.random() - 0.5) * sh : 0;

    ctx.save();
    ctx.translate(sx + INSET, sy + INSET);
    ctx.scale(SC, SC);

    // ---- well backdrop
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, 'rgba(10,14,32,0.72)');
    bg.addColorStop(1, 'rgba(4,6,16,0.86)');
    roundRect(ctx, 0, 0, W, H, cell * 0.34);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.save();
    roundRect(ctx, 0, 0, W, H, cell * 0.34);
    ctx.clip();

    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.038)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < COLS; x++) { ctx.moveTo(Math.round(x * cell) + 0.5, 0); ctx.lineTo(Math.round(x * cell) + 0.5, H); }
    for (let r = 1; r < VISIBLE_ROWS; r++) { ctx.moveTo(0, Math.round(r * cell) + 0.5); ctx.lineTo(W, Math.round(r * cell) + 0.5); }
    ctx.stroke();

    // slow light sweep for life
    const sweepY = ((this.time * 0.055) % 1) * (H + cell * 6) - cell * 3;
    const sweep = ctx.createLinearGradient(0, sweepY - cell * 3, 0, sweepY + cell * 3);
    sweep.addColorStop(0, 'rgba(120,200,255,0)');
    sweep.addColorStop(0.5, 'rgba(130,210,255,0.055)');
    sweep.addColorStop(1, 'rgba(120,200,255,0)');
    ctx.fillStyle = sweep;
    ctx.fillRect(0, sweepY - cell * 3, W, cell * 6);

    // danger wash near the top
    if (this.danger > 0.01) {
      const pulse = 0.55 + 0.45 * Math.sin(this.time * 7);
      const dg = ctx.createLinearGradient(0, 0, 0, H * 0.5);
      dg.addColorStop(0, `rgba(255,77,109,${0.26 * this.danger * pulse})`);
      dg.addColorStop(1, 'rgba(255,77,109,0)');
      ctx.fillStyle = dg;
      ctx.fillRect(0, 0, W, H * 0.5);
    }

    // ---- drop trails (hard-drop streaks)
    for (const tr of this.trails) {
      const a = tr.t * 0.5;
      ctx.globalAlpha = a;
      const xs = tr.cells.map(([x]) => x);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const g = ctx.createLinearGradient(0, tr.from * cell, 0, tr.to * cell);
      g.addColorStop(0, rgba(tr.color, 0));
      g.addColorStop(1, rgba(tr.color, 0.55));
      ctx.fillStyle = g;
      ctx.fillRect(minX * cell, tr.from * cell, (maxX - minX + 1) * cell, (tr.to - tr.from) * cell);
      ctx.globalAlpha = 1;
    }

    // ---- settled cells
    for (let y = HIDDEN_ROWS; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const id = this.ids[y][x];
        if (!id) continue;
        const name = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'][id - 1];
        const color = COLORS[name] ?? '#fff';
        const sp = this.sprite(color);
        const px = x * cell - sp.pad, py = (y - HIDDEN_ROWS) * cell - sp.pad;
        // is this cell mid-clear?
        const clearingRow = this.clearing.find((c) => c.rows.includes(y));
        if (clearingRow) {
          const p = clearingRow.t / clearingRow.dur;
          const pop = p < 0.32 ? 1 + p * 1.5 : 1.48 - (p - 0.32) * 2.2;
          const alpha = p < 0.32 ? 1 : Math.max(0, 1 - (p - 0.32) / 0.55);
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.translate(x * cell + cell / 2, (y - HIDDEN_ROWS) * cell + cell / 2);
          ctx.scale(pop, pop);
          ctx.drawImage(sp.canvas, -cell / 2 - sp.pad, -cell / 2 - sp.pad, sp.size, sp.size);
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = alpha * (1 - p) * 0.55;
          ctx.fillStyle = clearingRow.color;
          roundRect(ctx, -cell * 0.44, -cell * 0.44, cell * 0.88, cell * 0.88, cell * 0.2);
          ctx.fill();
          ctx.restore();
          continue;
        }
        ctx.drawImage(sp.canvas, px, py, sp.size, sp.size);
        const f = this.flash[y][x];
        if (f > 0) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = f * 0.85;
          ctx.fillStyle = '#ffffff';
          roundRect(ctx, x * cell + cell * 0.08, (y - HIDDEN_ROWS) * cell + cell * 0.08, cell * 0.84, cell * 0.84, cell * 0.2);
          ctx.fill();
          ctx.restore();
        }
      }
    }

    // ---- clear beams
    for (const b of this.beams) {
      const p = b.t / b.dur;
      const y = (b.row - HIDDEN_ROWS) * cell + cell / 2;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const h = cell * (0.35 + p * (b.big ? 3.4 : 2.2));
      const top = Math.max(0, y - h), bot = Math.min(H, y + h);
      const g = ctx.createLinearGradient(0, top, 0, bot);
      g.addColorStop(0, rgba(b.color, 0));
      g.addColorStop(0.5, rgba(b.color, (1 - p) * (b.big ? 0.30 : 0.22)));
      g.addColorStop(1, rgba(b.color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, top, W, bot - top);
      // the incandescent row itself
      ctx.globalAlpha = (1 - p) * 0.75;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, y - cell * 0.42 * (1 - p * 0.4), W, cell * 0.84 * (1 - p * 0.4));
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // ---- ghost + landing shadow
    if (state?.active && !state.over) {
      const a = state.active;
      const color = COLORS[a.name] ?? '#fff';
      const gy = a.ghostRow - HIDDEN_ROWS;
      // shadow line
      const bottom = Math.max(...Game.cellsOf(a.name, a.rotation).map(([, cy]) => cy));
      const lineY = (gy + bottom + 1) * cell;
      const xs = Game.cellsOf(a.name, a.rotation).map(([cx]) => cx);
      const l = (Math.min(...xs) + a.col) * cell;
      const r = (Math.max(...xs) + a.col + 1) * cell;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const lg = ctx.createLinearGradient(0, lineY - cell * 0.5, 0, lineY);
      lg.addColorStop(0, rgba(color, 0));
      lg.addColorStop(1, rgba(color, 0.5));
      ctx.fillStyle = lg;
      ctx.fillRect(l, lineY - cell * 0.5, r - l, cell * 0.5);
      ctx.fillStyle = rgba(color, 0.85);
      ctx.fillRect(l, lineY - Math.max(1.5, cell * 0.06), r - l, Math.max(1.5, cell * 0.06));
      ctx.restore();

      // ghost cells
      ctx.save();
      ctx.lineWidth = Math.max(1.4, cell * 0.07);
      ctx.setLineDash([cell * 0.24, cell * 0.18]);
      ctx.strokeStyle = rgba(color, 0.5);
      ctx.fillStyle = rgba(color, 0.09);
      for (const [cx, cy] of Game.cellsOf(a.name, a.rotation)) {
        const px = (a.col + cx) * cell, py = (a.row + cy - HIDDEN_ROWS) * cell;
        roundRect(ctx, px + cell * 0.12, py + cell * 0.12, cell * 0.76, cell * 0.76, cell * 0.2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();

      // active piece
      const pop = 1 + this.spawnPop * 0.16;
      const sp = this.sprite(color);
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      const ccx = (a.col + Game.cellsOf(a.name, a.rotation).reduce((s2, c2) => s2 + c2[0], 0) / 4 + 0.5) * cell;
      const ccy = (a.row + Game.cellsOf(a.name, a.rotation).reduce((s2, c2) => s2 + c2[1], 0) / 4 - HIDDEN_ROWS + 0.5) * cell;
      ctx.translate(ccx, ccy);
      ctx.scale(pop, pop);
      ctx.translate(-ccx, -ccy);
      ctx.shadowColor = rgba(color, 0.85);
      ctx.shadowBlur = cell * (0.7 + this.spawnPop * 0.8);
      for (const [cx, cy] of Game.cellsOf(a.name, a.rotation)) {
        const px = (a.col + cx) * cell - sp.pad;
        const py = (a.row + cy - HIDDEN_ROWS) * cell - sp.pad;
        ctx.drawImage(sp.canvas, px, py, sp.size, sp.size);
      }
      ctx.restore();
    }

    // ---- particles
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = p.color;
      const s = p.size * (0.5 + p.life * 0.8);
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // ---- ripples (level up)
    for (const rp of this.ripples) {
      const p = rp.t / rp.dur;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(rp.color, (1 - p) * 0.32);
      ctx.lineWidth = Math.max(1, cell * 0.09 * (1 - p));
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, p * Math.max(W, H) * 0.85, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // ---- floating text
    for (const t of this.texts) {
      const p = t.t / t.dur;
      const alpha = p < 0.12 ? p / 0.12 : p > 0.72 ? Math.max(0, 1 - (p - 0.72) / 0.28) : 1;
      const scale = t.size * (p < 0.16 ? 0.55 + (p / 0.16) * 0.55 : 1.1 - Math.min(0.1, p * 0.1));
      const fs = Math.max(11, cell * 0.82 * scale);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `800 ${fs}px "Chakra Petch", ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.shadowColor = rgba(t.color, 0.95);
      ctx.shadowBlur = cell * 0.9;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(t.text, t.x, t.y);
      if (t.sub) {
        ctx.font = `700 ${fs * 0.44}px "Chakra Petch", ui-monospace, monospace`;
        ctx.fillStyle = t.color;
        ctx.fillText(t.sub, t.x, t.y + fs * 0.72);
      }
      ctx.restore();
    }
    ctx.restore(); // shake

    // ---- screen flash
    if (this.flashScreen > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      roundRect(ctx, 0, 0, W, H, cell * 0.34);
      ctx.fillStyle = rgba(this.flashColor, this.flashScreen * 0.22);
      ctx.fill();
      ctx.restore();
    }

    roundRect(ctx, 0.5, 0.5, W - 1, H - 1, cell * 0.34);
    const frame = ctx.createLinearGradient(0, 0, 0, H);
    frame.addColorStop(0, 'rgba(180,220,255,0.5)');
    frame.addColorStop(0.5, `rgba(${this.danger > 0.4 ? '255,120,150' : '120,180,255'},${0.16 + this.danger * 0.35})`);
    frame.addColorStop(1, 'rgba(160,120,255,0.42)');
    ctx.strokeStyle = frame;
    ctx.lineWidth = Math.max(1.5, cell * 0.07);
    ctx.stroke();

    // corner ticks
    ctx.strokeStyle = 'rgba(190,225,255,0.75)';
    ctx.lineWidth = Math.max(2, cell * 0.09);
    const tick = cell * 0.5;
    const corners = [[INSET * 0.4, INSET * 0.4, 1, 1], [W - INSET * 0.4, INSET * 0.4, -1, 1],
      [INSET * 0.4, H - INSET * 0.4, 1, -1], [W - INSET * 0.4, H - INSET * 0.4, -1, -1]];
    for (const [cx, cy, dx, dy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx + dx * tick * 0.15, cy + dy * tick);
      ctx.lineTo(cx + dx * tick * 0.15, cy + dy * tick * 0.15);
      ctx.lineTo(cx + dx * tick, cy + dy * tick * 0.15);
      ctx.stroke();
    }
  }
}

/**
 * Animated background: drifting aurora blobs, a faint perspective floor,
 * slow stars. Cheap (a handful of gradients + ~90 dots) and hue-reactive.
 */
export class Backdrop {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.t = 0;
    this.hue = 0;
    this.pulse = 0;
    this.stars = Array.from({ length: 110 }, () => ({
      x: Math.random(), y: Math.random(), r: Math.random() * 1.5 + 0.3,
      s: Math.random() * 0.5 + 0.15, p: Math.random() * Math.PI * 2,
    }));
  }

  resize() {
    const dpr = Math.min(1.6, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.W = window.innerWidth; this.H = window.innerHeight;
  }

  kick(strength = 1, hue = 0) { this.pulse = Math.min(1.6, this.pulse + strength); this.hue = hue; }

  update(dt) {
    this.t += dt;
    this.pulse = Math.max(0, this.pulse - dt * 1.5);
  }

  draw() {
    const { ctx, W, H, dpr } = this;
    if (!W) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const base = ctx.createLinearGradient(0, 0, W * 0.4, H);
    base.addColorStop(0, '#070a18');
    base.addColorStop(0.55, '#05060f');
    base.addColorStop(1, '#0a0716');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);

    const blobs = [
      { c: '#5b3dff', x: 0.22, y: 0.2, r: 0.55, sp: 0.11, a: 0.3 },
      { c: '#00c6ff', x: 0.8, y: 0.32, r: 0.5, sp: 0.15, a: 0.24 },
      { c: '#ff2f7b', x: 0.6, y: 0.88, r: 0.6, sp: 0.09, a: 0.18 },
      { c: '#00ffb3', x: 0.1, y: 0.85, r: 0.42, sp: 0.13, a: 0.12 },
    ];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const b of blobs) {
      const x = (b.x + Math.sin(this.t * b.sp) * 0.08) * W;
      const y = (b.y + Math.cos(this.t * b.sp * 1.3) * 0.07) * H;
      const r = b.r * Math.max(W, H) * (0.9 + this.pulse * 0.12);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(b.c, b.a * (0.72 + this.pulse * 0.5)));
      g.addColorStop(0.5, rgba(b.c, b.a * 0.22));
      g.addColorStop(1, rgba(b.c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();

    // stars
    ctx.save();
    for (const s of this.stars) {
      const tw = 0.4 + 0.6 * Math.abs(Math.sin(this.t * s.s + s.p));
      ctx.globalAlpha = tw * 0.5;
      ctx.fillStyle = '#cfe6ff';
      ctx.fillRect(s.x * W, s.y * H, s.r, s.r);
    }
    ctx.restore();

    // perspective floor
    const horizon = H * 0.72;
    ctx.save();
    ctx.globalAlpha = 0.24;
    ctx.strokeStyle = 'rgba(120,170,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = -14; i <= 14; i++) {
      const x = W / 2 + i * (W / 14);
      ctx.moveTo(W / 2 + i * 26, horizon);
      ctx.lineTo(x, H);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const f = i / 15;
      const y = horizon + Math.pow(f, 2.4) * (H - horizon) + ((this.t * 30) % (H * 0.04));
      if (y > H) continue;
      ctx.moveTo(0, y); ctx.lineTo(W, y);
    }
    ctx.stroke();
    ctx.restore();

    // vignette
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.34, W / 2, H / 2, Math.max(W, H) * 0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.72)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
  }
}
