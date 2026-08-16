import { describe, expect, it } from 'vitest'
import type { Candle } from '../types'
import { runBacktest } from './engine'
import { computeIndicators } from '../indicators'
import { DEFAULT_INDICATORS } from '../types'
import { makeBacktestConfig, makeDataset, zigzag } from '../testing/fixtures'

/**
 * THE test.
 *
 * A backtester that peeks at the future is not slightly wrong — it is worthless,
 * and it is worthless in the most seductive way, because peeking always looks
 * like skill. This suite proves the engine cannot do it, by the only method that
 * actually proves it: mutate the future and demand the past not move.
 */

const SPLIT = 300
const TOTAL = 520

/** Replace every bar after `from` with something wildly different. */
function corruptFuture(candles: Candle[], from: number, factor: number): Candle[] {
  return candles.map((c, i) => {
    if (i <= from) return { ...c }
    return {
      t: c.t,
      o: c.o * factor,
      h: c.h * factor + 12,
      l: c.l * factor - 12,
      c: c.c * factor,
      v: (c.v ?? 0) * 3,
    }
  })
}

describe('no look-ahead', () => {
  const base = zigzag(TOTAL, { amplitude: 3, period: 24, drift: 0.01 })

  for (const strategyId of [
    'oco_breakout',
    'breakout_continuation',
    'simultaneous_hedge',
  ]) {
    it(`${strategyId}: results up to bar ${SPLIT} are unchanged when every later bar is corrupted`, () => {
      const cfg = makeBacktestConfig(
        strategyId,
        { toIndex: SPLIT },
        strategyId === 'breakout_continuation'
          ? { requireHtfAlignment: false, minAtrPercentile: 0, minRangeExpansion: 0, minBodyRatio: 0, sessionFilter: 'ALL' }
          : {},
      )

      const clean = runBacktest(makeDataset(base), cfg)
      const corrupted = runBacktest(makeDataset(corruptFuture(base, SPLIT, 4.7)), cfg)

      // Trades are the strongest statement: same entries, exits, sizes, P&L.
      expect(stripVolatileFields(corrupted.trades)).toEqual(
        stripVolatileFields(clean.trades),
      )
      expect(corrupted.metrics.netPnl).toBeCloseTo(clean.metrics.netPnl, 10)
      expect(corrupted.metrics.trades).toBe(clean.metrics.trades)
      expect(corrupted.equityCurve.map((p) => p.equity)).toEqual(
        clean.equityCurve.map((p) => p.equity),
      )
      expect(corrupted.rejections).toEqual(clean.rejections)
    })
  }

  it('produces at least one trade, so the test above is not vacuously true', () => {
    const cfg = makeBacktestConfig('oco_breakout', { toIndex: SPLIT })
    const result = runBacktest(makeDataset(base), cfg)
    expect(result.trades.length).toBeGreaterThan(0)
  })

  it('every indicator series is causal', () => {
    const corrupted = corruptFuture(base, SPLIT, 4.7)
    const a = computeIndicators(base, DEFAULT_INDICATORS, '5m')
    const b = computeIndicators(corrupted, DEFAULT_INDICATORS, '5m')

    const keys = [
      'atr',
      'emaFast',
      'emaSlow',
      'rsi',
      'adx',
      'highestHigh',
      'lowestLow',
      'atrPercentile',
      'bodyRatio',
      'rangeExpansion',
    ] as const

    for (const key of keys) {
      expect(
        b[key].slice(0, SPLIT + 1),
        `${key} changed at or before bar ${SPLIT} when the future was corrupted`,
      ).toEqual(a[key].slice(0, SPLIT + 1))
    }
    expect(b.htfTrend.slice(0, SPLIT + 1)).toEqual(a.htfTrend.slice(0, SPLIT + 1))
    expect(b.session.slice(0, SPLIT + 1)).toEqual(a.session.slice(0, SPLIT + 1))
  })

  it('an order placed on bar i cannot fill on bar i', () => {
    const cfg = makeBacktestConfig('oco_breakout')
    const result = runBacktest(makeDataset(base), cfg)
    const filled = result.orders.filter((o) => o.status === 'FILLED')
    expect(filled.length).toBeGreaterThan(0)
    for (const o of filled) {
      expect(o.filledBar).not.toBeNull()
      expect(o.filledBar as number).toBeGreaterThan(o.createdBar)
    }
  })

  it('range levels never include the bar the order is placed on', () => {
    // A breakout trigger derived from the current (still forming) bar's high
    // would let the engine buy a high it only knows about in hindsight.
    const candles = zigzag(200, { amplitude: 4, period: 30 })
    const cfg = makeBacktestConfig('oco_breakout', {}, { lookback: 10, bufferAtrMultiple: 0 })
    const result = runBacktest(makeDataset(candles), cfg)

    for (const o of result.orders) {
      if (o.side !== 'LONG' || o.type !== 'STOP') continue
      const window = candles.slice(o.createdBar - 10, o.createdBar)
      if (window.length < 10) continue
      const windowHigh = Math.max(...window.map((c) => c.h))
      expect(o.price).toBeCloseTo(windowHigh, 6)
    }
  })
})

/** Timestamps of computation are not part of the result's identity. */
function stripVolatileFields<T>(trades: T[]): T[] {
  return JSON.parse(JSON.stringify(trades))
}
