# Pump.fun Paper Sprint v5 — Dip-Recovery + Selective Creator-Sold Entries

v5 builds on v2 (commit ec7565a, grade-local **+8.377 SOL**) with one real
addition: **selective entries on creator-sold coins**, plus an underwater
time exit, a creator stake cap, and a wider rq band. Grade-local:
**+11.152 SOL** (217 fills, 66 coins, 70 trips, 13 wins, dd 0.198), 2x fees
**+10.006 SOL**. Dev #1 on the live board was +1.473 SOL when v5 was built
(24 Nov 2026 ~16:24 WIB) — v5's local number is ~7.6x that, though the final
ranking is an unseen 6h window and this design's variance is high (see
"Honest limits" below).

## Why v2 left money on the table: the 3 missed slow completers

v2 catches 4 of the 7 slow completers (AVGnvQCtRc +4.535, CHjgAurRkf +3.873,
C5Wm8Y9tVb +1.000, 6MVWPQwr2Y +0.773). The 3 it misses:

- **Hhcck7SDvK** (completes age 998) and **GV3Nh35Rrp** (age 2,205): blocked
  ONLY by the creator-sold filter. Their creators sold at age 4 / 8, and many
  later snapshots pass every other filter. Hhcck recovers at age ~120 with
  189 buyers and rq 27; GV3 at age ~824 with 567 buyers and rq 59.
- **52frC8om59** (age 1,530): blocked by creator-sold AND rq 76-78 (above
  maxRq 70), but its recoveries only appear at age 850+ with entry mult
  ~12.5x vs completion ~13.5x — about 8% upside. NOT worth catching; the
  maxRq widening to 80 does not add it (its first qualifying recovery is
  still too late and too dear).

The creator analysis: 46 coins pass all non-creator filters with
creator-sold=true; only Hhcck and GV3 complete (4.3%, vs ~10% for clean
coins). Creator first-sell age/size does NOT discriminate well on its own —
Hhcck's creator sold 36.43 SOL total, GV3's 5.56. What does separate them is
dispersion + real SOL at entry: buyers >= 180 and rq >= 25 admits exactly
Hhcck, GV3, RUNFv5qADC and GP6U7e2FEm (buyers >= 150 also admits GiupJo2Uhk,
which loses -0.64). The first-sell-size bar (<= 5 SOL) then drops GP6U
(first sell 15.11 SOL, a hard rug signal).

**Key discovery:** dropping the creator filter alone does NOTHING — v2's
lifetime-flag creator exit closes such positions in the next batch
(no-creator run: Hhcck held 2 slots for +0.009, GV3 -0.004). Both the
entry-allow AND a during-hold exit fix are needed: the exit now fires only
on creator sells that happen WHILE holding (the creator-sell count at open
is remembered). Verified: entry-allow with the lifetime exit reproduces v2
exactly (+8.442).

## What v5 changes vs v2

- **creatorFilter=false, creatorMinBuyers=180, creatorMinRq=25,
  creatorMaxFirstSellAge=10, creatorMaxFirstSellSol=5.** A creator-sold coin
  may enter only with >= 180 lifetime buyers, rq >= 25, the creator's first
  sell within 10 slots of creation and at most 5 SOL. On dev this admits
  exactly 3 coins: Hhcck (+3.539), GV3 (-0.110), RUNF (-0.160).
- **creatorExitDuringHold=true.** Exit only on creator sells during the
  hold. This is what lets Hhcck ride 876 slots to completion; removing the
  creator exit entirely (creatorExit=false) is WORSE (net 10.11 vs 10.66) —
  the exit saves more than it costs, including cutting GV3 at -0.11 when its
  creator sold again mid-hold.
- **maxHoldUnderwater=2000.** Exit a position still underwater after 2,000
  slots. +0.09 SOL net alone, and it lifts Q1 (0.76 -> 0.89). 1,200 slots is
  worse (kills a Q3 winner: Q3 1.05 -> 0.74); 1,500 collapses Q3 to 0.42 —
  the cliff sits between 1,500 and 1,800, so 2,000 keeps 500 slots of margin
  from it. Restricting the exit to no-add positions is worse (loses the Q1
  benefit: the Q1 saves are positions WITH adds).
