/**
 * Agent tests: `node test/agents.test.js`
 *
 * The two CLI agents (tools/jev-play.js, tools/llm-play.js) are driven against
 * the real game server with the model endpoint stubbed — no API key, no
 * network. What matters here is the contract around the model: the questions
 * we build, the checks we run on the answer before touching the game, and the
 * fallbacks when the answer is unusable.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { ApiClient } from '../tools/api-play.js';
import {
  visibleRows, stackStats, describeOption, orderCandidates, buildRequest, decide, askJev, playGame as jevGame,
} from '../tools/jev-play.js';
import {
  extractJson, sanitizeReply, scrapeActions, buildUserMessage, playGame as llmGame,
} from '../tools/llm-play.js';

const PORT = 8841 + Math.floor(Math.random() * 60);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0; let fail = 0; const failures = [];
const ok = (n, c, d = '') => c ? pass++ : (fail++, failures.push(`${n}${d ? ' — ' + d : ''}`));

const srv = spawn(process.execPath, ['server.js', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
let srvOut = '';
srv.stdout.on('data', (d) => { srvOut += d; });
srv.stderr.on('data', (d) => { srvOut += d; });

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// ---------------------------------------------------------------- fixtures

const rows = (spec) => {
  const grid = Array.from({ length: 20 }, () => '..........');
  for (const [y, line] of Object.entries(spec)) grid[Number(y)] = line;
  return grid;
};

const JEV_OK = (answers) => ({ model: 'jev-stub', answers, usage: { input_tokens: 500, output_tokens: 40 } });

if (!await waitUp()) {
  console.log('\n  agents: server never came up\n' + srvOut);
  process.exit(1);
}

const api = new ApiClient(BASE);

// ------------------------------------------------------- stack measurement

{
  // col 5 has a block at rows 16 and 18 with a gap between: one covered hole.
  const s = stackStats(rows({ 16: '.....#....', 18: '.....#....', 19: '###.......' }));
  ok('height measured from the floor', s.heights[0] === 1 && s.heights[5] === 4, JSON.stringify(s.heights));
  ok('maxHeight is the tallest column', s.maxHeight === 4);
  ok('covered hole counted, open space above is not', s.holes === 1, `holes=${s.holes}`);
  ok('aggregate height sums the columns', s.aggHeight === 7, `agg=${s.aggHeight}`);
}
{
  // Left edge well: cols 1..9 filled three high, column 0 empty.
  const s = stackStats(rows({ 17: '.#########', 18: '.#########', 19: '.#########' }));
  ok('edge well detected at column 0', s.wellCol === 0 && s.wellDepth === 3, JSON.stringify({ c: s.wellCol, d: s.wellDepth }));
}
{
  const s = stackStats(rows({ 19: '##########' }));
  ok('flat full floor has no well', s.wellDepth === 0 && s.holes === 0 && s.bumpiness === 0);
}
{
  const numeric = Array.from({ length: 24 }, (_, i) => Array.from({ length: 10 }, () => (i === 23 ? 1 : 0)));
  const v = visibleRows(numeric);
  ok('24-row numeric grid -> 20 visible rows', v.length === 20 && v.at(-1) === '##########' && v[0] === '..........');
}

// ---------------------------------------------------------- request building

const state = await api.create({ seed: 'agenttest', client: 'agents' });
const gameId = state.id;
const { candidates } = await api.candidates(gameId);
const legal = orderCandidates(candidates.filter((c) => !c.over));

{
  const body = buildRequest(state, legal);
  const keys = Object.keys(body.questions.move.criteria);
  ok('every legal landing becomes an option', keys.length === legal.length, `${keys.length} vs ${legal.length}`);
  ok('option ids are c0..cN in neutral order', keys[0] === 'c0' && keys.at(-1) === `c${legal.length - 1}`);
  const cols = legal.map((c) => c.col);
  ok('options are ordered by column, not by engine rank', JSON.stringify(cols) === JSON.stringify([...cols].sort((a, b) => a - b)), cols.join(','));
  const desc = body.questions.move.criteria.c0;
  ok('option text is factual and spatial', /column -?\d+/.test(desc) && /clears/.test(desc) && /stack height/.test(desc), desc);
  ok('state carries the well as text, not as a board to count', typeof body.state.board === 'string' && body.state.board.split('\n').length === 20);
  ok('state pre-computes what Jev must not arithmetic on', body.state.stack && Array.isArray(body.state.stack.columnHeights));
  ok('risk question is a 4-level rubric', body.questions.risk.type === 'score' && body.questions.risk.criteria.length === 4);
  ok('hold question only offered when hold is available', body.questions.hold === undefined || (state.canHold && state.hold));
  ok('no engine score leaks into the prompt', !JSON.stringify(body).includes('scoreGain'));
}

{
  // An option id must mean the same landing on both sides of the round trip.
  const body = buildRequest(state, legal);
  const target = legal.length > 3 ? legal[3] : legal[0];
  const key = Object.keys(body.questions.move.criteria)
    .find((k) => body.questions.move.criteria[k] === describeOption(stackStats(visibleRows(state.board)), target));
  const d = decide({ move: { type: 'choice', choice: key, confidence: 0.9, probabilities: {} }, risk: { score: 0.5 } }, legal);
  ok('option id round-trips to the same landing', d.kind === 'candidate' && d.candidate.col === target.col && d.candidate.rotation === target.rotation,
    `${key} -> ${d.candidate?.col}/${d.candidate?.rotation} expected ${target.col}/${target.rotation}`);
}

// -------------------------------------------------------------- decide()

const fakeCands = [
  { col: 0, rotation: 0, linesCleared: 0, label: null, ascii: rows({ 19: '##########' }).join('\n'), actions: ['hard_drop'], over: false },
  { col: 4, rotation: 1, linesCleared: 4, label: 'TETRIS', ascii: rows({}).join('\n'), actions: ['left', 'hard_drop'], over: false },
  { col: 9, rotation: 0, linesCleared: 0, label: null, ascii: rows({}).join('\n'), actions: ['right', 'hard_drop'], over: true },
];

{
  const good = decide({ move: { type: 'choice', choice: 'c1', confidence: 0.8, probabilities: {} }, risk: { score: 0.4 } }, fakeCands);
  ok('confident pick is executed', good.kind === 'candidate' && good.candidate.col === 4 && good.actions.join() === 'left,hard_drop');
  ok('low confidence defers to the engine', decide({ move: { type: 'choice', choice: 'c1', confidence: 0.2 }, risk: { score: 0.4 } }, fakeCands).kind === 'engine');
  ok('unknown option defers to the engine', decide({ move: { type: 'choice', choice: 'c99', confidence: 0.99 }, risk: {} }, fakeCands).kind === 'engine');
  ok('missing answer defers to the engine', decide({}, fakeCands).kind === 'engine');
  ok('a landing that ends the game is never executed', decide({ move: { type: 'choice', choice: 'c2', confidence: 0.99 }, risk: {} }, fakeCands).kind === 'engine');

  const risky = { move: { type: 'choice', choice: 'c1', confidence: 0.45 }, risk: { score: 3.2 } };
  ok('a dangerous stack raises the confidence bar', decide(risky, fakeCands).kind === 'engine');
  ok('the same answer is fine when the well is comfortable', decide({ ...risky, risk: { score: 0.2 } }, fakeCands).kind === 'candidate');

  const hold = { move: { type: 'choice', choice: 'c1', confidence: 0.9 }, risk: { score: 0.1 }, hold: { type: 'noul', noul: 0.8 } };
  ok('a strong noul spends the hold instead', decide(hold, fakeCands).kind === 'hold');
  ok('a weak noul does not', decide({ ...hold, hold: { type: 'noul', noul: 0.3 } }, fakeCands).kind === 'candidate');
  ok('thresholds are tunable', decide(hold, fakeCands, { holdThreshold: 0.9 }).kind === 'candidate');
}

// ------------------------------------------------------------- Jev E2E loop

{
  // Stub model: always take the option that clears lines, else c0.
  const calls = [];
  const stubJev = async (body) => {
    calls.push(body);
    const crit = body.questions.move.criteria;
    const key = Object.keys(crit).find((k) => /clears [1-9]/.test(crit[k])) ?? Object.keys(crit)[0];
    const answers = {
      move: { type: 'choice', choice: key, confidence: 0.85, probabilities: { [key]: 0.85 } },
      risk: { type: 'score', score: 0.5, confidence: 0.7 },
    };
    if (body.questions.hold) answers.hold = { type: 'noul', noul: 0.1 };
    return JEV_OK(answers);
  };

  const quiet = () => {};
  const tally = await jevGame({ api: new ApiClient(BASE), jev: stubJev, seed: 'jev-e2e', pieces: 25, log: quiet });
  ok('jev agent plays pieces', tally.pieces >= 20, `pieces=${tally.pieces}`);
  ok('every move went through the model', tally.fromJev + tally.fromCode === tally.pieces, JSON.stringify({ j: tally.fromJev, c: tally.fromCode }));
  ok('no engine fallback needed when answers are confident', tally.fromEngine === 0);
  ok('usage is billed per call', tally.calls === calls.length && tally.inputTokens === calls.length * 500, `${tally.calls}/${calls.length}`);
  ok('cost is estimated from input tokens only', tally.costUsd > 0 && tally.costUsd < 0.001);
  ok('model id is recorded from the response', tally.model === 'jev-stub');
  ok('questions asked on every piece', calls.every((b) => b.questions.move && b.questions.risk));
}

{
  // Stub model: useless answers only -> the engine must carry the game.
  const tally = await jevGame({
    api: new ApiClient(BASE), seed: 'jev-fallback', pieces: 12, log: () => {},
    jev: async () => JEV_OK({ move: { type: 'choice', choice: 'not-a-real-option', confidence: 0.9 }, risk: { score: 0 } }),
  });
  ok('nonsense answers fall back to the built-in engine', tally.fromEngine === tally.pieces && tally.pieces > 5, JSON.stringify({ e: tally.fromEngine, p: tally.pieces }));
}

// ------------------------------------------------------- transport + retry

{
  let hits = 0;
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits++;
      if (hits === 1) { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":"rate limited"}'); return; }
      const sent = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'jev-1.13.0',
        answers: Object.fromEntries(Object.entries(sent.questions).map(([id, q]) => [id, q.type === 'noul'
          ? { type: 'noul', noul: 0.7 } : { type: q.type, score: 1, choice: 'c0', confidence: 0.5 }])),
        usage: { input_tokens: 12, output_tokens: 3 },
      }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${stub.address().port}/v1/systemone`;
  const answer = await askJev({ model: 'jev-1.13.0', state: 'x', questions: { a: { type: 'noul', instructions: 'is x' } } }, { apiKey: 'k', url, attempts: 3 });
  stub.close();
  ok('429 is retried, not fatal', hits === 2 && answer.model === 'jev-1.13.0', `hits=${hits}`);
  ok('answers come back keyed as sent', answer.answers.a.noul === 0.7);
}

// ------------------------------------------------------------- chat agents

{
  const fence = 'Sure!\n```json\n{"actions":["left","hard_drop"],"reason":"down well"}\n```\nHope that helps!';
  ok('json recovered from fenced prose', extractJson(fence)?.actions?.join() === 'left,hard_drop');
  ok('json recovered from trailing prose', extractJson('{"actions":["hold"],"reason":"x"} trailing words')?.actions?.[0] === 'hold');
  ok('prose with no json returns null', extractJson('I cannot play tetris sorry') === null);
  ok('actions scraped when the shape is ignored', scrapeActions('actions: ["left", "hard_drop"]').join() === 'left,hard_drop');

  const live = { legalActions: ['left', 'right', 'hard_drop'], canHold: false };
  ok('illegal and unknown actions are dropped', sanitizeReply({ actions: ['left', 'dance', 'up', 'DROP'] }, live).actions.join() === 'left,hard_drop');
  ok('hold refused when unavailable', sanitizeReply({ actions: ['hold', 'hard_drop'] }, live).actions.join() === 'hard_drop');
  ok('hard_drop appended so the piece always locks', sanitizeReply({ actions: ['left'] }, live).actions.join() === 'left,hard_drop');
  ok('garbage becomes an empty list', sanitizeReply({}, live).actions.length === 0);
  ok('runaway lists are capped', sanitizeReply({ actions: Array.from({ length: 400 }, () => 'left') }, live).actions.length <= 65);
  ok('user message tells the model what it must obey', /legalActions/.test(buildUserMessage({ ...live, ascii: 'x', active: null, queue: [], score: 0, lines: 0, level: 1, combo: 0, backToBack: 0 })));
}

{
  const stubChat = async () => ({ text: '{"actions":["hard_drop"],"reason":"drop"}', usage: { prompt_tokens: 300, completion_tokens: 20 }, model: 'stub-1' });
  const tally = await llmGame({ api: new ApiClient(BASE), chat: stubChat, seed: 'llm-e2e', pieces: 15, log: () => {} });
  // Dropping every piece straight down tops out, which is a valid outcome.
  ok('chat agent plays pieces', (tally.pieces === 15 || tally.over) && tally.fromModel === tally.pieces, JSON.stringify({ p: tally.pieces, m: tally.fromModel }));
  ok('no fallbacks for well-formed replies', tally.fromEngine === 0 && tally.badReplies === 0);
  ok('chat tokens are tallied', tally.calls === tally.pieces && tally.promptTokens === tally.calls * 300 && tally.model === 'stub-1', JSON.stringify({ c: tally.calls, t: tally.promptTokens }));
}

{
  const flaky = async (messages) => (messages.length > 2
    ? { text: '{"actions":["left","left","hard_drop"],"reason":"fixed"}', usage: {} }
    : { text: 'I would suggest dropping the piece.', usage: {} });
  const tally = await llmGame({ api: new ApiClient(BASE), chat: flaky, seed: 'llm-flaky', pieces: 8, log: () => {} });
  ok('one correction is offered before giving up', tally.badReplies === 8 && tally.pieces === 8, JSON.stringify({ b: tally.badReplies, p: tally.pieces }));
  ok('the game still advances once the model corrects itself', tally.fromModel === 8 && tally.fromEngine === 0, JSON.stringify({ m: tally.fromModel, e: tally.fromEngine }));

  const hopeless = async () => ({ text: 'nope', usage: {} });
  const t2 = await llmGame({ api: new ApiClient(BASE), chat: hopeless, seed: 'llm-hopeless', pieces: 6, log: () => {} });
  ok('a hopeless model never stalls the game', t2.pieces === 6 && t2.fromEngine === 6, JSON.stringify({ p: t2.pieces, e: t2.fromEngine }));
}

// ------------------------------------------------------------- outages

{
  let n = 0;
  const flakyJev = async (body) => {
    if (++n <= 2) throw new Error('jev 503: model_unavailable');
    const crit = body.questions.move.criteria;
    const key = Object.keys(crit).find((k) => /clears [1-9]/.test(crit[k])) ?? Object.keys(crit)[0];
    const answers = { move: { type: 'choice', choice: key, confidence: 0.8 }, risk: { type: 'score', score: 0.4 } };
    if (body.questions.hold) answers.hold = { type: 'noul', noul: 0.1 };
    return JEV_OK(answers);
  };
  const tally = await jevGame({ api: new ApiClient(BASE), jev: flakyJev, seed: 'jev-outage', pieces: 12, log: () => {} });
  ok('a 503 costs one piece, not the whole run', tally.providerErrors === 2 && tally.pieces >= 10, JSON.stringify({ e: tally.providerErrors, p: tally.pieces }));
  ok('outage pieces are credited to the engine', tally.fromEngine === 2 && tally.fromJev === tally.pieces - 2, JSON.stringify({ en: tally.fromEngine, j: tally.fromJev }));
  ok('an outage is not billed as a call', tally.calls === tally.pieces - 2);

  let err = null;
  await jevGame({ api: new ApiClient(BASE), seed: 'jev-dead', pieces: 60, log: () => {}, jev: async () => { throw new Error('model_unavailable'); } }).catch((e) => { err = e; });
  ok('a real outage stops rather than faking a model run', err && /consecutive provider failures/.test(err.message), String(err).slice(0, 80));
}

{
  let n = 0;
  const flakyChat = async () => {
    if (++n <= 2) throw new Error('ECONNRESET');
    return { text: '{"actions":["hard_drop"],"reason":"drop"}', usage: {} };
  };
  const tally = await llmGame({ api: new ApiClient(BASE), chat: flakyChat, seed: 'llm-outage', pieces: 10, log: () => {} });
  ok('chat agent survives an outage', tally.providerErrors === 2 && tally.pieces >= 8 && tally.fromEngine === 2, JSON.stringify({ e: tally.providerErrors, p: tally.pieces, en: tally.fromEngine }));

  let err = null;
  await llmGame({ api: new ApiClient(BASE), seed: 'llm-dead', pieces: 60, log: () => {}, chat: async () => { throw new Error('401 unauthorized'); } }).catch((e) => { err = e; });
  ok('a dead chat endpoint stops the run, loudly', err && /consecutive provider failures/.test(err.message), String(err).slice(0, 80));
}

// -------------------------------------------------------------- packaging

{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const [name, script] of Object.entries(pkg.scripts)) {
    for (const m of script.matchAll(/node\s+([\w./-]+)/g)) {
      ok(`npm run ${name} targets a real file`, existsSync(new URL(`../${m[1]}`, import.meta.url)), m[1]);
    }
  }
  ok('.env is ignored', readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').includes('.env'));
  ok('agents do not read secrets at module load', !readFileSync(new URL('../tools/jev-play.js', import.meta.url), 'utf8').includes('console.log(process.env'));
}

await api.close(gameId).catch(() => {});
srv.kill('SIGTERM');

console.log(`\n  agents: ${pass} passed, ${fail} failed`);
if (failures.length) {
  for (const f of failures) console.log(`   ✖ ${f}`);
  console.log(srvOut ? `\n  server output:\n${srvOut}` : '');
  process.exit(1);
}
