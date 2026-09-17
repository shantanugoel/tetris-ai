#!/usr/bin/env node
/**
 * llm-play — play Neon Tetris with any chat-completions model.
 *
 *   node server.js &
 *   OPENAI_MODEL=gpt-4o-mini        node tools/llm-play.js --seed demo
 *   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_MODEL=llama3.1 node tools/llm-play.js
 *   OPENAI_BASE_URL=https://openrouter.ai/api/v1 OPENAI_MODEL=... node tools/llm-play.js
 *
 * Speaks the OpenAI /chat/completions dialect, which OpenAI, OpenRouter, Groq,
 * Together, Fireworks, Mistral, vLLM, llama.cpp server, Ollama and LM Studio
 * all answer to. Point OPENAI_BASE_URL at the one you want.
 *
 * A chat model is a text generator, so everything around it is defensive:
 * the reply is scanned for JSON rather than trusted, every action is checked
 * against `legalActions`, a reply that fails to lock the piece is replaced by
 * the built-in engine's move, and the game never depends on the model being
 * well-behaved. `tools/jev-play.js` is the contrasting design: a decision
 * model that cannot return an invalid value in the first place.
 *
 * Flags:
 *   --seed s --level n --pieces N --url http://host:port
 *   --base-url https://api.openai.com/v1 --model gpt-4o-mini --api-key sk-...
 *   --temperature 0.2 --max-tokens 300 --no-json (skip response_format)
 *   --usd-per-mtok-in 0.15 --usd-per-mtok-out 0.6   (for the cost line)
 *   --delay ms --quiet --dry-run --no-engine-fallback
 */

import { pathToFileURL } from 'node:url';
import { loadEnv } from './env.js';
import { ApiClient } from './api-play.js';

loadEnv();

const DEFAULTS = {
  baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  pieces: 60,
  difficulty: 'hard',
  temperature: 0.2,
  maxTokens: 300,
  delay: 0,
  quiet: false,
  dryRun: false,
  engineFallback: true,
  jsonMode: true,
};

export const SYSTEM_PROMPT = `You play Tetris through an API. Each turn you are given the current state and you return the moves for the active piece.

Reading the board: "ascii" is the visible well, 10 columns by 20 rows, top row first. "." is empty, a letter is a settled block (the letter says which piece it came from), and the ACTIVE piece is overlaid on top using its own letter. Columns are numbered 0 (left) through 9 (right). "active.restRow" is the row the active piece will rest on if dropped where it is. "next" is the upcoming pieces.

Reply with JSON only, no prose: {"actions": ["left", "rotate_cw", "hard_drop"], "reason": "one short sentence"}
Every action must be one of the strings in "legalActions" for the current state. The list must be short and must end with "hard_drop" so the piece actually locks.

Strategy: keep the stack low and flat. Keep exactly one deep open well on the left or right edge so an I piece can clear four lines at once. Never leave a hole (an empty cell with a block above it) - a covered hole is worth more damage than any single line clear. Do not let the stack reach the top.
When you cannot see a good landing for the active piece, use "hold" once per piece.`;

export function buildUserMessage(state) {
  return JSON.stringify({
    ascii: state.ascii,
    active: state.active,
    next: state.queue,
    hold: state.hold,
    canHold: state.canHold,
    legalActions: state.legalActions,
    score: state.score,
    lines: state.lines,
    level: state.level,
    combo: state.combo,
    backToBack: state.backToBack,
  });
}

/** Find a JSON object in text that may be fenced, prefixed, or trailed by prose. */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const KNOWN = ['left', 'right', 'rotate_cw', 'rotate_ccw', 'rotate_180', 'soft_drop', 'hard_drop', 'hold'];

/**
 * Model output -> a safe action list. Unknown tokens are dropped, `hold` only
 * when legal, the list is capped, and a missing hard_drop is added so the
 * piece always locks (a piece that never locks would stall the loop forever).
 *
 * Deliberately NOT rescued: a reply with nothing usable in it comes back empty,
 * so the caller can tell "the model chose this" apart from "our code dropped a
 * hard_drop in", and hand the piece to the engine instead of taking credit.
 */
export function sanitizeReply(parsed, state) {
  const legal = new Set(state.legalActions);
  const raw = Array.isArray(parsed?.actions) ? parsed.actions : [];
  const actions = [];
  for (const token of raw) {
    const a = String(token).trim().toLowerCase().replace(/[^a-z_]/g, '');
    if (!KNOWN.includes(a) || !legal.has(a)) continue;
    actions.push(a);
    if (actions.length >= 64) break;
  }
  const reason = typeof parsed?.reason === 'string' ? parsed.reason : '';
  if (!actions.length) return { actions: [], reason };
  if (!actions.includes('hard_drop') && legal.has('hard_drop')) actions.push('hard_drop');
  return { actions: actions.slice(0, 65), reason };
}

