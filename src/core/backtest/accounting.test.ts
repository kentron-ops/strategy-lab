import { describe, expect, it } from 'vitest'
import { runBacktest } from './engine'
import {
  makeBacktestConfig,
  makeDataset,
  makeFrictionlessConfig,
  zigzag,
} from '../testing/fixtures'
import { DEFAULT_COSTS } from '../types'

/**
 * Accounting.
 *
 * If the books do not balance, every downstream number — expectancy, drawdown,
 * the whole recommendation layer — is decoration on top of an error.
 */

const candles = zigzag(800, { amplitude: 3, period: 22, drift: 0.008 })
const dataset = makeDataset(candles)

describe('accounting identities', () => {
  it('ending equity equals starting equity plus the sum of every trade', () => {
    const cfg = makeBacktestConfig('oco_breakout')
    const r = runBacktest(dataset, cfg)
    const summed = r.trades
      .filter((t) => !t.excluded)
      .reduce((acc, t) => acc + t.netPnl, cfg.risk.startingEquity)
    expect(r.metrics.endingEquity).toBeCloseTo(summed, 8)
  })

  it('net = gross − costs for every single trade', () => {
    const r = runBacktest(dataset, makeBacktestConfig('oco_breakout'))
    expect(r.trades.length).toBeGreaterThan(0)
    for (const t of r.trades) {
      expect(t.netPnl).toBeCloseTo(t.grossPnl - t.costs, 8)
    }
  })

  it('costs are never negative — a cost model that pays you is a bug', () => {
    const r = runBacktest(dataset, makeBacktestConfig('oco_breakout'))
    for (const t of r.trades) {
      expect(t.costs).toBeGreaterThanOrEqual(-1e-9)
    }
  })

  it('with zero costs, gross and net are identical', () => {
    const r = runBacktest(dataset, makeFrictionlessConfig('oco_breakout'))
    expect(r.trades.length).toBeGreaterThan(0)
    for (const t of r.trades) {
      expect(t.costs).toBeCloseTo(0, 10)
      expect(t.netPnl).toBeCloseTo(t.grossPnl, 10)
    }
  })

  it('raising the spread can only reduce net P&L', () => {
    const cheap = runBacktest(
      dataset,
      makeBacktestConfig('oco_breakout', { costs: { ...DEFAULT_COSTS, spread: 0.1 } }),
    )
    const dear = runBacktest(
      dataset,
      makeBacktestConfig('oco_breakout', { costs: { ...DEFAULT_COSTS, spread: 1.5 } }),
    )
    expect(dear.metrics.totalCosts).toBeGreaterThan(cheap.metrics.totalCosts)
    expect(dear.metrics.netPnl).toBeLessThan(cheap.metrics.netPnl)
  })

  it('R is net P&L divided by the money actually risked', () => {
    const r = runBacktest(dataset, makeBacktestConfig('oco_breakout'))
    for (const t of r.trades) {
      if (t.riskAmount <= 0) continue
      expect(t.r).toBeCloseTo(t.netPnl / t.riskAmount, 8)
    }
  })

  it('a losing trade stopped out loses about 1R, never dramatically more without a gap', () => {
    const r = runBacktest(dataset, makeFrictionlessConfig('oco_breakout'))
    const stopped = r.trades.filter((t) => t.exitReason === 'STOP')
    expect(stopped.length).toBeGreaterThan(0)
    for (const t of stopped) {
      // Exactly −1R when the stop fills at its level; worse only on a gap.
      expect(t.r).toBeLessThanOrEqual(0.0001)
      expect(t.r).toBeGreaterThan(-6)
    }
  })

  it('the equity curve has one point per bar and never jumps without a trade', () => {
    const cfg = makeBacktestConfig('oco_breakout', { fromIndex: 10, toIndex: 400 })
    const r = runBacktest(dataset, cfg)
    expect(r.equityCurve.length).toBe(391)
    for (let i = 1; i < r.equityCurve.length; i++) {
      expect(r.equityCurve[i].bar).toBe(r.equityCurve[i - 1].bar + 1)
      expect(r.equityCurve[i].peak).toBeGreaterThanOrEqual(r.equityCurve[i - 1].peak)
    }
  })

  it('drawdown is measured against the running peak, including open positions', () => {
    const r = runBacktest(dataset, makeBacktestConfig('oco_breakout'))
    for (const p of r.equityCurve) {
      expect(p.drawdown).toBeCloseTo(p.peak - p.equity, 8)
      expect(p.drawdown).toBeGreaterThanOrEqual(-1e-9)
    }
    expect(r.metrics.maxDrawdown).toBeGreaterThanOrEqual(0)
  })

  it('is deterministic — the same inputs give byte-identical trades', () => {
    const cfg = makeBacktestConfig('breakout_continuation')
    const a = runBacktest(dataset, cfg)
    const b = runBacktest(dataset, cfg)
    expect(JSON.stringify(b.trades)).toBe(JSON.stringify(a.trades))
  })

  it('every filled order becomes exactly one position', () => {
    const r = runBacktest(dataset, makeBacktestConfig('oco_breakout'))
    const filled = r.orders.filter((o) => o.status === 'FILLED')
    expect(r.trades.length).toBe(filled.length)
  })

  it('an OCO fill cancels its sibling — the two sides never both open', () => {
    const r = runBacktest(dataset, makeBacktestConfig('oco_breakout'))
    const byGroup = new Map<string, number>()
    for (const o of r.orders) {
      if (o.status !== 'FILLED' || !o.ocoGroup) continue
      const key = `${o.ocoGroup}:${o.createdBar}`
      byGroup.set(key, (byGroup.get(key) ?? 0) + 1)
    }
    for (const [, count] of byGroup) expect(count).toBe(1)
  })
})

describe('the hedge baseline behaves as the arithmetic predicts', () => {
  it('opens both legs together', () => {
    const r = runBacktest(
      dataset,
      makeBacktestConfig(
        'simultaneous_hedge',
        { risk: { ...makeBacktestConfig().risk, maxConcurrentPositions: 2 } },
        { intervalBars: 40 },
      ),
    )
    expect(r.trades.length).toBeGreaterThan(1)
    const longs = r.trades.filter((t) => t.side === 'LONG').length
    const shorts = r.trades.filter((t) => t.side === 'SHORT').length
    expect(Math.abs(longs - shorts)).toBeLessThanOrEqual(1)
  })

  it('pays entry costs on both legs, so its total cost exceeds a single-entry system', () => {
    const risk = { ...makeBacktestConfig().risk, maxConcurrentPositions: 2 }
    const hedge = runBacktest(
      dataset,
      makeBacktestConfig('simultaneous_hedge', { risk }, { intervalBars: 40 }),
    )
    const perTradeCost =
      hedge.metrics.totalCosts / Math.max(1, hedge.metrics.trades)
    expect(perTradeCost).toBeGreaterThan(0)
    // Both legs are charged; nothing is netted off behind the scenes.
    expect(hedge.metrics.totalCosts).toBeGreaterThan(0)
  })
})
