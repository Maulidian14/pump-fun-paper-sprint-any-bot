// Small one-at-a-time sweep of strategy.ts knobs on the dev window (full 24h + 6h
// slices). Dev tooling only; the grader never runs it.
//
//   node tools/sweep.ts <kit dir>
//
// Prints one line per variant: net PnL on the full window and on each 6h quarter
// slice, so a knob is only adopted when it is good on the full window AND flat
// across slices (the final window is unseen 6h data). Uses tools/dataset-full.ts
// (ALL dataset parts) — never the kit sim's loadDataset, which reads only
// part-00000 and is how v1's sweep misled us.

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadFullDataset } from './dataset-full.ts';
import {
  makeHello,
  phaseSeed,
  simulate,
  type Dataset,
} from '../../new6-20261124/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-kit/baselines/pilot/momentum/tools/sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/sweep.ts <kit dir>');
  process.exit(2);
}
const full = loadFullDataset(kit);
const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', full.sha256));
const sol = (x: bigint) => Number(x) / 1e9;

function sliceDs(q: number): Dataset {
  const n = full.batches.length;
  const lo = Math.floor((n * q) / 4);
  const hi = Math.floor((n * (q + 1)) / 4);
  const batches = full.batches.slice(lo, hi);
  const slots = new Set(batches.map((b) => b.slot));
  // The sim needs a CreateEvent before any TradeEvent of a mint. Coins created
  // before the slice get their CreateEvent replayed in a synthetic first batch
  // at the slice's first slot (mirrors the real final window, where every coin
  // is created inside the window).
  const inSlice = new Set<string>();
  for (const b of batches) for (const e of b.events) inSlice.add(e.mint);
  const createdBefore = new Set<string>();
  for (const e of full.events) {
    if (e.event === 'CreateEvent' && inSlice.has(e.mint) && !slots.has(e.slot)) createdBefore.add(e.mint);
  }
  const synthetic = full.events.filter((e) => e.event === 'CreateEvent' && createdBefore.has(e.mint));
  const firstSlot = batches[0]!.slot;
  const allBatches = synthetic.length > 0 ? [{ slot: firstSlot, events: synthetic }, ...batches] : batches;
  return {
    ...full,
    batches: allBatches,
    events: [...synthetic, ...full.events.filter((e) => slots.has(e.slot))],
    endSlot: batches[batches.length - 1]!.slot,
  };
}
const slices = [0, 1, 2, 3].map(sliceDs);

function run(p: Params): { net: number; dd: number; trips: number; wins: number; coins: number; q: number[] } {
  const r = simulate(full, hello, createStrategy(p));
  return {
    net: sol(r.netPnl),
    dd: r.maxDrawdown,
    trips: r.trips.length,
    wins: r.trips.filter((t) => t.pnl > 0n).length,
    coins: r.mints,
    q: slices.map((d) => sol(simulate(d, hello, createStrategy(p)).netPnl)),
  };
}

const variants: Array<[string, Partial<Params>]> = [
  ['defaults (dip0.2/buy25/trail0.35/stake4)', {}],
  ['dip0.15', { dipDepth: 0.15 }],
  ['dip0.25', { dipDepth: 0.25 }],
  ['dip0.3', { dipDepth: 0.3 }],
  ['trail0.30', { trail: 0.3 }],
  ['trail0.40', { trail: 0.4 }],
  ['buyers50', { minBuyers: 50 }],
  ['stake3', { stakeSol: 3 }],
  ['recoverShare0.75', { recoverShare: 0.75 }],
];

for (const [name, over] of variants) {
  const p = { ...DEFAULT_PARAMS, ...over };
  const r = run(p);
  console.log(
    `${name.padEnd(24)} net ${r.net.toFixed(4)}  dd ${r.dd.toFixed(3)}  trips ${r.trips} wins ${r.wins} coins ${r.coins}  q6h [${r.q.map((x) => x.toFixed(3)).join(' ')}]`,
  );
}
