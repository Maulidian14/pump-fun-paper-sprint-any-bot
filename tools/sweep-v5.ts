// v5 knob sweep: full window + 6h slices + top-3 concentration + 2x fees.
// Prints one line per variant. A knob is adopted only if it improves the full
// window AND the slice profile AND concentration — never on the dev total alone.
//
//   node tools/sweep-v5.ts <kit dir>
//
// Uses tools/dataset-full.ts (ALL dataset parts) — never the kit sim's
// loadDataset, which reads only part-00000.

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
  console.error('usage: node tools/sweep-v5.ts <kit dir>');
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

function top3Share(trips: { pnl: bigint }[]): number {
  const gains = trips.map((t) => sol(t.pnl)).filter((x) => x > 0).sort((a, b) => b - a);
  const total = gains.reduce((a, b) => a + b, 0);
  if (total <= 0) return 1;
  return gains.slice(0, 3).reduce((a, b) => a + b, 0) / total;
}

function run(p: Params) {
  const r = simulate(full, hello, createStrategy(p));
  const q = slices.map((d) => sol(simulate(d, hello, createStrategy(p)).netPnl));
  const twoX = sol(simulate(full, hello, createStrategy(p), { feeMultiplier: 2n }).netPnl);
  const qMean = q.reduce((a, b) => a + b, 0) / 4;
  const qSorted = [...q].sort((a, b) => a - b);
  const qMed = (qSorted[1]! + qSorted[2]!) / 2;
  return {
    net: sol(r.netPnl), dd: r.maxDrawdown, trips: r.trips.length,
    wins: r.trips.filter((t) => t.pnl > 0n).length, coins: r.mints,
    q, qMean, qMed, twoX, top3: top3Share(r.trips),
  };
}

const variants: Array<[string, Partial<Params>]> = [
  ['v5 defaults', {}],
  ['v5+creatorStake2.0', { creatorStakeSol: 2 }],
  ['v5+creatorStake3.0', { creatorStakeSol: 3 }],
  ['v5+creatorStake2.5', { creatorStakeSol: 2.5 }],
];

for (const [name, over] of variants) {
  const p = { ...DEFAULT_PARAMS, ...over };
  const r = run(p);
  console.log(
    `${name.padEnd(28)} net ${r.net.toFixed(3)} dd ${r.dd.toFixed(3)} trips ${r.trips} wins ${r.wins} coins ${r.coins} top3 ${r.top3.toFixed(2)} 2x ${r.twoX.toFixed(2)} qMean ${r.qMean.toFixed(2)} qMed ${r.qMed.toFixed(2)} q [${r.q.map((x) => x.toFixed(2)).join(' ')}]`,
  );
}
