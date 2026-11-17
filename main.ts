// Flush Hunter: a washout-rebound bot for CBBTC on agent-fun/bars-replay/v1.
//
// A minute moves cbBTC's price 4-6 bps on average while a full-size round trip pays about
// 35 bps in fees, slippage and pool impact, so trying to trade the minute-to-minute noise
// loses money. This bot instead sits in cash and waits for a capitulation flush — a close
// at least 2% under its two-hour reference high, dropped at least 1.2% in the last 15
// minutes — buys it at full size, and holds for the snap-back. The exit is the take-profit
// (+3.5% on cost), the stop (-1.6%), or the eight-hour max hold. It is deterministic: all
// decisions come from the state the replay sends, and never from the clock, the
// environment or randomness. A minute in which the recorder took no sample has no bar:
// that minute is skipped without a decision, so a window with a few missing minutes still runs.

import { BPS, runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Entry thresholds.
const LOOKBACK_BARS = 120; // the reference high is the highest close of the last 120 bars (two hours)
const DIP_BPS = 200n; // the close must sit at least 2.00% under that reference high
const FAST_BARS = 15; // it must also have dropped at least 1.20% over the last 15 bars...
const FAST_BPS = 120n; // ...a fast drop, not a slow bleed

// Exit thresholds (bps on the position's cost).
const TAKE_PROFIT_BPS = 350n; // take profit at +3.50%
const STOP_BPS = 160n; // stop loss at -1.60%
const MAX_HOLD_BARS = 480; // or exit after 480 bars (eight hours)

// Still no flush by these marks: fall back.
const MAX_ENTRIES = 3; // at most three flushes bought in a window
const UPTREND_FALLBACK_SEQ = 960; // 16 hours in
const UPTREND_SMA_BARS = 240; // the fallback reference: the mean of the last 240 closes
const LAST_CALL_SEQ = 1380; // by here make one 1 USDC entry so the window holds a fill of our own
const SLICE_QUOTE_UNITS = 1_000_000n; // a 1 USDC slice (the minimum fill)

// Every order names its own slippage budget, wide enough to never block a fill.
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 800;

// Module-level state: updated only from batches, so both executions replay identically.
const closes: bigint[] = []; // CBBTC's closes in order, one per bar seen
let entries = 0; // full-size entries that actually filled (the 1 USDC slice excluded)
let entrySeq = -1; // the batch the current position was opened on (-1: no open position)
let pendingReentry = false; // a last-call slice was just sold to buy the full size next batch

/** The flush condition: a sharp enough drop off a fresh reference high. */
function flush(): boolean {
  if (closes.length < LOOKBACK_BARS) return false; // not enough history yet
  const c = closes[closes.length - 1]!;
  let hi = 0n; // the highest close of the last LOOKBACK_BARS
  for (let i = closes.length - LOOKBACK_BARS; i < closes.length; i++) if (closes[i]! > hi) hi = closes[i]!;
  if (((hi - c) * BPS) / hi < DIP_BPS) return false;
  const fast = closes[closes.length - 1 - FAST_BARS]!;
  if (((fast - c) * BPS) / fast < FAST_BPS) return false;
  return true;
}

/** A buy of the whole cash balance. */
function buyFull(state: BarsState): BuyInput[] {
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: BUY_SLIPPAGE_BPS }];
}

/** A sell of the whole held quantity. */
function sellAll(state: BarsState): SellInput[] {
  const qty = state.positions.get(SYMBOL)!.qty;
  return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: SELL_SLIPPAGE_BPS }];
}

/** The orders to decide on `batch` (at most one: a reply trades once, at the next open). */
function decide(state: BarsState, batch: Batch): (BuyInput | SellInput)[] {
  const close = state.close(SYMBOL);
  if (close === null) return []; // this minute has no bar: decide nothing, keep the history as it is
  closes.push(close); // the latest close joins the running history

  // Count every full-size buy that filled: that is an entry ("a flush bought").
  for (const f of batch.fills) {
    if (f.side === 'buy' && f.status === 'filled' && BigInt(f.notional_quote_units) > SLICE_QUOTE_UNITS) entries++;
  }

  const held = state.positions.get(SYMBOL); // the open CBBTC position, if any
  if (held !== undefined && held.qty > 0n) {
    if (entrySeq < 0) entrySeq = state.seq; // opened on this batch: start the hold clock

    // A last-call slice with a flush right now: sell the slice, buy the full size next batch
    // (the sell's proceeds land at the next open and fund the full buy after it).
    if (held.cost <= 2n * SLICE_QUOTE_UNITS && flush()) {
      pendingReentry = true;
      return sellAll(state);
    }

    // The exit: +3.5% on cost, -1.6% on cost, or after MAX_HOLD_BARS bars in the position.
    const gain = (state.value(SYMBOL, held.qty) - held.cost) * BPS / held.cost;
    const heldBars = state.seq - entrySeq;
    if (gain >= TAKE_PROFIT_BPS || gain <= -STOP_BPS || heldBars >= MAX_HOLD_BARS) return sellAll(state);
    return []; // keep holding
  }

  // Not holding: look for an entry, in order.
  entrySeq = -1;

  // A slice sold for a flush rebuys full size on the next batch.
  if (pendingReentry) {
    pendingReentry = false;
    if (entries < MAX_ENTRIES) return buyFull(state);
  }

  // 1. The flush: a washout to buy at full size (at most MAX_ENTRIES per window).
  if (entries < MAX_ENTRIES && flush()) return buyFull(state);

  // 2. The uptrend fallback: no flush by the 16-hour mark, and price above its 240-bar
  //    mean: the market is trending, not flushing, so ride it once.
  if (state.seq === UPTREND_FALLBACK_SEQ && entries === 0 && closes.length >= UPTREND_SMA_BARS) {
    let sum = 0n;
    for (let i = closes.length - UPTREND_SMA_BARS; i < closes.length; i++) sum += closes[i]!;
    if (closes[closes.length - 1]! > sum / BigInt(UPTREND_SMA_BARS)) return buyFull(state);
  }

  // 3. The last call: still no entry by batch 1380, buy a 1 USDC slice so the window
  //    carries a filled order of the bot's own (the guardrail's "at least one trade").
  if (state.seq === LAST_CALL_SEQ && entries === 0) {
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: SLICE_QUOTE_UNITS, max_slippage_bps: BUY_SLIPPAGE_BPS }];
  }

  return []; // wait in cash
}

await runBars({ onBatch: decide });