import type { Candle, Dataset } from '../types'
import type {
  JournalEntry,
  ReconciliationIssue,
  ReconciliationResult,
} from './types'

/**
 * Reconciliation — the feature that turns a diary into a record.
 *
 * For every logged trade, fetch the market's own OHLC over that window and ask:
 * could this price have happened at this time? A fill outside the bar's range is
 * either a typo, a misremembering, or a story. All three are worth catching, and
 * none of them can be caught by a journal that only stores what you type.
 *
 * A small tolerance is allowed, because the trader's broker feed is not the same
 * feed as the reference data: spreads, a different liquidity provider, and
 * rounding all move the last decimal legitimately. The tolerance is explicit and
 * reported, not hidden.
 */

export interface ReconcileOptions {
  /** Allowed deviation as a fraction of the bar's range. */
  rangeTolerance: number
  /** Additional absolute allowance, in price units, for spread differences. */
  absoluteTolerance: number
}

export const DEFAULT_RECONCILE: ReconcileOptions = {
  rangeTolerance: 0.25,
  absoluteTolerance: 0.5,
}

/** Index of the bar covering `t`, or the nearest preceding bar. −1 if before the data. */
export function findBar(candles: Candle[], t: number, barMs: number): number {
  if (!candles.length) return -1
  if (t < candles[0].t) return -1
  if (t > candles[candles.length - 1].t + barMs) return -1

  let lo = 0
  let hi = candles.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const start = candles[mid].t
    const end = start + barMs
    if (t < start) hi = mid - 1
    else if (t >= end) lo = mid + 1
    else return mid
  }
  return Math.min(candles.length - 1, Math.max(0, hi))
}

export function reconcileEntry(
  entry: JournalEntry,
  dataset: Dataset,
  barMs: number,
  opts: ReconcileOptions = DEFAULT_RECONCILE,
): ReconciliationResult {
  const issues: ReconciliationIssue[] = []
  const candles = dataset.candles

  if (
    entry.symbol &&
    dataset.symbol &&
    !symbolsMatch(entry.symbol, dataset.symbol)
  ) {
    issues.push({
      code: 'SYMBOL_MISMATCH',
      message: `Trade is on ${entry.symbol} but the reference data is ${dataset.symbol}. The check below is meaningless unless these are the same market.`,
    })
  }

  if (entry.exitTime < entry.entryTime) {
    issues.push({
      code: 'EXIT_BEFORE_ENTRY',
      message: 'The exit is logged before the entry.',
    })
  }

  const entryBar = findBar(candles, entry.entryTime, barMs)
  const exitBar = findBar(candles, entry.exitTime, barMs)

  if (entryBar < 0) {
    issues.push({
      code: 'ENTRY_TIME_MISSING',
      message: 'No market data covers the entry time. Load data spanning this trade to verify it.',
    })
  }
  if (exitBar < 0) {
    issues.push({
      code: 'EXIT_TIME_MISSING',
      message: 'No market data covers the exit time.',
    })
  }

  if (entryBar < 0 || exitBar < 0) {
    return {
      verdict: 'NO_DATA',
      issues,
      entryBar: entryBar >= 0 ? entryBar : null,
      exitBar: exitBar >= 0 ? exitBar : null,
      actualHigh: null,
      actualLow: null,
      checkedAgainst: `${dataset.symbol} ${dataset.timeframe} (${dataset.source})`,
    }
  }

  const entryDeviation = priceDeviation(candles[entryBar], entry.entryPrice, opts)
  if (entryDeviation > 0) {
    issues.push({
      code: 'ENTRY_PRICE_IMPOSSIBLE',
      message: `Logged entry ${entry.entryPrice} sits ${entryDeviation.toFixed(4)} outside the bar's range (${candles[entryBar].l}–${candles[entryBar].h}). That price was not available at that moment.`,
      distance: entryDeviation,
    })
  }

  const exitDeviation = priceDeviation(candles[exitBar], entry.exitPrice, opts)
  if (exitDeviation > 0) {
    issues.push({
      code: 'EXIT_PRICE_IMPOSSIBLE',
      message: `Logged exit ${entry.exitPrice} sits ${exitDeviation.toFixed(4)} outside the bar's range (${candles[exitBar].l}–${candles[exitBar].h}).`,
      distance: exitDeviation,
    })
  }

  const lo = Math.min(entryBar, exitBar)
  const hi = Math.max(entryBar, exitBar)
  let actualHigh = -Infinity
  let actualLow = Infinity
  for (let i = lo; i <= hi; i++) {
    if (candles[i].h > actualHigh) actualHigh = candles[i].h
    if (candles[i].l < actualLow) actualLow = candles[i].l
  }

  // If a stop was logged but the market never reached it, the trade did not end
  // the way it was described — a quiet but very common self-deception.
  if (entry.stopLoss !== null) {
    const stopTouched =
      entry.side === 'LONG' ? actualLow <= entry.stopLoss : actualHigh >= entry.stopLoss
    const exitedAtStop =
      Math.abs(entry.exitPrice - entry.stopLoss) <= opts.absoluteTolerance
    if (exitedAtStop && !stopTouched) {
      issues.push({
        code: 'STOP_NEVER_TOUCHED_BUT_STOPPED',
        message: `The exit matches the logged stop, but price never reached it (range over the hold: ${actualLow.toFixed(4)}–${actualHigh.toFixed(4)}). The position was probably closed by hand.`,
      })
    }
  }

  const hard = issues.filter(
    (i) => i.code === 'ENTRY_PRICE_IMPOSSIBLE' || i.code === 'EXIT_PRICE_IMPOSSIBLE',
  )

  const verdict = hard.length
    ? 'IMPLAUSIBLE'
    : issues.length
      ? 'PARTIAL'
      : 'VERIFIED'

  return {
    verdict,
    issues,
    entryBar,
    exitBar,
    actualHigh: Number.isFinite(actualHigh) ? actualHigh : null,
    actualLow: Number.isFinite(actualLow) ? actualLow : null,
    checkedAgainst: `${dataset.symbol} ${dataset.timeframe} (${dataset.source})`,
  }
}