/** Last-resort string scrape for models that ignore the JSON shape entirely. */
export function scrapeActions(text) {
  const m = /"actions"\s*:\s*\[([^\]]*)\]/.exec(text ?? '') ?? /\[([^\]]*)\]/.exec(text ?? '');
  if (!m) return [];
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

export async function chatCompletion(messages, opts = {}) {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set (put it in .env, or use --dry-run)');
  const base = String(opts.baseUrl ?? DEFAULTS.baseUrl).replace(/\/$/, '');
  const body = {
    model: opts.model ?? DEFAULTS.model,
    messages,
    temperature: opts.temperature ?? DEFAULTS.temperature,
    max_tokens: opts.maxTokens ?? DEFAULTS.maxTokens,
  };
  if (opts.jsonMode ?? DEFAULTS.jsonMode) body.response_format = { type: 'json_object' };

  const attempts = opts.attempts ?? 3;
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
    let res;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60000),
      });
    } catch (e) {
      lastErr = new Error(`request to ${base} failed: ${e.message}`);
      continue;
    }
    const json = await res.json().catch(() => null);
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`provider ${res.status}: ${JSON.stringify(json ?? {}).slice(0, 200)}`);
      continue;
    }
    if (!res.ok) {
      // Some providers reject response_format; try once more without it.
      if (res.status === 400 && body.response_format) { delete body.response_format; continue; }
      throw new Error(`provider ${res.status}: ${JSON.stringify(json ?? {}).slice(0, 300)}`);
    }
    const text = json?.choices?.[0]?.message?.content ?? '';
    return { text, usage: json?.usage ?? {}, model: json?.model ?? body.model };
  }
  throw lastErr ?? new Error('provider request failed');
}

// -------------------------------------------------------------------- player

/** Play one game. `chat` and `api` are injectable so tests can stub the model. */
export async function playGame(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const api = o.api ?? new ApiClient(o.url);
  const chat = o.chat ?? ((messages) => chatCompletion(messages, o));
  const log = o.log ?? ((line) => { if (!o.quiet) console.log(line); });

  const created = await api.create({ seed: o.seed, level: o.level, client: 'llm-play', difficulty: o.difficulty });
  const id = created.id;
  let cursor = created.eventCursor ?? 0;
  log(`game ${id} — watch live: ${o.url ?? 'http://127.0.0.1:8787'}/?game=${id}`);

  const tally = {
    game: id, seed: created.seed, pieces: 0, fromModel: 0, fromEngine: 0, badReplies: 0,
    calls: 0, promptTokens: 0, completionTokens: 0, model: o.model, latencyMs: 0,
    providerErrors: 0, consecutiveErrors: 0,
    lines: 0, score: 0, level: 1, stats: {}, over: false, overReason: null,
  };

  for (let n = 0; n < o.pieces; n++) {
    const state = await api.state(id, cursor);
    cursor = state.eventCursor;
    if (state.over) { Object.assign(tally, { over: true, overReason: state.overReason }); break; }

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(state) },
    ];
    if (o.dryRun) { console.log(JSON.stringify(messages, null, 2)); tally.dryRun = true; break; }

    // A provider outage is a bad turn, not a dead game: that piece goes to the
    // engine and play continues. Eight in a row is an outage rather than noise,
    // so we stop instead of reporting an engine run as a model run.
    const t0 = Date.now();
    let reply = null;
    try {
      reply = await chat(messages);
      tally.consecutiveErrors = 0;
    } catch (e) {
      tally.providerErrors++;
      if (++tally.consecutiveErrors >= 8) throw new Error(`${tally.consecutiveErrors} consecutive provider failures — ${e.message}`);
    }
    const latency = Date.now() - t0;
    if (reply) {
      tally.calls++;
      tally.latencyMs += latency;
      tally.model = reply.model ?? tally.model;
      tally.promptTokens += reply.usage?.prompt_tokens ?? 0;
      tally.completionTokens += reply.usage?.completion_tokens ?? 0;
    }

    let move = { actions: [], reason: '' };
    if (reply) {
      const parsed = extractJson(reply.text) ?? { actions: scrapeActions(reply.text), reason: '(scraped)' };
      move = sanitizeReply(parsed, state);

      if (!move.actions.length) {
        // Give it exactly one chance to fix itself, with the API's own complaint.
        tally.badReplies++;
        const retry = await chat([
          ...messages,
          { role: 'assistant', content: reply.text.slice(0, 500) },
          { role: 'user', content: `Invalid: "actions" must be a non-empty array of these strings only: ${state.legalActions.join(', ')}. Reply with JSON only.` },
        ]).catch(() => null);
        tally.calls++;
        if (retry) {
          tally.promptTokens += retry.usage?.prompt_tokens ?? 0;
          tally.completionTokens += retry.usage?.completion_tokens ?? 0;
          move = sanitizeReply(extractJson(retry.text) ?? { actions: scrapeActions(retry.text) }, state);
        }
      }
    }

    let source = 'model';
    let res = move.actions.length ? await api.actions(id, move.actions, cursor) : null;
    // If the model's reply did not lock the piece, do not let it stall the game.
    if (!res || res.pieces === state.pieces) {
      source = 'engine';
      if (move.actions.length) tally.badReplies++;
      if (!o.engineFallback) {
        res = await api.actions(id, ['hard_drop'], cursor);
      } else {
        const h = await api.hint(id, o.difficulty);
        res = await api.actions(id, h.actions, cursor);
      }
    }
    cursor = res.eventCursor;

    if (source === 'model') tally.fromModel++; else tally.fromEngine++;
    tally.pieces++;
    Object.assign(tally, { lines: res.lines, score: res.score, level: res.level, stats: res.stats });

    log(`  ${String(res.pieces).padStart(4)} ${state.active.name} → ${source === 'model' ? move.actions.join(' ') : 'engine fallback'}`
      + `${move.reason && source === 'model' ? `  "${move.reason.slice(0, 60)}"` : ''}`
      + `  ${reply ? `${latency}ms` : 'no call'}${res.rejected?.length ? `  REJECTED ${JSON.stringify(res.rejected)}` : ''}`);

    if (res.over) { Object.assign(tally, { over: true, overReason: res.overReason }); break; }
    if (o.delay) await new Promise((r) => setTimeout(r, o.delay));
  }

  const inPrice = Number(o.usdPerMtokIn ?? 0);
  const outPrice = Number(o.usdPerMtokOut ?? 0);
  tally.costUsd = (tally.promptTokens / 1e6) * inPrice + (tally.completionTokens / 1e6) * outPrice;
  tally.avgLatencyMs = tally.calls ? tally.latencyMs / tally.calls : 0;
  return tally;
}

