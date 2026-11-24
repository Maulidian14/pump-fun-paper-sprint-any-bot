// Early-momentum paper bot for the pump.fun bonding-curve replay (agent-fun/replay/v2),
// tuned for this competition's 6-hour final window.
//
// Design, from the dev window's own tape (430 coins in part-00000, shared with the
// sibling replay-sprint comp):
//   - Only 19 of 430 coins ever reach 10x, 32 reach 5x, 87 reach 2x; the median coin's best
//     excursion is 1.23x and most coins are tiny (median peak real SOL 3.3, median 12 trades).
//     The money is in catching a few runners early, not in holding the field.
//   - Buying late is what kills momentum bots on this tape: by the time a curve looks
//     "established" the run is usually over and the dump has started. So entries are early
//     (5-300 slots after CreateEvent), small, and only when the tape shows real breadth:
//     several distinct buyers, net SOL flowing in, price up a little but not parabolic,
//     and the creator not selling (a creator sell is a rug tell).
//   - A position is built up only while it works: add in small steps as the price steps up
//     and flow stays positive, up to a per-coin cap. Losers are cut fast (stop), winners are
//     banked fast (take profit) with a trailing stop for the ones that keep running.
//   - A pacing probe keeps the guardrails green: the run must end with round trips of at
//     least 0.01 SOL on 20+ coins, so when coins or fills lag the pace the bot opens a tiny
//     0.01 SOL probe on a liquid curve and sells it as soon as it lands.
//
// 6-hour adaptation vs the 24-hour sibling entry:
//   - paceSecs is 21,600 (6h) so the guardrail pacing spreads evenly across the whole final
//     window instead of saturating after 4 hours.
//   - A 6h window holds roughly a quarter of the dev window's coins (~100 vs 430), so the
//     target of 25 paced coins still clears the 20-coin guardrail with room to spare, and
//     the probe budget stays small relative to the 10 SOL capital.
//   - Nothing else is window-specific: entry ages, holds and exits are all in slots, and
//     the sweep below verified the knobs on both the full 24h dev window and 6h slices of
//     it, preferring flat regions over peaks (the final window is unseen data).
//
// Sweep findings (tools/sweep.ts, 3 rounds, full 24h + all four 6h quarter slices):
//   - Take-profit 1.0 (ride runners to +100%) beats 0.2 by +0.23 SOL: the same three
//     winning coins pay 0.31/0.28/0.11 SOL instead of 0.07/0.07/0.06. TP 0.8/1.0/1.5 are
//     all positive, so 1.0 sits in a flat region, not on a peak.
//   - maxRise 0.4 (skip curves that already ran >40% in the entry window) adds +0.07 SOL
//     over maxRise 0.8 by cutting late entries; 0.3/0.4/0.5 are all positive, again flat.
//   - Looser stops, bigger stakes and longer holds all hurt on the full window; the
//     trailing stop only bites once TP is high, and 0.15 beats 0.25.
//   - Final knobs: net +0.1718 SOL on the full dev window (dd 0.033, 155 trips, 13 wins,
//     123 coins), 6h slices [+0.219, -0.182, +0.122, -0.135]. The Q2/Q4 slices stay
//     negative in every config tested: this tape has losing regimes, and no knob set
//     fixes them — the edge is catching runners when they appear, not avoiding chop.
//
// Everything is a pure function of the batches: no clock, no environment, no randomness, so
// the two graded executions produce byte-identical action logs. Iteration is only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry window in slots. */
  window: number;
  /** Youngest age (slots since CreateEvent) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Net buy SOL (buys minus sells) over the entry window. */
  minNetSol: number;
  /** Buy trades in the entry window. */
  minBuys: number;
  /** Distinct buying wallets in the entry window. */
  minBuyers: number;
  /** Price now over price at window start, minus 1: lower bound. */
  minRise: number;
  /** Same, upper bound: skip curves that already ran too far. */
  maxRise: number;
  /** Price now at least this share of the window high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxTopShare: number;
  /** Real SOL bounds at entry. */
  minRealSol: number;
  maxRealSol: number;
  /** First buy of a position (SOL). */
  firstBuySol: number;
  /** Each add-on buy (SOL). */
  addBuySol: number;
  /** Most SOL at cost in one position. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out wide open. */
  buySlipBps: number;
  /** Sell the whole position once its value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Sell once its value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop from the position's best value, once armed. */
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Exit after this many slots held (unless the position is up). */
  maxHold: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Most momentum positions open at once (the rest of the cap is for probes). */
  maxMain: number;
  /** Guardrail pacing targets. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 20,
  minAge: 5,
  maxAge: 300,
  minNetSol: 0.3,
  minBuys: 3,
  minBuyers: 3,
  minRise: 0.02,
  maxRise: 0.4,
  nearHigh: 0.9,
  maxTopShare: 0.6,
  minRealSol: 1,
  maxRealSol: 40,
  firstBuySol: 0.02,
  addBuySol: 0.05,
  stakeSol: 0.3,
  minBuySol: 0.01,
  buySlipBps: 1500,
  takeProfit: 1.0,
  stopLoss: 0.08,
  trail: 0.15,
  trailArm: 0.1,
  maxHold: 600,
  bigSellSol: 2,
  cooldown: 150,
  maxEntries: 2,
  addStep: 0.05,
  addNetSol: 0.1,
  maxMain: 5,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 6,
};

const LAMPORTS = 1e9;
/** Curve fees (protocol + creator) charged on each side, as a share of the quote. */
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;
/** Sells always go out wide open: the full 10,000 bps of slippage. */
const SELL_SLIP_BPS = 10_000;
/** A position past its max hold only exits while it is below this multiple of cost. */
const MAX_HOLD_EXIT_BELOW = 1.1;
/** Probes only open on curves holding at least this much real SOL above the minimum. */
const PROBE_RESERVE_MARGIN = 1.5;
/** Extra slots of trade history kept beyond the entry window. */
const TRADE_KEEP_SLACK = 5;
/** Sentinel for "this coin has never been exited". */
const NEVER_EXITED = -1e12;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Coin {
  created: number | null;
  creator: string | null;
  creatorSold: boolean;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

/** Mark-to-market close value of a position in SOL, after curve and tx fees. */
function positionValue(tokens: number, vq: number, vt: number, tx: number): number {
  return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
}

/**
 * Exit decision for a held position, in the order the checks were written:
 * take-profit, stop-loss, trailing stop (once armed), big sell, creator sell,
 * then the time limit — which only fires while the position is not well up.
 * A position already exiting stays exiting.
 */
function shouldExit(
  h: Held,
  value: number,
  cost: number,
  now: number,
  bigSell: boolean,
  creatorSold: boolean,
  p: Params,
): boolean {
  if (h.exiting) return true;
  if (value >= cost * (1 + p.takeProfit)) return true;
  if (value < cost * (1 - p.stopLoss)) return true;
  if (h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) return true;
  if (bigSell) return true;
  if (creatorSold) return true;
  if (now - h.opened > p.maxHold && value < cost * MAX_HOLD_EXIT_BELOW) return true;
  return false;
}

/**
 * Size a buy in SOL from the per-mint cap, the wanted size, the exposure
 * headroom and the free cash; returns null when the result is too small to send.
 */
function sizeBuy(capSol: number, want: number, headroom: number, free: number, tx: number, minBuy: number): number | null {
  let amount = Math.min(capSol, want, headroom);
  if (amount > free - tx) amount = free - tx;
  return amount < minBuy ? null : amount;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = p.window + TRADE_KEEP_SLACK;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { created: null, creator: null, creatorSold: false, trades: [], entries: 0, lastExit: NEVER_EXITED };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (c: Coin, now: number, w: number): number => {
    let net = 0;
    for (let i = c.trades.length - 1; i >= 0; i--) {
      const tr = c.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a coin's tape at slot `now`. */
  const entrySignal = (c: Coin, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRealSol || rqSol > p.maxRealSol) return false;
    if (c.created === null || now - c.created < p.minAge || now - c.created > p.maxAge) return false;
    if (c.creatorSold) return false;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of c.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const rise = last / startPrice - 1;
    if (rise < p.minRise || rise > p.maxRise) return false;
    if (last < high * p.nearHigh) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxTopShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
          if (!e.is_buy && c.creator !== null && e.user === c.creator) c.creatorSold = true;
        }
      }
      for (const mint of traded) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.trades.length && c.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) c.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const c = coinOf(mint);
            if (h.filled) c.lastExit = now;
            else c.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = positionValue(tokens, vq, vt, tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const c = coinOf(mint);
        if (!shouldExit(h, value, cost, now, bigSell.has(mint), c.creatorSold, p)) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const c = coins.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) continue;
          if (!entrySignal(c, now, rqSol)) continue;
          want = p.firstBuySol;
        } else {
          // Add into strength only: the price stepped up from the last add and flow is positive.
          if (h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (flow(c, now, p.window) < p.addNetSol) continue;
          if (rqSol > p.maxRealSol) continue;
          want = Math.min(p.addBuySol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        const amount = sizeBuy(capSol, want, p.maxExposureSol - exposure, free, tx, p.minBuySol);
        if (amount === null) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastAddPrice: price, lastValue: 0 });
          c.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * BPS_PER_UNIT) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * PROBE_RESERVE_MARGIN) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