/** How far outside the bar the price sits, after tolerance. 0 = inside. */
function priceDeviation(
  bar: Candle,
  price: number,
  opts: ReconcileOptions,
): number {
  const range = bar.h - bar.l
  const tol = Math.max(range * opts.rangeTolerance, opts.absoluteTolerance)
  if (price > bar.h + tol) return price - (bar.h + tol)
  if (price < bar.l - tol) return bar.l - tol - price
  return 0
}

function symbolsMatch(a: string, b: string): boolean {
  const norm = (s: string): string =>
    s.toUpperCase().replace(/[^A-Z]/g, '').replace(/SYNTHETIC|TEST/g, '')
  const na = norm(a)
  const nb = norm(b)
  if (!na || !nb) return true
  return na.includes(nb) || nb.includes(na)
}

/**
 * Measure what the trade COULD have made, from real data.
 * This is what turns "I got out too early" from a feeling into a number.
 */
export function measureExcursions(
  entry: JournalEntry,
  dataset: Dataset,
  barMs: number,
): { mfeR: number | null; maeR: number | null; barsHeld: number | null } {
  if (entry.stopLoss === null) return { mfeR: null, maeR: null, barsHeld: null }
  const rDistance = Math.abs(entry.entryPrice - entry.stopLoss)
  if (rDistance <= 0) return { mfeR: null, maeR: null, barsHeld: null }

  const from = findBar(dataset.candles, entry.entryTime, barMs)
  const to = findBar(dataset.candles, entry.exitTime, barMs)
  if (from < 0 || to < 0) return { mfeR: null, maeR: null, barsHeld: null }

  let best = -Infinity
  let worst = -Infinity
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
    const c = dataset.candles[i]
    const favourable =
      entry.side === 'LONG' ? c.h - entry.entryPrice : entry.entryPrice - c.l
    const adverse =
      entry.side === 'LONG' ? entry.entryPrice - c.l : c.h - entry.entryPrice
    if (favourable > best) best = favourable
    if (adverse > worst) worst = adverse
  }

  return {
    mfeR: Number.isFinite(best) ? best / rDistance : null,
    maeR: Number.isFinite(worst) ? worst / rDistance : null,
    barsHeld: Math.abs(to - from),
  }
}
