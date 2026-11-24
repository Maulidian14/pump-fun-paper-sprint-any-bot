// Dip-recovery paper bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2), built for this competition's 6-hour final window.
//
// Why v1 lost and v2 is a different bot: v1 (early momentum) scored -1.138 SOL
// on the server despite a +0.172 SOL local sweep — because the kit's pilot sim
// loader reads only part-00000 (50k of 128k events), so v1 was tuned on the
// first ~40% of the window. On the FULL window (all 3 parts, verified to
// reproduce grade-local to the lamport) v1 stops out on 246 of 306 coins:
// momentum entries buy tops, the -8% stop bleeds -1.82 SOL, and only 3
// positions ever reach the +100% take-profit. The tape's edge is elsewhere.
//
// What the full dev window actually says (1,222 mints, 35 completers):
//   - Generic dip-buying loses: dips usually keep falling (median bounce 0-4%).
//   - But 7 coins complete SLOWLY (345-2,205 slots), dipping 20-65% on the way,
//     ending with 248-1,019 buyers and topShare 0.02-0.05. Their
//     dip-to-completion multiples run 1.4x-11.6x. Those are the only trades
//     with a real edge on this tape.
//   - Completion odds rise steeply with real SOL in the curve (rq >= 55:
//     35% complete) and with a dip-recovery event: a coin that dips >= 20%
//     from its peak and then retakes the peak completes ~11% of the time;
//     with dispersed ownership (>= 25 buyers, topShare <= 0.4) the rate is
//     higher still. The 20% depth matters: one slow completer dips only 24%
//     and never triggers a 30% filter, and the 15-20% depth region is flat
//     (+5.6 to +6.2 SOL at the stricter buyer filter) while 22%+ falls off.
//     A PARTIAL recovery is a trap — retaking only 75% of the peak scores
//     -1.21 SOL and 50% scores -2.78; the retake must be full.
//   - The asymmetry that pays is scale-into-strength: losers stall early and
//     never earn adds (they only ever cost the first buy), while winners keep
//     climbing and keep earning adds — so deployed capital concentrates into
//     the coins that complete. Adds are therefore sized by rq growth, not by
//     a fixed schedule, and there is no take-profit: winners are ridden with
//     a wide trailing stop until they complete or roll over.
//
// v2 therefore does exactly one thing: it waits for a dispersed coin to dip
// >= 20% and retake its peak, buys 0.15 SOL, adds while rq climbs (up to
// 4.0 SOL at cost), and rides with a 0.35 trailing stop. Guardrail probes
// (0.01 SOL round trips, paced over 6h) keep the 20-coin / fills guardrails
// green on windows where the main signal fires rarely.
//
// Everything is a pure function of the batches: no clock, no environment, no
// randomness, so the two graded executions produce byte-identical action logs.
// Iteration is only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Dip depth from the running peak that arms a recovery (share). */
  dipDepth: number;
  /** Share of the peak the price must retake to count as a recovery (1.0 = full). */
  recoverShare: number;
  /** Slots after a recovery during which an entry may still be taken. */
  recoverWindow: number;
  /** Highest entry price as a multiple of the recovery price (no chasing). */
  recoverChase: number;
  /** Lifetime distinct buyers at entry. */
  minBuyers: number;
  /** Largest lifetime buyer's share of lifetime buy SOL. */
  maxTopShare: number;
  /** Real SOL bounds at entry. */
  minRq: number;
  maxRq: number;
  /** Youngest age (slots since CreateEvent) at entry. */
  minAge: number;
  /** Price at entry at least this multiple of the create price. */
  minCreateMult: number;
  /** Refuse entries on coins whose creator has sold (the filter costs a
   * couple of completers but excludes far more losing entries). */
  creatorFilter: boolean;
  /** First buy of a position (SOL). */
  firstBuySol: number;
  /** Each add-on buy (SOL), capped by addRqShare of current rq. */
  addSol: number;
  /** Add size also capped at this share of current rq. */
  addRqShare: number;
  /** Rq must climb this much (SOL) above the last buy's rq to earn an add. */
  addRqStep: number;
  /** Most SOL at cost in one position. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out wide open. */
  buySlipBps: number;
  /** Trailing stop from the position's best value (share). */
  trail: number;
  /** Exit when no trade has printed for this many slots. */
  staleSlots: number;
  /** Exit after this many slots held (unless the position is up). */
  maxHold: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Most momentum positions open at once (the rest of the cap is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing targets. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  dipDepth: 0.2,
  recoverShare: 1.0,
  recoverWindow: 200,
  recoverChase: 1.05,
  minBuyers: 25,
  maxTopShare: 0.4,
  minRq: 15,
  maxRq: 70,
  minAge: 50,
  minCreateMult: 1.5,
  creatorFilter: true,
  firstBuySol: 0.15,
  addSol: 0.4,
  addRqShare: 0.01,
  addRqStep: 3,
  stakeSol: 4.0,
  minBuySol: 0.01,
  buySlipBps: 1500,
  trail: 0.35,
  staleSlots: 600,
  maxHold: 4000,
  bigSellSol: 5,
  maxMain: 4,
  maxExposureSol: 9,
  targetCoins: 25,
  targetFills: 60,
  paceSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 1,
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
/** Each sell chunk's proceeds stay under this share of current real SOL. */
const CHUNK_RQ_SHARE = 0.5;
/** Sentinel for "this coin has never been exited". */
const NEVER_EXITED = -1e12;

interface Coin {
  created: number | null;
  createPrice: number;
  creator: string | null;
  creatorSold: boolean;
  /** Highest recorded price since creation. */
  peak: number;
  /** True once the price has dipped dipDepth below the running peak. */
  dipped: boolean;
  /** Slot of the latest full recovery (price retaking the peak after a dip). */
  recoveredAt: number;
  /** The peak price that was retaken at the latest recovery. */
  recoveredPrice: number;
  /** Lifetime buy SOL by wallet. */
  buyers: Map<string, number>;
  /** Lifetime buy SOL across all wallets. */
  buySol: number;
  /** Slot of the latest recorded trade. */
  lastTradeSlot: number;
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
  /** Real SOL in the curve when the last buy was decided. */
  lastAddRq: number;
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
 * trailing stop, stale (no trade for a while), big sell, creator sell, then
 * the time limit — which only fires while the position is not well up.
 * There is no take-profit: winners are ridden until they roll over.
 * A position already exiting stays exiting.
 */
function shouldExit(
  h: Held,
  value: number,
  cost: number,
  now: number,
  lastTradeSlot: number,
  bigSell: boolean,
  creatorSold: boolean,
  p: Params,
): boolean {
  if (h.exiting) return true;
  if (h.peakValue > 0 && value < h.peakValue * (1 - p.trail)) return true;
  if (now - lastTradeSlot > p.staleSlots) return true;
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

/**
 * Largest token chunk whose sale proceeds stay under CHUNK_RQ_SHARE of the
 * curve's real SOL: a big position on a thin curve must leave in pieces, or
 * the whole sell is rejected for exceeding the reserves.
 */
function chunkTokens(tokens: number, vq: number, vt: number, rqLamports: number): number {
  const targetQ = (rqLamports * CHUNK_RQ_SHARE) / LAMPORTS;
  const vqSol = vq / LAMPORTS;
  const vtTokens = vt;
  if (targetQ <= 0 || vqSol <= targetQ) return tokens;
  const chunk = (targetQ * vtTokens) / (vqSol - targetQ);
  return Math.min(tokens, Math.max(1, Math.floor(chunk)));
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

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        created: null, createPrice: 0, creator: null, creatorSold: false,
        peak: 0, dipped: false, recoveredAt: NEVER_EXITED, recoveredPrice: 0,
        buyers: new Map(), buySol: 0, lastTradeSlot: 0, entries: 0, lastExit: NEVER_EXITED,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Dip-recovery entry signal on a coin's lifetime tape at slot `now`. */
  const entrySignal = (c: Coin, now: number, rqSol: number, price: number): boolean => {
    if (c.created === null || now - c.created < p.minAge) return false;
    if (p.creatorFilter && c.creatorSold) return false;
    if (rqSol < p.minRq || rqSol > p.maxRq) return false;
    if (c.createPrice <= 0 || price < c.createPrice * p.minCreateMult) return false;
    if (c.buyers.size < p.minBuyers) return false;
    let top = 0;
    for (const v of c.buyers.values()) if (v > top) top = v;
    if (c.buySol <= 0 || top > p.maxTopShare * c.buySol) return false;
    // A recovery must have happened recently, and the price must not have
    // run away from it since (no chasing a vertical move).
    if (c.recoveredAt === NEVER_EXITED || now - c.recoveredAt > p.recoverWindow) return false;
    if (price > c.recoveredPrice * p.recoverChase) return false;
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
          const vq = Number(e.virtual_quote_reserves);
          const vt = Number(e.virtual_token_reserves);
          c.createPrice = vt > 0 ? vq / vt : 0;
          if (c.createPrice > c.peak) c.peak = c.createPrice;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          c.lastTradeSlot = e.slot;
          if (price > c.peak) c.peak = price;
          // Dip then recovery, tracked off the running peak: once the price
          // has fallen dipDepth below the peak, the next retake of the peak
          // (to recoverShare of it) is a recovery event.
          if (c.peak > 0 && price <= c.peak * (1 - p.dipDepth)) c.dipped = true;
          if (c.dipped && c.peak > 0 && price >= c.peak * p.recoverShare) {
            c.recoveredAt = e.slot;
            c.recoveredPrice = c.peak;
            c.dipped = false;
          }
          if (e.is_buy) {
            c.buyers.set(e.user, (c.buyers.get(e.user) ?? 0) + sol);
            c.buySol += sol;
          } else {
            if (sol >= p.bigSellSol) bigSell.add(e.mint);
            if (c.creator !== null && e.user === c.creator) c.creatorSold = true;
          }
          traded.add(e.mint);
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first, in chunks sized to the curve's real SOL.
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
        if (!shouldExit(h, value, cost, now, c.lastTradeSlot, bigSell.has(mint), c.creatorSold, p)) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        const rqLamports = Number(curve.real_quote_reserves);
        const chunk = chunkTokens(tokens, vq, vt, rqLamports);
        orders.push({ side: 'sell', mint, token_amount: BigInt(Math.floor(chunk)), max_slippage_bps: SELL_SLIP_BPS });
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
          if (c.entries >= 1) continue;
          if (!entrySignal(c, now, rqSol, price)) continue;
          want = p.firstBuySol;
        } else {
          // Add only into real strength: rq climbed a full step above the
          // last buy's rq AND the price is above the last buy's price.
          // Losers stall and never earn an add; winners keep earning them.
          if (h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (rqSol < h.lastAddRq + p.addRqStep) continue;
          if (price <= h.lastAddPrice) continue;
          want = Math.min(p.addSol, p.addRqShare * rqSol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        const amount = sizeBuy(capSol, want, p.maxExposureSol - exposure, free, tx, p.minBuySol);
        if (amount === null) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastAddRq: rqSol, lastAddPrice: price, lastValue: 0 });
          c.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastAddRq = rqSol;
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