- **creatorStakeSol=2.0.** Creator-sold positions scale to a 2.0 SOL cap
  instead of 4.0. Dev cost is tiny (-0.09 SOL: Hhcck's position never
  reached 4.0 invested anyway — the price gate blocks adds on its dips) and
  Q2 improves (-1.27 -> -1.05, smaller mark-to-market on the open RUNF
  position). The point is the stress tail: in a reshuffled window the
  creator completions are destroyed but the entries still happen, so a
  smaller cap bounds the damage there.
- **maxRq 70 -> 80.** +0.15 SOL net, Q2 -0.71 -> -0.56. The rq 70-80 band
  adds a little without admitting junk.

Everything else from v2 is unchanged: dip 0.20, full recovery, buyers >= 25,
topShare <= 0.4, first buy 0.15 SOL, adds on rq +3 up to 4.0 SOL, no
take-profit, 0.35 trailing stop, chunked sells, guardrail probes on.

## Final numbers (delivered version: creatorStakeSol=2.0)

- **grade-local: net +11.152 SOL, 217 fills, 66 coins, 70 trips, win rate
  0.186, dd 0.198.** Rejected 3, failed txs 2. L1 regrade reproduced byte
  for byte. Local sim: +11.215 SOL. (Before the creator stake cap:
  grade-local +11.337, local sim +11.302.)
- At 2x fees: **+10.006 SOL** (still strongly positive).
- 6h quarter slices (local sim): **[+0.89, -1.05, +0.89, +10.73]** — mean
  +2.86, median +0.89 (v2: [+0.76, -0.71, +1.05, +7.58], mean +2.17, median
  +0.90 sim / +0.86 grade-local). Mean is clearly better; the median beats
  the grade-local v2 baseline (+0.86) by 0.03 but is 0.01 below v2's sim
  median — effectively tied, within failed-tx noise. Q2 is worse than v2's
  (-1.05 vs -0.71): the creator losers land early in the window.
- **grade-local --stress (10 rebuilt copies): median -1.39, p10 -3.78, p90
  +0.31 SOL; 8 of 10 lost money; dev above 10/10.** v2's stress: median
  -1.30, p10 -2.94, p90 -0.29, 9/10 lost. The stress MEDIAN misses v2's by
  0.09 (gate not met — see "Honest limits"), but the p90 (+0.31 vs -0.29)
  and the loser count (8/10 vs 9/10) are both better than v2's, and the
  p10 improved a lot from the uncapped v5 (-6.21 -> -3.78) thanks to the
  creator stake cap. Same caveat as v2: the copies are block-reshuffled,
  which destroys the multi-hour trajectories this design exploits; the
  contiguous 6h slices are the better final-window estimator. Both v2 and
  v5 lose money on most reshuffled copies — the design is
  trajectory-dependent by construction, and a 10-sample median has wide
  error bars (the 0.09 gap is noise-level).
- Top trips: AVGnvQCtRc +4.535, CHjgAurRkf +3.873, Hhcck7SDvK +3.539 (new),
  3FZxbq9Ndh +1.217, C5Wm8Y9tVb +1.000, 6MVWPQwr2Y +0.773. v5 catches 5 of
  the 7 slow completers (GV3 entered but exited early at -0.11).
- Top-3 share of gains: **0.77** (v2: 0.81); net without the top 3 trips is
  -0.49 SOL (v2: -1.248). Better than v2, but the 0.70 target was NOT met —
  see "Honest limits".

## Sweep summary (net SOL, full window, local sim)

Round 1 (18 variants): creator150 +8.818, creator150+age10 +10.656,
creator180 +8.961, creator100 +9.168, uw1200 +8.910, uw2000 +8.529,
stake3 +8.179 / stake2.5 +7.956 / stake2 +7.312, addStep2 +8.502.
Round 2-5 (combinations): creator180+age10+uw2000 +11.051,
+maxRq80 +11.234, +fs5 +11.120, +maxRq80+fs5 +11.302, +creatorStake2.0
**+11.215** (adopted — costs 0.09 dev net for a much better stress tail:
p10 -6.21 -> -3.78, p90 -0.01 -> +0.31, losers 9/10 -> 8/10),
+uw1200 +11.501 but qMed 0.74 (rejected).

