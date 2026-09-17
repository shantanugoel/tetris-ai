# Neon Tetris + an AI API

A browser Tetris with a neon glass UI, a dependency-free engine, and a **REST API that
lets anything play it**: a built-in planning agent, [Jev](https://github.com/typesafeai/jev)
by TypeSafe AI, or any OpenAI-compatible chat model.

No build step, no dependencies, no framework. One file per layer; `npm test` covers all of it
(170 assertions, no network required).

```
node server.js          →  http://127.0.0.1:8787
```

---

## Why the API is the interesting part

The engine, the renderer and the UI are the ordinary part. The point of the API is that
**the player is pluggable**: the game exposes state as text, refuses illegal moves with a
reason, and records every event with a cursor — so an agent can be a search engine, a
Jev decision model, `gpt-4o-mini`, or `llama` on your laptop, without the game knowing
or caring.

Three agents ship with it, and they are deliberately three different *architectures*:

| agent | file | who decides placement | who decides hold | per piece |
|---|---|---|---|---|
| **built-in** | `src/ai.js` (in server + browser) | pruned depth-N search over every reachable landing, 16 weighted features, style profiles | same search, one ply ahead | **sub-millisecond**, offline |
| **Jev** | `tools/jev-play.js` | the model, from a `Choice` over measured landings | the model, via a `Noul` | ~400 ms, ~$0.0001 |
| **any chat LLM** | `tools/llm-play.js` | the model, from text actions it composes itself | the model, if it asks for `hold` | 0.3–3 s, model-dependent |

Difficulty is honest search budget, not cheating: `easy` = 1 ply / breadth 4 / 35%
blunders, `normal` = 2×6, `hard` = 3×8, `insane` = 4×5 with the `tetris` style profile.

The built-in agent is a genuine baseline, not a strawman: on the SRS ruleset it cleared
1631 lines over 4081 pieces on seed `hello-jev` before I capped the run — it does not
lose. If an LLM cannot beat that, the honest answer is that it can't.

---

## Quick start

```bash
node server.js                 # http://127.0.0.1:8787
npm test                       # 170 assertions, no network required
```

| command | what you get |
|---|---|
| `/` | play it yourself |
| `/?auto=1&difficulty=insane&turbo=1` | watch the built-in agent play live in the browser |
| `/?game=<id>` | render an API-driven game live — your agent's moves, in the browser, as they happen |
| `/?seed=hello` | fixed piece sequence; the same seed always deals the same pieces |
| `npm run play` | terminal client: `new`, `board`, `play`, `cand`, `hint`, `auto`, `replay`, `ls`, `close` |
| `npm run jev` | play with Jev |
| `npm run llm` | play with any chat API |
| `npm run bench` | tune the built-in agent's weights |

`PORT=9000 node server.js` moves the port. It binds `127.0.0.1` by default, because it
lets callers drive a game and read other games' history.

## Playing with a model API

Both agents read `.env` (real environment variables win over the file). Copy
`.env.example` to `.env` and fill it in — `.env` is gitignored and never committed.

### Jev by TypeSafe AI

```bash
echo 'TYPESAFE_API_KEY=ts_...' >> .env
node server.js &
node tools/jev-play.js --seed hello-jev --pieces 200
```

Add `--quiet` to suppress the per-piece lines; every run prints a
`http://127.0.0.1:8787/?game=<id>` link so you can watch it play in the browser while it
runs.

**It is not a chat model, so the agent doesn't treat it like one.** Jev answers typed
questions (`Choice`, `Score`, `Noul`) in a single parallel pass and does not generate
text — asking it to emit `["left","left","hard_drop"]` would be asking a decision model
to do spatial arithmetic by hand. So the split is:

```
code owns                                        the model owns
─────────                                        ──────────────
enumerate every legal landing                ┌──► move   Choice  "which of these is best?"
simulate each one, then measure:             │
  lines cleared · rows removed               ├──► risk   Score   "how close am I to dying?"
  height · holes · bumpiness                 │
  well depth · aggregate height              └──► hold   Noul    "should I hold this piece?"
        │
        ▼
  validate the answer: does the option exist, does it top out, is it confident enough?
        │
        ▼
  replay that landing's stored action sequence          ← one round trip per piece
```

Per piece the agent asks three questions in one request:

* `move` — a **Choice** over up to 24 landings, each described in words with the
  measurements already computed (`"piece J rot 1, column 4, clears 2 lines; stack height
  9 (was 10), holes 0, well 4 deep at col 0, aggregate 44 (was 46). If the game were
  over, this board would score 3"`). The candidates are re-ordered by column so the
  built-in engine's ranking can't leak in as position bias.
* `risk` — a **Score** on a 4-level rubric (empty → low → getting high → critical).
* `hold` — a **Noul** ("is holding better than placing now?"), only when hold is available.

Then **the code, not the model, executes the move**: the answer is a landing id, and the
action sequence that gets the piece there is fetched from `GET /api/games/:id/candidates`
and replayed. A model that cannot emit tokens cannot emit an illegal token either.

Guards, because the answer can still be wrong:

* an option it didn't offer, an off-by-one index, or a landing that would top out → the
  move is handed to the built-in engine instead (`--no-engine-fallback` to measure the
  model without that net);
* low `confidence` → engine. On a genuinely indifferent board Jev's confidence *is* low,
  and this is the honest answer;
* a dangerous `risk` score raises the confidence bar it must clear (no 0.31-confidence
  gambles at level 18);
* at equal confidence, a landing that clears lines beats one that clears nothing — a
  shrug from the model must not quietly cost lines the engine would have found.

`--min-confidence 0 --danger-confidence 0` disables both judgment gates for a
**pure-model run**, where every piece is the model's call; the legality and topout
guards stay on. The per-game summary prints exactly how many pieces the model carried,
how many the engine carried, provider errors, tokens and estimated cost — so a hybrid
run and a pure run can never be confused for each other.

### What it actually scored

One game per row, same seed (`hello-jev`), `hard`, macOS, Node 26, live `jev-latest`
(resolved to `jev-1.13.0`). A cap is a cap, not a death — nothing in these rows topped
out.

| run | pieces | lines | level | score | decisions |
|---|---|---|---|---|---|
| built-in engine | 4081 (capped) | 1631 | 15 | 3,950,630 | 100% search |
| Jev + judgment gates | 200 (capped) | 67 | 7 | 34,297 | 109 Jev / 91 engine |
| Jev, pure (`--min-confidence 0 --danger-confidence 0`) | 150 (capped) | 48 | 5 | 21,416 | 150 Jev / 0 engine |

Jev plays a legal, unglamorous game: no tetrises, no t-spins, no holds spent (the Noul
never crossed 0.6), and it survives at least 150 pieces of `hard` SRS tetris from a cold
board. The built-in planner is far better at this — that is what a hand-written search
doing exact simulation is for, and this repo would be lying about its own baseline if it
reported otherwise. What the Jev row demonstrates is the interesting part: **a decision
model with no code access can be wired into this game in ~450 lines and never once emit
an illegal move**, at ~400 ms and ~$0.0001 per piece
(2.5k input tokens + 300 output tokens per decision, ≈ $0.02 per 200 pieces).

One reproducible number is one data point, not a benchmark: use different `--seed`s and
`--pieces` and read the summary lines.

### Any OpenAI-compatible chat API

```bash
echo 'OPENAI_API_KEY=sk-...' >> .env            # + OPENAI_BASE_URL / OPENAI_MODEL
node tools/llm-play.js --seed demo --pieces 60

# local models, no cloud
OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_MODEL=llama3.1 node tools/llm-play.js
# routers
OPENAI_BASE_URL=https://openrouter.ai/api/v1 OPENAI_MODEL=anthropic/claude-... node tools/llm-play.js
```

The model gets the board as ASCII plus its legal action vocabulary and replies with
`{"actions":[...],"reason":"..."}`. Everything around it is defensive, because chat
models are text generators: JSON is recovered out of fenced prose, every action is
checked against `legalActions`, `hold` is refused when unavailable, a missing
`hard_drop` is appended so the piece always locks, one invalid reply earns exactly one
correction round-trip, and a reply that still doesn't lock the piece is replaced by the
engine's move. A hopeless model never stalls a game.

## Benchmarking

```bash
node tools/jev-play.js --seed s1 --pieces 300 --min-confidence 0 --danger-confidence 0
node tools/llm-play.js --seed s1 --pieces 300
node tools/bench.js 8                     # tune the built-in agent's weights
```

Seeds are names, not numbers, and are recorded in the game — two agents on the same seed
see the same piece sequence, so survival and lines are directly comparable. `GET
/api/games` returns every game with its seed and stats.

What this engine is genuinely good at testing is **SRS**. There are no kick tables in the
agent's head — `rotate_cw` either moves the piece or is refused — so an agent's
understanding of wall kicks is *tested*, not assumed. `S`, `Z`, `T`, `L`, `J` and `I` all
kick; `O` never does.

## The REST API

Full machine-readable reference: **`GET /api/docs`**.

| endpoint | |
|---|---|
| `GET /api/health` | engine identity, live game count |
| `GET /api/docs` | the full reference, as markdown (serve this to your agent) |
| `POST /api/games` | `{seed?, level?, difficulty?, client?}` → 201 + full state + `eventCursor` |
| `GET /api/games` | every live game: id, seed, client, score, lines, stats |
| `GET /api/games/:id` | state; `?since=<eventCursor>` returns only the `events` produced since that cursor |
| `POST /api/games/:id/actions` | `{"actions":[...]}` / `{"action":"hold"}` / plain text → `applied`, `rejected[{index,action,reason}]`, new state |
| `GET /api/games/:id/candidates` | every reachable landing with its measured features, resulting `ascii`, and the **`actions` that get the piece there**, plus the engine's `hint` |
| `POST /api/games/:id/hint` | `{difficulty?}` → executable action list for the next piece + the ranked plan |
| `POST /api/games/:id/auto` | `{moves}` (≤500) or `{until:"game_over", maxPieces}` (≤4000), `budgetMs` ≤20000 → `piecesPlayed`, `stoppedBy` |
| `GET /api/games/:id/replay` | seed + the full action transcript + stats: enough to re-execute offline |
| `DELETE /api/games/:id` | close it |

State fields an agent actually reads: `ascii` (visible well, letters = settled blocks,
the active piece overlaid in its own letter), `board` (numeric, all 24 rows),
`active{name,rotation,col,row,ghostRow,cells}`, `queue`, `hold`, `canHold`,
`legalActions`, `score/lines/level/combo/backToBack/stats`, `over`, `eventCursor`.
`col` is a bounding-box origin and **can go negative** — that is legal, and it is how
wall kicks work. Up to 2000 actions per call; the game is turn-based, so there is no
clock and no server-side gravity while your model thinks.

Rules: **input is never a score**. `rotate_cw` is legal or it is refused with a reason —
a bad move is a fact about the agent, not a penalty. `soft_drop` earns +1 per cell and
`hard_drop` +2 per cell, and only over cells the piece actually fell: wiggling a piece
that cannot descend earns nothing.

```bash
ID=$(curl -s -X POST localhost:8787/api/games -d '{"seed":"demo"}' | jq -r .id)
curl -s localhost:8787/api/games/$ID/candidates | jq '.candidates[0]'
curl -s -X POST localhost:8787/api/games/$ID/actions -d '{"actions":["left","hard_drop"]}' | jq '.score, .lines'
curl -s -X POST localhost:8787/api/games/$ID/actions -d '{"action":"rotate_cw"}' | jq '.rejected'
```

`src/ai.js` is the same agent, importable in the browser (`import { plan } from
'./src/ai.js'`) — that is what `/?auto=1` uses.

## Layout

```
index.html, styles.css     the board, the neon, the DOM
src/core.js                engine: SRS + kicks, 7-bag, lock delay, scoring, Game.state()
src/ai.js                  built-in agent: search, features, style profiles (importable)
src/render.js              canvas renderer
src/app.js                 input, sound, overlays, auto-play
server.js                  zero-dep HTTP server: static host + the REST API + in-process games
tools/env.js               .env loader (no dependency added)
tools/api-play.js          terminal client, and the ApiClient the other tools import
tools/jev-play.js          the Jev agent
tools/llm-play.js          the generic chat-model agent
tools/bench.js             built-in agent weight/depth sweeps
test/                      engine, AI, API and agent tests
```

## Notes on how it works

* **SRS** with the J/L/S/Z/T kick table and the separate I table (5 offset tests each,
  `O` never kicks), with y sign flipped for the screen grid and the guideline's "0,2"
  reversal applied.
* **Heuristic lock delay**: `lockDelayMs` 500, reset only on a move that actually moved
  the piece, max 15 resets; `step-reset` on spawn/hold/gravity so a piece can't
  mis-lock.
* **Scoring** (`src/core.js`): clears 100/300/500/800 × level; T-spin 400/800/1200/1600
  and mini 100/200/400/600; perfect clear 800…3000; back-to-back adds +50% of the base;
  combo adds `50 × combo × level`; `hard_drop` +2 per cell, only on a real lock.
* **`spawn`/`hold` place at the spawn column**, and moves that would spawn inside the
  stack are reported as `TOPPED_OUT` — the same rule the browser applies.
* 10×20 visible with 4 hidden rows above; `state.board` is all 24, `state.ascii` is the
  20 you can see.

## Tests

```bash
npm test            # engine + AI + API + agents
node test/headless.test.js   # rules, 47 assertions
node test/ai.test.js         # agent sanity
node test/api.test.js        # HTTP surface, rejection semantics, cursors, replay (40)
node test/agents.test.js     # both agents vs stubbed models, incl. outages (71)
```

The agent tests need no API key: they stub the model endpoint and check the parts that
actually matter — that the questions are built from measurements rather than raw grids,
that option ids round-trip to the same landing, that nonsense/low-confidence/dangerous
answers are refused, that garbage chat output can't stall a game, and that 429s are
retried.

Both agents also survive their provider: a 503 from the API costs that piece to the
engine and the run continues, because a transient outage should not cost you a 200-piece
run. Eight consecutive failures stop the run instead, so a game played mostly by the
engine is never reported as a model run.

## License

MIT
