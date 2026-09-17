/**
 * AI tuning benchmark: `node tools/bench.js [games]`
 * Runs fixed-seed self-play for each config and reports survival + efficiency.
 */
import { Game } from '../src/core.js';
import { selfPlay, features, W } from '../src/ai.js';

const GAMES = Number(process.argv[2] ?? 8);
const SEEDS = Array.from({ length: GAMES }, (_, i) => `bench-${i}`);

const VARIANTS = [
  { name: 'baseline d3b6', opts: { depth: 3, breadth: 6 } },
  { name: 'greedy  d1', opts: { depth: 1, breadth: 6 } },
  { name: 'd2 b8', opts: { depth: 2, breadth: 8 } },
  { name: 'd4 b5', opts: { depth: 4, breadth: 5 } },
  { name: 'wide-holes d3', opts: { depth: 3, breadth: 8, weights: { holes: -1.9 } } },
  { name: 'flat-stack d3', opts: { depth: 3, breadth: 8, weights: { bumpiness: -0.6, aggHeight: -0.7 } } },
  { name: 'clear-hungry d3', opts: { depth: 3, breadth: 8, weights: { clearBonus: [0, 12, 34, 66, 150, 240] } } },
  { name: 'no-well d3', opts: { depth: 3, breadth: 8, weights: { wellDepth: 0 } } },
  { name: 'quad1.5 d3', opts: { depth: 3, breadth: 8 } },
  { name: 'quad3 d3', opts: { depth: 3, breadth: 8, weights: { quadWell: 3 } } },
  { name: 'quad5 d3', opts: { depth: 3, breadth: 8, weights: { quadWell: 5 } } },
  { name: 'tetris-wait d3', opts: { depth: 3, breadth: 8, style: 'tetris' } },
  { name: 'tetris-wait d4', opts: { depth: 4, breadth: 5, style: 'tetris' } },
  { name: 'tetris hungry d3', opts: { depth: 3, breadth: 8, style: 'tetris', weights: { clearBonus: [0, 12, 34, 66, 150, 240] } } },
  { name: 'sq w0.3 d3', opts: { depth: 3, breadth: 8, style: 'tetris', quadWait: 2, weights: { quadWell: 0.3, clearBonus: [0, 6, 12, 20, 160, 260] } } },
  { name: 'sq w0.5 d3', opts: { depth: 3, breadth: 8, style: 'tetris', quadWait: 2, weights: { quadWell: 0.5, clearBonus: [0, 6, 12, 20, 160, 260] } } },
  { name: 'sq w0.9 d3', opts: { depth: 3, breadth: 8, style: 'tetris', quadWait: 2, weights: { quadWell: 0.9, clearBonus: [0, 6, 12, 20, 160, 260] } } },
  { name: 'sq w0.5 d4', opts: { depth: 4, breadth: 5, style: 'tetris', quadWait: 2, weights: { quadWell: 0.5, clearBonus: [0, 6, 12, 20, 160, 260] } } },
  { name: 'pure-quad d3', opts: { depth: 3, breadth: 8, style: 'tetris', quadWait: 3, weights: { clearBonus: [0, 2, 4, 8, 220, 320], quadWell: 3 } } },
  { name: 'pure-quad d4', opts: { depth: 4, breadth: 5, style: 'tetris', quadWait: 3, weights: { clearBonus: [0, 2, 4, 8, 220, 320], quadWell: 3 } } },
  { name: 'pure-quad d2', opts: { depth: 2, breadth: 10, style: 'tetris', quadWait: 3, weights: { clearBonus: [0, 2, 4, 8, 220, 320], quadWell: 3 } } },
  { name: 'soft-quad d3', opts: { depth: 3, breadth: 8, style: 'tetris', quadWait: 3, weights: { clearBonus: [0, 5, 10, 18, 180, 300], quadWell: 2 } } },
  { name: 'quad3 hungry d3', opts: { depth: 3, breadth: 8, weights: { quadWell: 3, bumpiness: -0.5 } } },
];

function run(opts) {
  const rows = [];
  for (const seed of SEEDS) {
    const g = new Game({ seed, startLevel: 1 });
    const t0 = Date.now();
    selfPlay(g, { ...opts, maxPieces: 1200 });
    const f = features(g.grid);
    rows.push({
      pieces: g.stats.pieces, lines: g.lines, score: g.score, ms: Date.now() - t0,
      tetris: g.stats.tetrises, tspin: g.stats.tspins, combo: g.stats.maxCombo,
      level: g.level, holes: f.holes, height: f.maxHeight, alive: !g.over,
    });
  }
  const avg = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
  return {
    pieces: avg('pieces'),
    linesPerPiece: avg('lines') / avg('pieces'),
    score: avg('score'),
    tetris: avg('tetris'),
    tspin: avg('tspin'),
    combo: avg('combo'),
    level: avg('level'),
    ms: avg('ms') / avg('pieces'),
    alive: rows.filter((r) => r.alive).length,
    worst: Math.min(...rows.map((r) => r.pieces)),
    best: Math.max(...rows.map((r) => r.pieces)),
  };
}

console.log(`\n  ${GAMES} games/variant, level 1 start, cap 1200 pieces\n`);
console.log('  ' + 'config'.padEnd(16) + 'pieces'.padStart(8) + 'lines/pc'.padStart(10)
  + 'tetris'.padStart(8) + 'tspin'.padStart(7) + 'combo'.padStart(7) + 'level'.padStart(7)
  + 'score'.padStart(9) + 'ms/pc'.padStart(8) + 'worst'.padStart(7) + 'alive'.padStart(7));
console.log('  ' + '-'.repeat(96));
let top = null;
for (const v of VARIANTS) {
  const r = run(v.opts);
  const rank = r.linesPerPiece * 100 + r.pieces / 20 + r.tetris * 5;
  if (!top || rank > top.rank) top = { name: v.name, rank, r };
  console.log('  ' + v.name.padEnd(16) + r.pieces.toFixed(0).padStart(8) + r.linesPerPiece.toFixed(2).padStart(10)
    + r.tetris.toFixed(1).padStart(8) + r.tspin.toFixed(1).padStart(7) + r.combo.toFixed(1).padStart(7)
    + r.level.toFixed(1).padStart(7) + r.score.toFixed(0).padStart(9) + r.ms.toFixed(1).padStart(8)
    + String(r.worst).padStart(7) + String(r.alive).padStart(7));
}
console.log(`\n  best: ${top.name}\n`);
