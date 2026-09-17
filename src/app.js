/**
 * Neon Tetris — application layer.
 *
 * Three ways to play, one renderer:
 *   • human   — keyboard/touch drive a local Game with real-time gravity
 *   • engine  — the built-in search bot drives the same local Game (autopilot)
 *   • remote  — `?game=<id>` attaches to a server-side game over the REST API
 *               and renders an external AI's moves live, including all effects
 */

import { Game, COLS, VISIBLE_ROWS, QUEUE_PREVIEW, COLORS } from './core.js';
import { plan, DIFFICULTY } from './ai.js';
import { Renderer, Backdrop, renderMiniPiece } from './render.js';

const $ = (sel) => document.querySelector(sel);
const el = {
  bg: $('#bg'), board: $('#board'), overlay: $('#overlay'),
  ovTitle: $('#ov-title'), ovSub: $('#ov-sub'), ovPrimary: $('#ov-primary'),
  ovSecondary: $('#ov-secondary'), ovHint: $('#ov-hint'), ovStats: $('#ov-stats'),
  score: $('#score'), lines: $('#lines'), level: $('#level'), pieces: $('#pieces'),
  combo: $('#combo'), b2b: $('#b2b'), ppm: $('#ppm'), apm: $('#apm'),
  best: $('#best'), tetrises: $('#tetrises'), tspins: $('#tspins'),
  hold: $('#holdCanvas'), feed: $('#feed'), decision: $('#decision'),
  chipMode: $('#chip-mode'), chipSeed: $('#chip-seed'), chipAi: $('#chip-ai'),
  btnAi: $('#btn-ai'), btnTurbo: $('#btn-turbo'), btnSound: $('#btn-sound'),
  btnPause: $('#btn-pause'), btnRestart: $('#btn-restart'), btnRemote: $('#btn-remote'),
  difficulty: $('#difficulty'), apiSnippet: $('#apiSnippet'), copyApi: $('#copyApi'),
  touch: $('#touch'),
};
const nextCanvases = [...document.querySelectorAll('#nextQueue canvas')];

const params = new URLSearchParams(location.search);
const HAS_API = location.protocol.startsWith('http');

