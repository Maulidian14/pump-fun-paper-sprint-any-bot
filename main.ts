// SPDX-License-Identifier: MIT
// pump-fun-paper-sprint v2: dip-recovery paper bot for the pump.fun replay
// (agent-fun/replay/v2), tuned for the 6-hour final window. The grader runs
// `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK shim is the
// kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// v2 (dip >= 20% + full retake, dispersed coins, scale into strength with a
// 0.35 trailing stop, no take-profit): +8.377 SOL net on the FULL 24h dev
// window (dd 0.192, 66 trips, 62 coins, 12 wins); 6h slices
// [+0.76, -0.71, +0.95, +7.57]; +7.424 SOL at 2x fees; seed stress +5.88 to
// +8.38 across 6 seeds. v1 (early momentum) scored -1.138 SOL on the server —
// its +0.172 SOL sweep number came from the kit sim's partial loader, which
// reads only part-00000 (see tools/dataset-full.ts).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
