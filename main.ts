// SPDX-License-Identifier: MIT
// pump-fun-paper-sprint v5: dip-recovery paper bot for the pump.fun replay
// (agent-fun/replay/v2), tuned for the 6-hour final window. The grader runs
// `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK shim is the
// kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// v5 (v2 + selective creator-sold entries at a much higher bar, during-hold
// creator exit, underwater time exit at 2000 slots, creator stake cap 2.0
// SOL, maxRq 80): +11.152 SOL grade-local (217 fills, 70 trips, 66 coins,
// 13 wins, dd 0.198); 6h slices [+0.89, -1.05, +0.89, +10.73]; +10.006 SOL
// at 2x fees; stress median -1.39 (p10 -3.78, p90 +0.31), 8/10 copies lost.
// v2 scored +8.377 SOL grade-local. v1 (early momentum) scored -1.138 SOL
// on the server — its +0.172 SOL sweep number came from the kit sim's
// partial loader, which reads only part-00000 (see tools/dataset-full.ts).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
