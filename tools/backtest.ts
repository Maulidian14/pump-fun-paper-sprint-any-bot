// Offline backtest of strategy.ts on the kit's dev window with the kit's local engine
// port (baselines/pilot/momentum/tools/sim.ts). Dev tooling only; the grader never runs it.
//
//   node tools/backtest.ts <kit dir> ['{"takeProfit":0.6}'] [--trips] [--slice N]
//
// --slice N runs only the Nth quarter of the batches (0-3): a 6h proxy of the 24h dev
// window, used to check the knobs hold up on a 6h slice before trusting them.
//
// Prints net PnL, fills, coins, drawdown and reject reasons; --trips lists every round trip.

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import {
  loadDataset,
  makeHello,
  phaseSeed,
  simulate,
  type Dataset,
} from '../../new6-20261124/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-kit/baselines/pilot/momentum/tools/sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/backtest.ts <kit dir> [params json] [--trips] [--slice N]');
  process.exit(2);
}
const overrides = process.argv[3] !== undefined && process.argv[3].startsWith('{') ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};
const sliceArg = process.argv.indexOf('--slice');
const slice = sliceArg >= 0 ? Number(process.argv[sliceArg + 1]) : -1;
const full = loadDataset(kit);
let ds: Dataset = full;
if (slice >= 0 && slice < 4) {
  const n = full.batches.length;
  const lo = Math.floor((n * slice) / 4);
  const hi = Math.floor((n * (slice + 1)) / 4);
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
  ds = {
    ...full,
    batches: allBatches,
    events: [...synthetic, ...full.events.filter((e) => slots.has(e.slot))],
    endSlot: batches[batches.length - 1]!.slot,
  };
  console.log(`slice ${slice}: batches ${lo}..${hi - 1} of ${n}`);
}
const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256));
const params = { ...DEFAULT_PARAMS, ...overrides };
const r = simulate(ds, hello, createStrategy(params));
const sol = (x: bigint) => (Number(x) / 1e9).toFixed(6);
console.log(`net ${sol(r.netPnl)} SOL  fills ${r.fills}  coins ${r.mints}  trips ${r.trips.length}  wins ${r.trips.filter((t) => t.pnl > 0n).length}  dd ${r.maxDrawdown.toFixed(4)}  rejected ${r.rejected} ${JSON.stringify(r.rejectReasons)}  failed ${r.failed}`);
const noFail = simulate(ds, hello, createStrategy(params), { failKey: null });
const twoX = simulate(ds, hello, createStrategy(params), { feeMultiplier: 2n });
console.log(`without failed txs ${sol(noFail.netPnl)}  at 2x fees ${sol(twoX.netPnl)}`);
if (process.argv.includes('--trips')) {
  for (const t of r.trips) console.log(t.mint, t.open, t.close - t.open, sol(t.pnl));
}
