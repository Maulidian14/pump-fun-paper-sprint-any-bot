# Pump.fun Paper Sprint: Any Bot Can Win

An early-momentum paper trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. It trades 10 SOL of paper money on a 6-hour replay of pump.fun bonding-curve activity. Best net PnL wins (winner takes all).

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Maulidian14/pump-fun-paper-sprint-any-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Maulidian14/pump-fun-paper-sprint-any-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

## Strategy

- **Early entries only** (5–300 slots after a curve is created): on this tape the money is in the few coins that run 5–15x, and buying late means buying the top.
- **Breadth filter**: several distinct buyers, net SOL flowing in, price up a little but not parabolic (max +40% in the entry window), and the creator must not have sold.
- **Small first buys, pyramid into strength**: add in steps only while the price steps up and flow stays positive, up to 0.3 SOL per coin.
- **Ride the runners**: take profit at +100% (the same three winning coins pay ~4x more than at +20%), stop loss at −8%, trailing stop of 15% once up 10%, plus exits on a big sell, a creator sell, or a time limit.
- **Guardrail pacing**: tiny 0.01 SOL probe round trips keep the run above 20 coins traded when the main strategy is quiet; pacing spreads evenly over the 6-hour window (paceSecs 21,600).

Fully deterministic: no clock, no environment, no randomness — the two graded executions produce identical action logs (verified by repeat backtests).

## Dev results (kit's frozen 24h dev window)

- Net PnL **+0.1718 SOL** (390 fills, 155 trips, 13 wins, 123 coins, max drawdown 0.033); still positive at 2x fees (+0.016 SOL).
- On 6-hour quarter slices of the dev window: +0.219 / −0.182 / +0.122 / −0.135 SOL, with 27–55 coins per slice (guardrail: ≥20).
- Knobs were swept in 3 rounds and chosen from flat regions (TP 0.8/1.0/1.5 and maxRise 0.3/0.4/0.5 all positive), not from a single peak — the final window is unseen data.

## Layout

- `main.ts` — entrypoint the grader runs (`node /bot/main.ts`).
- `strategy.ts` — the bot.
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.
- `tools/backtest.ts` — offline backtest on the kit's dev window, with `--slice N` for 6h quarter slices (dev tooling only).
- `tools/sweep.ts` — knob sweep on the full window + all 6h slices (dev tooling only).