// ---------------------------------------------------------------------- audio
/** Tiny synth: no assets, no autoplay (created on first gesture). */
class Sfx {
  constructor() { this.ctx = null; this.on = false; this.master = null; }
  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.14;
    this.master.connect(this.ctx.destination);
  }
  note({ f = 440, f2 = null, dur = 0.08, type = 'square', gain = 0.5, delay = 0 }) {
    if (!this.on || !this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(30, f2), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  play(kind) {
    if (!this.on) return;
    this.ensure();
    if (!this.ctx) return;
    switch (kind) {
      case 'move': return this.note({ f: 320, dur: 0.03, type: 'square', gain: 0.16 });
      case 'rotate': return this.note({ f: 520, f2: 700, dur: 0.05, type: 'square', gain: 0.2 });
      case 'hold': return this.note({ f: 420, f2: 300, dur: 0.09, type: 'triangle', gain: 0.28 });
      case 'lock': return this.note({ f: 150, f2: 90, dur: 0.08, type: 'triangle', gain: 0.34 });
      case 'drop': return this.note({ f: 210, f2: 70, dur: 0.09, type: 'sawtooth', gain: 0.26 });
      case 'clear': return [523, 659, 784].forEach((f, i) => this.note({ f, dur: 0.14, type: 'triangle', gain: 0.3, delay: i * 0.045 }));
      case 'tetris': return [392, 523, 659, 784, 1046].forEach((f, i) => this.note({ f, dur: 0.26, type: 'square', gain: 0.26, delay: i * 0.05 }));
      case 'tspin': return [330, 466, 587, 880].forEach((f, i) => this.note({ f, dur: 0.22, type: 'sawtooth', gain: 0.2, delay: i * 0.04 }));
      case 'level': return [523, 659, 784, 1046, 1318].forEach((f, i) => this.note({ f, dur: 0.2, type: 'sine', gain: 0.3, delay: i * 0.06 }));
      case 'over': return [330, 262, 208, 165].forEach((f, i) => this.note({ f, dur: 0.4, type: 'sawtooth', gain: 0.26, delay: i * 0.14 }));
    }
  }
}
const sfx = new Sfx();

// ---------------------------------------------------------------------- state
const BEST_KEY = 'neon-tetris.best';
const ui = {
  mode: 'local',                 // 'local' | 'remote'
  phase: 'ready',                // 'ready' | 'playing' | 'paused' | 'over'
  difficulty: params.get('difficulty') || 'hard',
  turbo: false,
  remoteId: params.get('game'),
  remoteCursor: 0,
  remoteState: null,
  startedAt: 0,
  displayScore: 0,
  best: Number(localStorage.getItem(BEST_KEY) || 0),
  apiOnline: false,
};

let game = new Game({ seed: params.get('seed') || undefined, gravity: true });
let state = game.state();

const renderer = new Renderer(el.board);
const backdrop = new Backdrop(el.bg);

// ------------------------------------------------------------------ autopilot
const pilot = {
  on: params.get('auto') === '1',
  queue: [],
  timer: 0,
  thinking: false,
  lastDecision: null,
};

function pilotCadence() { return ui.turbo ? 0.009 : 0.042; }
function pilotMaxPerFrame() { return ui.turbo ? 3 : 1; }

function updatePilot(dt) {
  if (!pilot.on || ui.phase !== 'playing' || ui.mode !== 'local') return;
  if (!pilot.queue.length && state.active && !state.over) {
    const p = plan(game, { difficulty: ui.difficulty });
    if (p) {
      pilot.queue = p.actions;
      pilot.lastDecision = p;
      el.decision.innerHTML = `<span class="k">${p.piece}</span> → col ${p.col}`
        + `${p.useHold ? ' · <span class="k">hold</span>' : ''}`
        + `${p.label ? ` · <span class="k">${p.label}</span>` : ''}`
        + `${p.blundered ? ' · <span class="k">blunder</span>' : ''}`
        + `<br>${p.moves.join(' ')}`;
    }
  }
  pilot.timer += dt;
  const cadence = pilotCadence();
  let n = 0;
  while (pilot.timer >= cadence && pilot.queue.length && n < pilotMaxPerFrame()) {
    applyAction(pilot.queue.shift());
    pilot.timer -= cadence;
    n++;
  }
  if (pilot.timer > 0.25) pilot.timer = 0;
}

// ----------------------------------------------------------------- game state
function activeState() { return ui.mode === 'remote' ? ui.remoteState : state; }

function applyAction(action) {
  if (ui.mode === 'remote') { queueRemote(action); return false; }
  const ok = game.apply(action);
  if (ok) ui.startedAt ||= performance.now();
  return ok;
}

function newGame() {
  if (ui.mode === 'remote') { detachRemote(); return; }
  const seed = params.get('seed') ?? Math.random().toString(36).slice(2, 9);
  game.reset({ seed, startLevel: 1 });
  game.options.gravity = !pilot.on;
  state = game.state();
  renderer.syncBoard(state.board);
  renderer.clearEffects();
  ui.phase = 'playing';
  ui.displayScore = 0;
  ui.startedAt = performance.now();
  pilot.queue = [];
  el.chipSeed.textContent = `seed ${seed}`;
  hideOverlay();
}

function setPhase(next) {
  ui.phase = next;
  if (next === 'playing') hideOverlay();
  else showOverlay();
  el.btnPause.textContent = next === 'paused' ? 'Resume' : 'Pause';
}

function togglePause() {
  if (ui.mode === 'remote' || ui.phase === 'ready' || ui.phase === 'over') return;
  setPhase(ui.phase === 'playing' ? 'paused' : 'playing');
}

// -------------------------------------------------------------------- overlay
function showOverlay() {
  const ready = ui.phase === 'ready';
  const over = ui.phase === 'over';
  const paused = ui.phase === 'paused';
  el.overlay.hidden = false;
  el.ovTitle.innerHTML = over ? 'GAME <i>OVER</i>' : paused ? 'PAUSED' : 'NEON <i>TETRIS</i>';
  el.ovPrimary.textContent = ready ? 'Start game' : over ? 'Play again' : 'Resume';
  el.ovSecondary.textContent = pilot.on ? 'Take control' : 'Let the AI play';
  el.ovSecondary.hidden = ui.mode === 'remote';
  el.ovHint.innerHTML = ui.mode === 'remote'
    ? 'watching a game driven by the <b>REST API</b> — this board is someone else’s move stream'
    : ready ? 'or press <kbd>Enter</kbd>' : 'press <kbd>p</kbd> to resume';

  if (over) {
    const s = activeState() ?? game.state();
    const mins = Math.max(0.001, (ui.startedAt ? (performance.now() - ui.startedAt) : 0) / 60000);
    el.ovSub.textContent = s.overReason
      ? (s.overReason === 'lockout' ? 'Locked out above the well' : 'The stack reached the top')
      : '';
    el.ovStats.hidden = false;
    el.ovStats.innerHTML = [
      ['Score', s.score.toLocaleString()],
      ['Lines', s.lines],
      ['Level', s.level],
      ['Pieces', s.stats.pieces],
      ['Tetrises', s.stats.tetrises],
      ['T-spins', s.stats.tspins],
      ['Max combo', Math.max(0, s.stats.maxCombo)],
      ['Perfect clears', s.stats.perfectClears],
      ['PPM', (s.stats.pieces / mins).toFixed(2)],
      ['Best', Math.max(ui.best, s.score).toLocaleString()],
    ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  } else {
    el.ovStats.hidden = true;
    if (ready) {
      el.ovSub.textContent = `${COLS} × ${VISIBLE_ROWS} · SRS wall kicks · T-spins · combos · perfect clears`;
    } else if (paused) {
      el.ovSub.textContent = `${state.score.toLocaleString()} pts · ${state.lines} lines · level ${state.level}`;
    }
  }
}
function hideOverlay() { el.overlay.hidden = true; }

// ------------------------------------------------------------------ input
const held = { dir: 0, soft: false, timer: 0 };
const DAS = 0.135, ARR = 0.033, SOFT_ARR = 0.032;

function inputAction(action) {
  if (ui.phase === 'ready' || ui.phase === 'over') return;
  if (ui.mode === 'remote' || ui.phase !== 'playing') { if (action === 'hard_drop' || action.startsWith('rotate') || action === 'hold') { /* allow during pause in remote? no */ } }
  if (ui.phase !== 'playing') return;
  const ok = applyAction(action);
  if (ok) {
    if (action === 'left' || action === 'right') sfx.play('move');
    else if (action.startsWith('rotate')) sfx.play('rotate');
    else if (action === 'hold') sfx.play('hold');
    else if (action === 'hard_drop') sfx.play('drop');
    if (pilot.on && ['left', 'right', 'rotate_cw', 'rotate_ccw', 'rotate_180', 'hard_drop', 'hold'].includes(action)) {
      // a human touched the controls: hand the wheel back
      setPilot(false);
    }
  }
  return ok;
}

const KEYMAP = {
  ArrowLeft: 'left', KeyRight: 'right', ArrowRight: 'right',
  ArrowUp: 'rotate_cw', KeyX: 'rotate_cw', KeyU: 'rotate_cw',
  KeyZ: 'rotate_ccw', KeyI: 'rotate_ccw',
  ArrowDown: 'soft_drop',
  Space: 'hard_drop',
  KeyC: 'hold', ShiftLeft: 'hold', ShiftRight: 'hold',
};

addEventListener('keydown', (e) => {
  if (e.repeat && !(e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'ArrowDown')) return;
  const act = KEYMAP[e.code];
  if (act) {
    e.preventDefault();
    sfx.ensure();
    if (ui.phase === 'ready' || ui.phase === 'over') { newGame(); return; }
    if (act === 'left') { held.dir = -1; held.timer = 0; }
    if (act === 'right') { held.dir = 1; held.timer = 0; }
    if (act === 'soft_drop') { held.soft = true; held.timer = 0; }
    inputAction(act);
    return;
  }
  switch (e.code) {
    case 'Enter':
      e.preventDefault();
      if (ui.phase === 'ready' || ui.phase === 'over') newGame(); else togglePause();
      break;
    case 'Escape': case 'KeyP': e.preventDefault(); togglePause(); break;
    case 'KeyR': e.preventDefault(); newGame(); break;
    case 'KeyA': e.preventDefault(); setPilot(!pilot.on); break;
    case 'KeyT': e.preventDefault(); setTurbo(!ui.turbo); break;
    case 'KeyM': e.preventDefault(); setSound(!sfx.on); break;
    case 'KeyH': e.preventDefault(); toggleHelp(); break;
  }
});
addEventListener('keyup', (e) => {
  const act = KEYMAP[e.code];
  if (act === 'left' && held.dir < 0) held.dir = 0;
  if (act === 'right' && held.dir > 0) held.dir = 0;
  if (act === 'soft_drop') held.soft = false;
});

function updateHeld(dt) {
  if (ui.phase !== 'playing' || ui.mode !== 'local') return;
  held.timer += dt;
  const first = held.dir ? DAS : SOFT_ARR;
  while (held.timer >= (held.cadenced ? ARR : first)) {
    if (held.dir) { if (!applyAction(held.dir < 0 ? 'left' : 'right')) break; sfx.play('move'); }
    else if (held.soft) { if (!applyAction('soft_drop')) break; }
    held.timer -= held.cadenced ? ARR : first;
    held.cadenced = true;
  }
}

el.touch.addEventListener?.('pointerdown', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();
  if (ui.phase === 'ready' || ui.phase === 'over') { newGame(); return; }
  inputAction(b.dataset.act);
});

// ------------------------------------------------------------------ toggles
function setPilot(on) {
  pilot.on = on;
  pilot.queue = [];
  if (ui.mode === 'local') game.options.gravity = !on;
  el.btnAi.querySelector('b').textContent = on ? 'on' : 'off';
  el.chipAi.hidden = !on;
  if (on && ui.phase === 'ready') newGame();
  if (on && ui.phase === 'playing') hideOverlay();
  if (!on) el.decision.textContent = 'manual control';
}
function setTurbo(on) {
  ui.turbo = on;
  el.btnTurbo.querySelector('b').textContent = on ? 'on' : 'off';
  if (on && !pilot.on) setPilot(true);
}
function setSound(on) {
  sfx.ensure();
  sfx.on = on && !!sfx.ctx;
  el.btnSound.querySelector('b').textContent = sfx.on ? 'on' : 'off';
}
function toggleHelp() {
  if (ui.phase === 'playing') setPhase('paused');
  else if (ui.phase === 'paused') setPhase('playing');
}

el.btnAi.onclick = () => setPilot(!pilot.on);
el.btnTurbo.onclick = () => setTurbo(!ui.turbo);
el.btnSound.onclick = () => setSound(!sfx.on);
el.btnPause.onclick = () => togglePause();
el.btnRestart.onclick = () => newGame();
el.ovPrimary.onclick = () => {
  if (ui.phase === 'ready' || ui.phase === 'over') newGame();
  else if (ui.phase === 'paused') setPhase('playing');
};
el.ovSecondary.onclick = () => { setPilot(!pilot.on); if (ui.phase === 'ready' || ui.phase === 'over') newGame(); };
el.difficulty.onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  ui.difficulty = b.dataset.diff;
  [...el.difficulty.children].forEach((c) => c.classList.toggle('on', c === b));
  if (pilot.on) pilot.queue = [];
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden && ui.phase === 'playing') setPhase('paused');
});