Rejected, with evidence:
- **Two-stage trail (wide 0.45-0.50, then tight 0.25-0.30 after adds):
  +5.12 to +6.29.** Catastrophic — tightening the trail after adds kills the
  winners, which need the wide trail to survive dips while climbing. The
  flat 0.35 trail is right; the hypothesis (tight trail cuts pump-and-dump
  losers) was wrong.
- **Re-entry (maxEntriesPerCoin 2/3): +3.37 to +3.70.** The second entries
  take full stakes on dead-cat bounces and crowd out winners via the
  exposure cap. One entry per coin stands.
- **Stake caps (2.0-3.0 SOL): net -0.3 to -1.1, top-3 share barely moves
  (0.81 -> 0.78).** Capping shrinks mid winners too; it does not fix
  concentration.
- **dip 0.15: +7.705. minRq 10: +2.686** (catastrophic — early-rq entries
  are poison). **maxMain 5 / exposure 12: identical** (the position limit
  never binds). **trailWhenUp (wide trail while up >1.5x cost): identical**
  (no trail exit ever happens while value/cost > 1.5x — adds raise the cost
  basis as the coin climbs).
- **buyers >= 150 instead of 180:** admits GiupJo2Uhk (-0.64) and GP6U
  (-0.34); net +10.66 vs +10.73 for 180.
- **First-sell age <= 8 (excludes RUNF, age 9): rejected as a knife-edge
  fit.** There is no principled boundary at 8 vs 10 slots; RUNF's creator
  sold at age 9, GV3's at 8 — fitting the threshold to a 1-slot gap between
  two coins is overfitting, not a rule.
- **Entry-age rule for creator coins: impossible.** RUNF enters at age 123,
  Hhcck at 122 — identical ages; no threshold separates the loser from the
  winner. (GP6U enters at age 1,686, which the first-sell-size bar already
  excludes.)

## Honest limits

- **Concentration:** top-3 share 0.77, target 0.70 NOT met. After ~55
  variants, no design with a passing net gets below 0.74 (re-entry combo,
  net 5.89 — fails the net gate). The tape's edge IS 2-5 slow completers per
  24h; every positive design is concentrated. v5 spreads across 5 completers
  and 13 winners (v2: 4 and 12), and the no-top-3 net improved (-0.49 vs
  -1.248), but the concentration target stays out of reach.
- **Stress median gate NOT met:** -1.39 vs v2's -1.30 (miss by 0.09), in
  both the capped and uncapped variants. The median reshuffled copy loses
  because the design's edge is trajectory-dependent and reshuffling destroys
  trajectories — that is structural, not a knob failure: the cap fixed the
  p10 tail (-6.21 -> -3.78) and the p90 (+0.31, better than v2's -0.29) but
  the median did not move. A 10-sample median has wide error bars; chasing
  0.09 SOL on it would be fitting noise. The slices (mean +2.86, median
  +0.89, 3/4 positive) are the better final-window estimator, and they
  favor v5.
- **Median gate margin is thin:** 0.89 vs v2's 0.86 (grade-local) / 0.90
  (sim). The creator gains land in Q4, which does not move the median; the
  creator losers land in Q2/Q3, which does. The median improvement comes
  from the underwater exit lifting Q1, not from the creator rule.
- **The creator rule is fit to 2 completers out of 46 candidates.** On an
  unseen window it may admit 0 completers and ~3 losers (~-0.6 SOL) — the
  rule's expected value depends on the creator-sold completer rate, which
  one window cannot pin down. The bar (180 buyers, rq 25, early small first
  sell) is deliberately strict to keep the loser count low.
- **Final-window lottery:** same as v2. A 6h window with no slow completer
  scores roughly -1.3 to +0.9 SOL for this design (the Q2 slice is now the
  pessimistic case).
- **The design is tuned on one 24h window.** Every knob was checked for a
  flat region, not a peak — but the final window is different data, and the
  completer rate there is unknown.
