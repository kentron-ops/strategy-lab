import { describe, expect, it } from 'vitest'
import { computeMetrics, sliceBy, buyAndHoldBenchmark } from './metrics'
import { kellyFraction, meanInterval, wilsonInterval } from '../util/stats'
import type { EquityPoint, Trade } from '../types'

/** Minimal trade builder — only the fields the metrics actually read. */
function trade(netPnl: number, over: Partial<Trade> = {}): Trade {
  const risk = 100
  return {
    id: 't', strategyId: 's', side: 'LONG', qty: 1, tag: '',
    entryBar: 0, entryTime: 0, entryPrice: 100,
    exitBar: 10, exitTime: 10 * 300000, exitPrice: 101,
    stopLoss: 95, takeProfit: 110, rDistance: 5, riskAmount: risk,
    exitReason: netPnl >= 0 ? 'TARGET' : 'STOP',
    grossPnl: netPnl, costs: 0, netPnl, r: netPnl / risk,
    mfeR: 1, maeR: 0.5, barsHeld: 10, holdingMs: 10 * 300000,
    ambiguous: false, excluded: false,
    session: 'LONDON', regime: { vol: 'MID_VOL', trend: 'RANGING' },
    equityAfter: 0, reasons: [],
    ...over,
  }
}

const curve = (values: number[]): EquityPoint[] => {
  let peak = values[0] ?? 0
  return values.map((equity, bar) => {
    peak = Math.max(peak, equity)
    return {
      t: bar * 300000, bar, equity,
      drawdown: peak - equity,
      drawdownPct: peak > 0 ? ((peak - equity) / peak) * 100 : 0,
      peak,
    }
  })
}

describe('metrics arithmetic', () => {
  const trades = [trade(200), trade(-100), trade(300), trade(-100), trade(-100)]
  const m = computeMetrics(trades, curve([1000, 1200, 1100, 1400, 1300, 1200]), 1000, {
    barsInPosition: 30,
    totalBars: 100,
  })

  it('counts wins, losses and totals', () => {
    expect(m.trades).toBe(5)
    expect(m.wins).toBe(2)
    expect(m.losses).toBe(3)
    expect(m.netPnl).toBeCloseTo(200, 10)
    expect(m.endingEquity).toBeCloseTo(1200, 10)
    expect(m.returnPct).toBeCloseTo(20, 10)
  })

  it('computes profit factor as gross profit over gross loss', () => {
    expect(m.profitFactor).toBeCloseTo(500 / 300, 10)
  })

  it('computes expectancy per trade', () => {
    expect(m.expectancy).toBeCloseTo(40, 10)
    expect(m.expectancyR.point).toBeCloseTo(0.4, 10)
  })

  it('reports exposure', () => {
    expect(m.exposurePct).toBeCloseTo(30, 10)
  })

  it('finds the longest losing streak', () => {
    expect(m.maxConsecutiveLosses).toBe(2)
    expect(m.maxConsecutiveWins).toBe(1)
  })

  it('reports max drawdown from the curve', () => {
    expect(m.maxDrawdown).toBeCloseTo(200, 10)
  })
})

