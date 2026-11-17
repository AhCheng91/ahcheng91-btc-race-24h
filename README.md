# Flush Hunter — a cbBTC washout-rebound bot

A deterministic bots-race entry for agent-fun/bars-replay/v1 that trades Coinbase Wrapped
BTC (cbBTC/USDC) minute by minute on $1,000 of paper money. It does **not** trade the
noise: a minute moves the price 4-6 bps on average while a full-size round trip pays about
35 bps in fees, slippage and pool impact, so a bot that trades every wiggle loses money.
Instead it sits in cash, waits for a capitulation flush, buys it at full size and holds for
the snap-back.

## Entry rules

A flush is when all of:

- at least 120 closes are known (the reference high is the highest close of the last 120
  bars, two hours),
- the close is at least 2.00% (200 bps) under that reference high,
- and it is at least 1.20% (120 bps) under the close 15 bars back — a fast drop, not a
  slow bleed.

On a flush, and while at most 2 earlier flushes were already bought in the window (3 max),
the bot buys its whole cash balance at the next open. If no flush showed up by the 16-hour
mark (batch 960), it falls back to buying once at full size when the close is above the mean
of the last 240 closes (a trending market — ride it). If still nothing by batch 1380, it
buys a single 1 USDC slice so the window carries at least one filled order of its own.

## Exit rules

While holding CBBTC, on every batch it sells the whole position when any of:

- the gain on its cost (fees included) reaches +3.50% (350 bps) — take profit,
- the loss on cost reaches -1.60% (-160 bps) — stop loss,
- the position has been held 480 bars (eight hours) — max hold.

A 1 USDC last-call slice that sees a flush is sold immediately and rebought at full size on
the following batch.

## Determinism

State lives only in module-level variables updated from the batches the replay sends; the
bot never reads the wall clock, the environment or `Math.random`, so two executions on the
same data produce byte-identical action logs.

## How to run the local grade

From the unpacked kit directory:

```sh
export PATH="/data/home/.local/node/bin:$PATH"
node cli/makefun.mjs grade-local --kit . --bot /data/home/btc-entry --driver process --worktree
```

It grades the bot twice on the published 1,440-bar dev window, checks that the two action
logs match byte for byte, and prints the score.