// ------------------------------------------------------------------ REST API
const remoteQueue = [];
let remoteBusy = false;
let remoteTimer = null;

function queueRemote(action) {
  remoteQueue.push(action);
  if (remoteQueue.length > 40) remoteQueue.shift();
  flushRemote();
}

async function flushRemote() {
  if (remoteBusy || !ui.remoteId || !remoteQueue.length) return;
  remoteBusy = true;
  const actions = remoteQueue.splice(0, remoteQueue.length);
  try {
    const r = await fetch(`/api/games/${ui.remoteId}/actions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actions }),
    });
    if (r.ok) applyRemote(await r.json());
  } catch { /* the poll loop will recover */ }
  remoteBusy = false;
}

function applyRemote(j) {
  if (j.seed) el.chipSeed.textContent = `seed ${j.seed}`;
  if (j.events?.length) { renderer.pushEvents(j.events, j); logEvents(j.events); }
  ui.remoteCursor = j.eventCursor ?? ui.remoteCursor;
  if (j.board && !renderer.clearing.length) {
    // keep the visual board authoritative only while it agrees with the server
    let mismatch = false;
    for (let y = 0; y < j.board.length && !mismatch; y++) {
      for (let x = 0; x < COLS; x++) if ((renderer.ids[y]?.[x] ?? 0) !== (j.board[y]?.[x] ?? 0)) { mismatch = true; break; }
    }
    if (mismatch && !renderer.pendingResync) renderer.syncBoard(j.board);
  }
  ui.remoteState = j;
  if (j.over && ui.phase !== 'over') setPhase('over');
}

async function pollRemote() {
  if (ui.mode !== 'remote' || !ui.remoteId) return;
  try {
    const r = await fetch(`/api/games/${ui.remoteId}?since=${ui.remoteCursor}`, { cache: 'no-store' });
    if (r.status === 404) { el.chipMode.textContent = 'GAME GONE'; return; }
    applyRemote(await r.json());
  } catch { /* transient */ }
}

function attachRemote(id) {
  ui.mode = 'remote';
  ui.remoteId = id;
  ui.remoteCursor = 0;
  ui.remoteState = null;
  pilot.queue = [];
  el.chipMode.textContent = 'REMOTE · API';
  el.btnRemote.querySelector?.('b')?.remove();
  el.btnRemote.textContent = 'Back to local game';
  fetch(`/api/games/${id}`).then((r) => r.ok ? r.json() : Promise.reject()).then((j) => {
    renderer.syncBoard(j.board);
    renderer.clearEffects();
    applyRemote(j);
    ui.phase = 'playing';
    hideOverlay();
  }).catch(() => { el.chipMode.textContent = 'GAME GONE'; showOverlay(); });
  if (remoteTimer) clearInterval(remoteTimer);
  remoteTimer = setInterval(() => { pollRemote(); flushRemote(); }, 28);
}

function detachRemote() {
  ui.mode = 'local';
  ui.remoteId = null;
  ui.remoteState = null;
  if (remoteTimer) clearInterval(remoteTimer);
  remoteTimer = null;
  el.chipMode.textContent = 'LOCAL';
  el.btnRemote.textContent = 'Watch API game';
  ui.phase = 'ready';
  showOverlay();
}

el.btnRemote.onclick = async () => {
  if (ui.mode === 'remote') return detachRemote();
  if (!HAS_API) return alert('Open this page through the API server (npm start) to watch API-driven games.');
  const r = await fetch('/api/games', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client: 'browser', seed: Math.random().toString(36).slice(2, 9) }) });
  const j = await r.json();
  history.replaceState(null, '', `?game=${j.id}`);
  attachRemote(j.id);
};

// ------------------------------------------------------------------ feed/UX
function logEvents(events) {
  for (const ev of events) {
    if (ev.type === 'clear') {
      addFeed(`${ev.spin ? 'T-SPIN ' : ''}${ev.label?.replace(/^\d+X COMBO · B2B |B2B /, '') ?? 'CLEAR'} · +${ev.gained.toLocaleString()}`);
      backdrop.kick(ev.count >= 3 ? 1.3 : 0.6);
    } else if (ev.type === 'level_up') {
      addFeed(`LEVEL ${ev.level}`);
      backdrop.kick(1.1);
    } else if (ev.type === 'game_over') {
      addFeed(`GAME OVER — ${ev.reason}`);
      if (ui.mode === 'local') {
        const s = game.state();
        if (s.score > ui.best) { ui.best = s.score; localStorage.setItem(BEST_KEY, String(s.score)); }
        setPhase('over');
      }
    }
  }
}

function addFeed(text) {
  const div = document.createElement('div');
  div.textContent = text;
  el.feed.prepend(div);
  while (el.feed.children.length > 6) el.feed.lastChild.remove();
}

let lastQueueKey = '';
let lastHold = null;
function syncPanels() {
  const s = activeState();
  if (!s) return;

  // score counts up smoothly toward the real value
  const target = s.score ?? 0;
  ui.displayScore += (target - ui.displayScore) * 0.18;
  if (Math.abs(target - ui.displayScore) < 1) ui.displayScore = target;
  el.score.textContent = Math.round(ui.displayScore).toLocaleString();
  el.lines.textContent = s.lines ?? 0;
  el.level.textContent = s.level ?? 1;
  el.pieces.textContent = s.pieces ?? 0;
  el.combo.textContent = s.combo > 0 ? `${s.combo}×` : '—';
  el.b2b.textContent = s.backToBack > 1 ? `${s.backToBack}×` : s.backToBack === 1 ? 'ready' : '—';
  el.tetrises.textContent = s.stats?.tetrises ?? 0;
  el.tspins.textContent = s.stats?.tspins ?? 0;
  el.best.textContent = Math.max(ui.best, target).toLocaleString();
  const mins = ui.startedAt ? Math.max(0.02, (performance.now() - ui.startedAt) / 60000) : 1;
  el.ppm.textContent = ((s.pieces ?? 0) / mins).toFixed(2);
  el.apm.textContent = ((s.actions ?? 0) / mins).toFixed(2);

  const queueKey = (s.queue ?? []).join('') + '|' + (s.hold ?? '-') + '|' + (s.canHold ?? true);
  if (queueKey !== lastQueueKey) {
    lastQueueKey = queueKey;
    (s.queue ?? []).slice(0, QUEUE_PREVIEW).forEach((name, i) => {
      const cv = nextCanvases[i];
      if (cv) renderMiniPiece(cv, name);
    });
    const holdName = s.hold;
    renderMiniPiece(el.hold, holdName, { dim: s.canHold === false });
    lastHold = holdName;
  }
}

function toggleHelpPanel() { /* reserved */ }

// ------------------------------------------------------------------- resize
function resize() {
  renderer.resize();
  backdrop.resize();
  lastQueueKey = '';
}
addEventListener('resize', resize);
addEventListener('orientationchange', () => setTimeout(resize, 120));

// --------------------------------------------------------------------- boot
async function boot() {
  resize();
  el.chipSeed.textContent = `seed ${game.seed}`;
  renderer.syncBoard(state.board);
  showOverlay();

  el.btnSound.querySelector('b').textContent = 'off';
  if (HAS_API) {
    try {
      const r = await fetch('/api/health');
      const j = await r.json();
      ui.apiOnline = !!j.ok;
      el.apiSnippet.innerHTML = `POST /api/games\nGET  /api/games/&lt;id&gt;\nPOST /api/games/&lt;id&gt;/actions\nPOST /api/games/&lt;id&gt;/hint`;
    } catch { ui.apiOnline = false; }
  }
  if (!ui.apiOnline) {
    el.apiSnippet.textContent = 'start the API server:\n\n  npm start\n  → http://localhost:8787';
  }
  el.copyApi.onclick = async () => {
    const origin = location.origin.startsWith('http') ? location.origin : 'http://localhost:8787';
    const curl = [
      `ID=$(curl -s ${origin}/api/games -X POST -d '{"seed":"demo"}' | jq -r .id)`,
      `curl -s "${origin}/api/games/$ID"                      # read the board`,
      `curl -s "${origin}/api/games/$ID/actions" -X POST \\`,
      `     -d '{"actions":["left","rotate_cw","hard_drop"]}'`,
      `# then open ${origin}/?game=$ID to watch it live`,
    ].join('\n');
    try { await navigator.clipboard.writeText(curl); el.copyApi.textContent = 'Copied ✓'; setTimeout(() => (el.copyApi.textContent = 'Copy curl'), 1600); }
    catch { /* clipboard blocked */ }
  };

  const diff = DIFFICULTY[ui.difficulty] ? ui.difficulty : 'hard';
  ui.difficulty = diff;
  [...el.difficulty.children].forEach((c) => c.classList.toggle('on', c.dataset.diff === diff));

  if (params.get('turbo') === '1') setTurbo(true);
  if (params.get('sound') === '1') setSound(true);
  if (params.get('game')) attachRemote(params.get('game'));
  else if (pilot.on) { setPilot(true); newGame(); }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (ui.mode === 'local') {
      updateHeld(dt);
      updatePilot(dt);
      if (ui.phase === 'playing' && !pilot.on) game.tick(dt * 1000);
      const events = game.drainEvents();
      if (events.length) { renderer.pushEvents(events, state); logEvents(events); }
      state = game.state();
      if (state.over && ui.phase === 'playing') setPhase('over');
    }
    const s = activeState();
    renderer.update(dt, s);
    renderer.draw(s);
    backdrop.update(dt);
    backdrop.draw();
    syncPanels();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// In-page API. The HTTP REST API is for agents outside the browser; this is the
// same surface for agents that already live in the page context (CDP/Playwright
// drivers, eval-based agents, tests). `window.TETRIS.state()` returns exactly
// the JSON that `GET /api/games/:id` returns.
// ---------------------------------------------------------------------------
window.TETRIS = {
  version: '1.0.0',
  actions: ['left', 'right', 'rotate_cw', 'rotate_ccw', 'rotate_180', 'soft_drop', 'hard_drop', 'hold'],
  difficulties: Object.keys(DIFFICULTY),
  /** Current position: board (numeric + ascii), active piece, queue, hold, score. */
  state: () => structuredClone(activeState() ?? state),
  /** Board as rows of characters, 'I O T S Z J L' or '.' — LLM-friendly. */
  ascii: () => (activeState() ?? state).ascii,
  /** Legal action names right now. */
  legal: () => (activeState() ?? state).legalActions ?? [],
  /** Apply actions immediately (no animation delay). Returns per-action results. */
  play(actions) {
    const list = Array.isArray(actions) ? actions : [actions];
    const out = [];
    for (const a of list) {
      if (ui.mode === 'remote') { applyAction(a); out.push({ action: a, applied: true, queued: true }); continue; }
      const ok = game.apply(a);
      out.push({ action: a, applied: ok });
      if (ok && ui.phase === 'playing') { const ev = game.drainEvents(); if (ev.length) { renderer.pushEvents(ev, state); logEvents(ev); } state = game.state(); }
    }
    return out;
  },
  /** Start a new game: TETRIS.reset({seed, level}). */
  reset(opts = {}) {
    if (ui.mode === 'remote') detachRemote();
    const seed = opts.seed ?? Math.random().toString(36).slice(2, 9);
    game.reset({ seed, startLevel: opts.level ?? 1 });
    game.options.gravity = !pilot.on;
    state = game.state();
    renderer.syncBoard(state.board);
    renderer.clearEffects();
    pilot.queue = [];
    ui.displayScore = 0;
    ui.startedAt = performance.now();
    ui.phase = 'playing';
    el.chipSeed.textContent = `seed ${seed}`;
    hideOverlay();
    return { seed, state: structuredClone(state) };
  },
  /** Ask the built-in engine what it would do. */
  hint: (difficulty = ui.difficulty) => { const p = plan(game, { difficulty }); return p ? { actions: p.actions, decision: { piece: p.piece, col: p.col, rotation: p.rotation, useHold: p.useHold, label: p.label }, ranked: p.ranked } : null; },
  /** Every legal landing spot for the piece in hand. */
  candidates: () => game.placements(),
  /** Toggle the autopilot / turbo / pause. */
  setAuto: (on = true) => setPilot(!!on),
  setTurbo: (on = true) => setTurbo(!!on),
  setDifficulty: (d) => { if (DIFFICULTY[d]) { ui.difficulty = d; [...el.difficulty.children].forEach((c) => c.classList.toggle('on', c.dataset.diff === d)); } return ui.difficulty; },
  pause: () => togglePause(),
  /** Attach to a server-side game so an external AI's moves render here. */
  watch: (id) => attachRemote(id),
  /** Live game object, for experiments and tests. */
  get game() { return game; },
  get mode() { return ui.mode; },
  get phase() { return ui.phase; },
};

boot();
