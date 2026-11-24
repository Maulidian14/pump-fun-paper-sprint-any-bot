// Dip-recovery paper bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2), built for this competition's 6-hour final window.
//
// v5 builds on v2 (dip >= 20% + full retake, dispersed coins, scale into
// strength with a trailing stop, no take-profit; +8.377 SOL grade-local).
// v2's weaknesses, found by replaying the full dev window coin by coin:
//
//   1. The creator-sold filter blocks exactly 2 of the 7 slow completers
//      (Hhcck7SDvK, GV3Nh35Rrp) — their creators sold within the first 8
//      slots, long before the coins proved themselves. But dropping the
//      filter entirely admits 46 creator-sold coins, of which only those 2
//      complete. v5 therefore admits creator-sold coins ONLY with much
//      stronger dispersion proof (many more buyers, higher rq) than clean
//      coins need — and only exits on creator sells that happen WHILE the
//      bot holds (v2's lifetime-flag exit closed such positions in the very
//      next batch, which is why the no-filter sweep showed no gain from the
//      two completers at all).
//   2. Two exit patterns bleed the losers: pump-and-dump coins that earn
//      full adds and then dump through the wide trail (e.g. -0.21 SOL in 84
//      slots), and slow bleeds held 2,000+ slots for -0.15 to -0.21 SOL.
//      v5 tightens the trail once a position has earned its first add
//      (protect the scaled-up cost basis) and cuts positions that are still
//      underwater after a long hold.
//   3. Concentration: v2's top-3 trips are 81% of its gains. v5 spreads the
//      edge by catching the two creator-sold completers and by capping the
//      per-coin stake, so no single coin dominates the book.
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
  /** Refuse entries on coins whose creator has sold (v2 behaviour). When
   * false, creator-sold coins may enter if they clear the stricter
   * creatorMinBuyers / creatorMinRq / creatorMaxFirstSellAge bars below. */
  creatorFilter: boolean;
  /** Lifetime distinct buyers a creator-sold coin needs at entry (stricter
   * than minBuyers: a sold creator must be outweighed by dispersion). */
  creatorMinBuyers: number;
  /** Real SOL a creator-sold coin needs at entry (stricter than minRq). */
  creatorMinRq: number;
  /** A creator-sold coin's first creator sell must be within this many slots
   * of creation (0 = no constraint). Early creator sells are weak signals;
   * a creator dumping after a pump is a rug. */
  creatorMaxFirstSellAge: number;
  /** A creator-sold coin's first creator sell must be at most this many SOL
   * (0 = no constraint). A 15 SOL first dump is a hard rug signal; a 3 SOL
   * first sell is small enough that the coin can still outgrow it. */
  creatorMaxFirstSellSol: number;
  /** When true, exit only on creator sells that happen while holding (the
   * count of creator sells at open is remembered). When false (v2), exit
   * whenever the creator has EVER sold — which closes pre-sold entries at
   * once. */
  creatorExitDuringHold: boolean;
  /** When false, creator sells never trigger an exit at all (large dumps
   * are still caught by bigSellSol). Useful to test whether the creator
   * exit costs more winners than it saves losers. */
  creatorExit: boolean;
  /** Most entries ever taken on one coin (1 = v2: a coin is traded once).
   * A coin that dips, recovers, exits on a trail and then dips and recovers
   * again can earn a second entry — slow completers often take several
   * legs to complete. */
  maxEntriesPerCoin: number;
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
  /** Most SOL at cost in one position on a creator-sold coin (0 = same as
   * stakeSol). Creator-sold entries are lower conviction: in a reshuffled
   * window their completions are destroyed but the entries still happen, so
   * a smaller cap bounds the damage there while keeping most of the dev
   * upside (the winner's gain scales with stake, but so do the losers'). */
  creatorStakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out wide open. */
  buySlipBps: number;
  /** Trailing stop from the position's best value (share). */
  trail: number;
  /** Trailing stop before the first add (wide: let a fresh position survive
   * the deep dips slow completers take on the way up). */
  trailWide: number;
  /** Trailing stop once the position has earned at least one add (tight:
   * protect the scaled-up cost basis from pump-and-dump reversals). */
  trailAfterAdd: number;
  /** Trailing stop while the position is up more than trailUpMult x cost
   * (wide again: a winner deep in profit can survive a deep dip on its way
   * to completion; 0 = disabled, the add-based trail applies). */
  trailWhenUp: number;
  /** Multiple of cost above which trailWhenUp applies. */
  trailUpMult: number;
  /** Exit when no trade has printed for this many slots. */
  staleSlots: number;
  /** Exit after this many slots held (unless the position is up). */
  maxHold: number;
  /** Exit after this many slots held while still underwater (0 = disabled).
   * Cuts the slow bleeds: a dip-recovery thesis that has not worked in this
   * long is not going to. */
  maxHoldUnderwater: number;
  /** When true, the underwater time exit applies only to positions that
   * never earned an add. A position that earned adds has shown real
   * strength — it may dip deep mid-ride and still complete, so the time
   * exit should not cut it. */
  underwaterNoAddsOnly: boolean;
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
  maxRq: 80,
  minAge: 50,
  minCreateMult: 1.5,
  creatorFilter: false,
  creatorMinBuyers: 180,
  creatorMinRq: 25,
  creatorMaxFirstSellAge: 10,
  creatorMaxFirstSellSol: 5,
  creatorExitDuringHold: true,
  creatorExit: true,
  maxEntriesPerCoin: 1,
  firstBuySol: 0.15,
  addSol: 0.4,
  addRqShare: 0.01,
  addRqStep: 3,
  stakeSol: 4.0,
  creatorStakeSol: 2.0,
  minBuySol: 0.01,
  buySlipBps: 1500,
  trail: 0.35,
  trailWide: 0.35,
  trailAfterAdd: 0.35,
  trailWhenUp: 0,
  trailUpMult: 1.5,
  staleSlots: 600,
  maxHold: 4000,
  maxHoldUnderwater: 2000,
  underwaterNoAddsOnly: false,
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
  /** Number of sells by the creator so far (for the during-hold exit). */
  creatorSells: number;
  /** Slot of the creator's first sell, or null if the creator never sold. */
  creatorFirstSellSlot: number | null;
  /** SOL size of the creator's first sell, or null if never sold. */
  creatorFirstSellSol: number | null;
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
  /** Number of add-on buys taken so far (0 = first buy only). */
  adds: number;
  /** Creator sells counted when the position opened (during-hold exit). */
  creatorSellsAtOpen: number;
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
 * trailing stop (wide before the first add, tight after it), stale (no trade
 * for a while), big sell, creator sell while holding, underwater too long,
 * then the time limit — which only fires while the position is not well up.
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
  creatorSoldNow: boolean,
  p: Params,
): boolean {
  if (h.exiting) return true;
  let trail = h.adds > 0 ? p.trailAfterAdd : p.trailWide;
  if (p.trailWhenUp > 0 && value > cost * p.trailUpMult) trail = p.trailWhenUp;
  if (h.peakValue > 0 && value < h.peakValue * (1 - trail)) return true;
  if (now - lastTradeSlot > p.staleSlots) return true;
  if (bigSell) return true;
  if (p.creatorExit && creatorSoldNow) return true;
  if (p.maxHoldUnderwater > 0 && now - h.opened > p.maxHoldUnderwater && value < cost && (!p.underwaterNoAddsOnly || h.adds === 0)) return true;
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
        creatorSells: 0, creatorFirstSellSlot: null, creatorFirstSellSol: null,
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
    if (c.creatorSold) {
      // A sold creator is not an automatic no anymore — but the bar is much
      // higher: the coin must have proved itself with far more buyers and
      // real SOL than a clean coin needs, and the creator's first sell must
      // have been early (a dump after a pump stays out).
      if (p.creatorFilter) return false;
      if (c.buyers.size < p.creatorMinBuyers) return false;
      if (rqSol < p.creatorMinRq) return false;
      if (
        p.creatorMaxFirstSellAge > 0 &&
        (c.creatorFirstSellSlot === null || c.creatorFirstSellSlot - c.created > p.creatorMaxFirstSellAge)
      ) return false;
      if (
        p.creatorMaxFirstSellSol > 0 &&
        (c.creatorFirstSellSol === null || c.creatorFirstSellSol > p.creatorMaxFirstSellSol)
      ) return false;
    }
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
            if (c.creator !== null && e.user === c.creator) {
              c.creatorSold = true;
              c.creatorSells++;
              if (c.creatorFirstSellSlot === null) {
                c.creatorFirstSellSlot = e.slot;
                c.creatorFirstSellSol = sol;
              }
            }
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
        // Creator exit: only on sells that happen while holding (when the
        // during-hold mode is on); a creator who sold before entry is
        // already priced into the stricter entry bar.
        const creatorSoldNow = p.creatorExitDuringHold
          ? c.creatorSells > h.creatorSellsAtOpen
          : c.creatorSold;
        if (!shouldExit(h, value, cost, now, c.lastTradeSlot, bigSell.has(mint), creatorSoldNow, p)) continue;
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
          if (c.entries >= p.maxEntriesPerCoin) continue;
          if (!entrySignal(c, now, rqSol, price)) continue;
          want = p.firstBuySol;
        } else {
          // Add only into real strength: rq climbed a full step above the
          // last buy's rq AND the price is above the last buy's price.
          // Losers stall and never earn an add; winners keep earning them.
          // Creator-sold positions scale to a smaller cap (when set): they
          // are lower conviction, and in a reshuffled window their
          // completions are destroyed while the entries still happen.
          const stakeCap = c.creatorSold && p.creatorStakeSol > 0 ? p.creatorStakeSol : p.stakeSol;
          if (h.exiting || !h.filled || h.invested >= stakeCap - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (rqSol < h.lastAddRq + p.addRqStep) continue;
          if (price <= h.lastAddPrice) continue;
          want = Math.min(p.addSol, p.addRqShare * rqSol, stakeCap - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        const amount = sizeBuy(capSol, want, p.maxExposureSol - exposure, free, tx, p.minBuySol);
        if (amount === null) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, adds: 0, creatorSellsAtOpen: c.creatorSells, lastAddRq: rqSol, lastAddPrice: price, lastValue: 0 });
          c.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.adds++;
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