export function formatTally(t) {
  const pct = t.pieces ? (100 * t.fromModel / t.pieces).toFixed(0) : '0';
  return [
    ``,
    `  ${t.over ? `game over (${t.overReason})` : 'still running'} after ${t.pieces} pieces`,
    `  score ${t.score}   lines ${t.lines}   level ${t.level}   tetrises ${t.stats.tetrises ?? 0}   t-spins ${t.stats.tspins ?? 0}`,
    `  decisions: ${t.fromModel} model (${pct}%)   ${t.fromEngine} engine fallback   ${t.badReplies} unusable replies`,
    `  ${t.calls} calls on ${t.model ?? '—'}   ${t.avgLatencyMs.toFixed(0)}ms avg   ${t.promptTokens} in / ${t.completionTokens} out tokens${t.costUsd ? `   ~$${t.costUsd.toFixed(5)}` : ''}${t.providerErrors ? `   ${t.providerErrors} provider errors` : ''}`,
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
    pieces: num(flags.pieces, DEFAULTS.pieces),
    difficulty: flags.difficulty ?? DEFAULTS.difficulty,
    url: flags.url,
    baseUrl: flags['base-url'] ?? DEFAULTS.baseUrl,
    model: flags.model ?? DEFAULTS.model,
    apiKey: flags['api-key'],
    temperature: num(flags.temperature, DEFAULTS.temperature),
    maxTokens: num(flags['max-tokens'], DEFAULTS.maxTokens),
    usdPerMtokIn: num(flags['usd-per-mtok-in'], 0),
    usdPerMtokOut: num(flags['usd-per-mtok-out'], 0),
    delay: num(flags.delay, 0),
    quiet: Boolean(flags.quiet),
    dryRun: Boolean(flags['dry-run']),
    jsonMode: flags.json !== true && flags['no-json'] !== true,
    engineFallback: flags['no-engine-fallback'] !== true,
  };

  const tally = await playGame(opts);
  tally.watchUrl = `${opts.url ?? 'http://127.0.0.1:8787'}/?game=${tally.game}`;
  if (opts.dryRun) return tally;
  console.log(formatTally(tally));
  if (!opts.quiet) console.log(`\n  replay:  node tools/api-play.js replay ${tally.game} --url ${opts.url ?? 'http://127.0.0.1:8787'}\n`);
  return tally;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
}
