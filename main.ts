// SPDX-License-Identifier: MIT
// pump-fun-paper-sprint: early-momentum paper bot for the pump.fun replay
// (agent-fun/replay/v2), tuned for the 6-hour final window. The grader runs
// `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK shim is the
// kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// Final knobs (tools/sweep.ts, 3 rounds on the full 24h dev window + all four 6h
// quarter slices): takeProfit 1.0, maxRise 0.4, paceSecs 21,600. Dev result:
// +0.1718 SOL net (dd 0.033, 155 trips, 123 coins); 6h slices
// [+0.219, -0.182, +0.122, -0.135]; deterministic across repeat runs.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
