import type { Candle, IntrabarPolicy, Side } from '../types'

/**
 * Intrabar ambiguity — the credibility feature (§6).
 *
 * When a single bar's range contains both the stop and the target, OHLC alone
 * cannot tell you which was touched first. Silently choosing the profitable path
 * is the single most common way a backtest lies to its author.
 *
 * This module never guesses. It either resolves the bar with finer data, or it
 * reports the bar as ambiguous and applies the declared policy.
 */

export type IntrabarOutcome =
  | { kind: 'NONE' }
  | {
      kind: 'EXIT'
      reason: 'STOP' | 'TARGET'
      /** Raw price before spread/slippage. */
      price: number
      ambiguous: boolean
      /** True when the bar opened beyond the level and filled worse than it. */
      gapped: boolean
    }
  | { kind: 'AMBIGUOUS_SKIP' }

export interface LevelCheck {
  side: Side
  stopLoss: number
  takeProfit: number | null
}

/** Did this bar touch the stop? Gaps count. */
export function touchesStop(bar: Candle, side: Side, stop: number): boolean {
  return side === 'LONG' ? bar.l <= stop : bar.h >= stop
}

export function touchesTarget(bar: Candle, side: Side, target: number | null): boolean {
  if (target === null) return false
  return side === 'LONG' ? bar.h >= target : bar.l <= target
}

/**
 * Resolve what happened to an open position during one bar.
 *
 * `fine` is the finer-timeframe series covering this bar, when the user has
 * loaded one. With it, ambiguity is resolved exactly by walking the sub-bars in
 * order; the result is still flagged so the user knows it was contested.
 */
export function resolveBar(
  bar: Candle,
  levels: LevelCheck,
  policy: IntrabarPolicy,
  fine?: Candle[],
): IntrabarOutcome {
  const { side, stopLoss, takeProfit } = levels

  const hitStop = touchesStop(bar, side, stopLoss)
  const hitTarget = touchesTarget(bar, side, takeProfit)

  if (!hitStop && !hitTarget) return { kind: 'NONE' }

  // ── Gap handling: if the bar OPENED beyond a level, that level filled at the
  // open, at a price worse than the level itself. This is not ambiguous.
  const openBeyondStop = side === 'LONG' ? bar.o <= stopLoss : bar.o >= stopLoss
  const openBeyondTarget =
    takeProfit !== null && (side === 'LONG' ? bar.o >= takeProfit : bar.o <= takeProfit)

  if (openBeyondStop) {
    return { kind: 'EXIT', reason: 'STOP', price: bar.o, ambiguous: false, gapped: true }
  }
  if (openBeyondTarget) {
    return { kind: 'EXIT', reason: 'TARGET', price: bar.o, ambiguous: false, gapped: true }
  }

  if (hitStop !== hitTarget) {
    return hitStop
      ? { kind: 'EXIT', reason: 'STOP', price: stopLoss, ambiguous: false, gapped: false }
      : {
          kind: 'EXIT',
          reason: 'TARGET',
          price: takeProfit as number,
          ambiguous: false,
          gapped: false,
        }
  }

  // ── Both levels touched inside one bar.
  if (fine && fine.length) {
    const resolved = walkFine(fine, levels)
    if (resolved) return { ...resolved, ambiguous: true }
  }

  switch (policy) {
    case 'OPTIMISTIC':
      return {
        kind: 'EXIT',
        reason: 'TARGET',
        price: takeProfit as number,
        ambiguous: true,
        gapped: false,
      }
    case 'SKIP_AMBIGUOUS':
      return { kind: 'AMBIGUOUS_SKIP' }
    case 'CONSERVATIVE':
    default:
      return {
        kind: 'EXIT',
        reason: 'STOP',
        price: stopLoss,
        ambiguous: true,
        gapped: false,
      }
  }
}

/** Walk sub-bars in order and take whichever level is touched first. */
function walkFine(
  fine: Candle[],
  levels: LevelCheck,
): { kind: 'EXIT'; reason: 'STOP' | 'TARGET'; price: number; gapped: boolean } | null {
  for (const f of fine) {
    const s = touchesStop(f, levels.side, levels.stopLoss)
    const t = touchesTarget(f, levels.side, levels.takeProfit)
    if (s && t) {
      // Still contested at this resolution — conservative within the sub-bar.
      return { kind: 'EXIT', reason: 'STOP', price: levels.stopLoss, gapped: false }
    }
    if (s) return { kind: 'EXIT', reason: 'STOP', price: levels.stopLoss, gapped: false }
    if (t) {
      return {
        kind: 'EXIT',
        reason: 'TARGET',
        price: levels.takeProfit as number,
        gapped: false,
      }
    }
  }
  return null
}

/** Running MFE/MAE in R for an open position, updated bar by bar. */
export function updateExcursions(
  bar: Candle,
  side: Side,
  entryPrice: number,
  rDistance: number,
  currentMfeR: number,
  currentMaeR: number,
): { mfeR: number; maeR: number } {
  if (rDistance <= 0) return { mfeR: currentMfeR, maeR: currentMaeR }
  const favourable =
    side === 'LONG' ? bar.h - entryPrice : entryPrice - bar.l
  const adverse = side === 'LONG' ? entryPrice - bar.l : bar.h - entryPrice
  return {
    mfeR: Math.max(currentMfeR, favourable / rDistance),
    maeR: Math.max(currentMaeR, adverse / rDistance),
  }
}