describe('honesty guardrails', () => {
  it('marks a small sample as inadequate', () => {
    const m = computeMetrics([trade(100), trade(100)], curve([1000, 1100, 1200]), 1000, {
      barsInPosition: 2, totalBars: 10,
    })
    expect(m.sampleAdequate).toBe(false)
    expect(m.winRate.n).toBe(2)
  })

  it('marks a large sample as adequate', () => {
    const trades = Array.from({ length: 40 }, (_, i) => trade(i % 3 === 0 ? -100 : 60))
    const m = computeMetrics(trades, curve([1000]), 1000, { barsInPosition: 1, totalBars: 10 })
    expect(m.sampleAdequate).toBe(true)
  })

  it('never reports a win rate without its sample size', () => {
    const m = computeMetrics([trade(100)], curve([1000, 1100]), 1000, {
      barsInPosition: 1, totalBars: 10,
    })
    expect(m.winRate.n).toBe(1)
    expect(m.winRate.high - m.winRate.low).toBeGreaterThan(0.5) // usefully wide
  })

  it('the confidence interval narrows as the sample grows', () => {
    const small = wilsonInterval(6, 10)
    const large = wilsonInterval(600, 1000)
    expect(small.high - small.low).toBeGreaterThan(large.high - large.low)
  })

  it('a single observation gives an infinitely wide mean interval, not a point estimate', () => {
    const ci = meanInterval([0.5])
    expect(ci.low).toBe(Number.NEGATIVE_INFINITY)
    expect(ci.high).toBe(Number.POSITIVE_INFINITY)
  })

  it('always states the Sharpe assumption in words', () => {
    const trades = Array.from({ length: 30 }, (_, i) =>
      trade(i % 2 ? 100 : -50, { entryTime: i * 86400000, exitTime: i * 86400000 + 3600000 }),
    )
    const m = computeMetrics(trades, curve([1000]), 1000, { barsInPosition: 1, totalBars: 10 })
    expect(m.sharpeAssumption.length).toBeGreaterThan(20)
    expect(m.sharpeAssumption).toMatch(/risk-free|not computable/i)
  })

  it('handles the empty case without producing NaN', () => {
    const m = computeMetrics([], [], 1000, { barsInPosition: 0, totalBars: 0 })
    for (const [key, value] of Object.entries(m)) {
      if (typeof value === 'number') {
        expect(Number.isNaN(value), `${key} is NaN`).toBe(false)
      }
    }
    expect(m.trades).toBe(0)
    expect(m.sampleAdequate).toBe(false)
  })
})

describe('expectancy beats win rate — the point of the whole book', () => {
  it('a 40% win rate at 3R beats a 60% win rate at 1R', () => {
    const highWinRate = Array.from({ length: 100 }, (_, i) => trade(i < 60 ? 100 : -100))
    const asymmetric = Array.from({ length: 100 }, (_, i) => trade(i < 40 ? 300 : -100))

    const a = computeMetrics(highWinRate, curve([1000]), 1000, { barsInPosition: 1, totalBars: 10 })
    const b = computeMetrics(asymmetric, curve([1000]), 1000, { barsInPosition: 1, totalBars: 10 })

    expect(a.winRate.point).toBeGreaterThan(b.winRate.point)
    expect(b.expectancyR.point).toBeGreaterThan(a.expectancyR.point)
    // 0.6×1 + 0.4×(−1) = 0.2R   vs   0.4×3 + 0.6×(−1) = 0.6R
    expect(a.expectancyR.point).toBeCloseTo(0.2, 10)
    expect(b.expectancyR.point).toBeCloseTo(0.6, 10)
  })
})

describe('slices', () => {
  const trades = [
    ...Array.from({ length: 20 }, () => trade(150, { session: 'LONDON' })),
    ...Array.from({ length: 20 }, () => trade(-100, { session: 'ASIA' })),
    ...Array.from({ length: 3 }, () => trade(500, { session: 'NY' })),
  ]

  it('ranks by expectancy and exposes where the edge actually lives', () => {
    const slices = sliceBy(trades, (t) => t.session)
    const asia = slices.find((s) => s.key === 'ASIA')!
    const london = slices.find((s) => s.key === 'LONDON')!
    expect(london.expectancyR.point).toBeGreaterThan(asia.expectancyR.point)
    expect(asia.netPnl).toBeLessThan(0)
  })

  it('flags a thin slice as inadequate rather than crowning it', () => {
    const slices = sliceBy(trades, (t) => t.session, undefined, 10)
    const ny = slices.find((s) => s.key === 'NY')!
    // The best-looking slice is also the one with almost no evidence behind it.
    expect(ny.expectancyR.point).toBeGreaterThan(0)
    expect(ny.adequate).toBe(false)
    expect(ny.trades).toBe(3)
  })
})

describe('benchmarks', () => {
  it('reports what simply holding would have done', () => {
    const b = buyAndHoldBenchmark([{ c: 100 }, { c: 110 }], 1000)
    expect(b.returnPct).toBeCloseTo(10, 10)
    expect(b.netPnl).toBeCloseTo(100, 10)
  })
})

describe('Kelly', () => {
  it('is zero when there is no edge', () => {
    expect(kellyFraction(0.5, 1)).toBe(0)
    expect(kellyFraction(0.3, 1)).toBe(0)
  })

  it('grows with the edge', () => {
    expect(kellyFraction(0.6, 2)).toBeGreaterThan(kellyFraction(0.55, 2))
  })
})
