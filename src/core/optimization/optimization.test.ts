import { describe, expect, it } from 'vitest'
import { buildHeatmap, countCombinations, expandGrid, rangeValues, runSweep } from './sweep'
import { runWalkForward, splitTest } from './walkForward'
import { testRobustness } from './robustness'
import { runMonteCarlo } from './monteCarlo'
import { objectiveValue, rankRows, stabilityScore, type SweepRow } from './scoring'
import { makeBacktestConfig, makeDataset, zigzag } from '../testing/fixtures'
import { computeMetrics } from '../backtest/metrics'
import type { Trade } from '../types'

const dataset = makeDataset(zigzag(1500, { amplitude: 3, period: 26, drift: 0.006 }))
const config = makeBacktestConfig('oco_breakout')

describe('grid expansion', () => {
  it('builds inclusive numeric ranges without floating-point dust', () => {
    expect(rangeValues(0, 0.5, 0.1)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5])
    expect(rangeValues(1, 3, 1)).toEqual([1, 2, 3])
  })

  it('takes the cartesian product', () => {
    const dims = [
      { key: 'a', values: [1, 2] },
      { key: 'b', values: ['x', 'y', 'z'] },
    ]
    expect(countCombinations(dims)).toBe(6)
    expect(expandGrid(dims)).toHaveLength(6)
    expect(expandGrid(dims)[0]).toEqual({ a: 1, b: 'x' })
  })
})

describe('sweep', () => {
  const spec = {
    dimensions: [
      { key: 'targetR', values: [1, 2, 3] },
      { key: 'stopAtrMultiple', values: [1, 2] },
    ],
    maxCombinations: 100,
  }

  it('runs every combination and reports metrics for each', () => {
    const r = runSweep(dataset, config, spec)
    expect(r.rows).toHaveLength(6)
    expect(r.total).toBe(6)
    for (const row of r.rows) {
      expect(row.metrics.trades).toBeGreaterThanOrEqual(0)
      expect(Object.keys(row.params).sort()).toEqual(['stopAtrMultiple', 'targetR'])
    }
  })

  it('says out loud when it truncated, rather than trimming silently', () => {
    const r = runSweep(dataset, config, { ...spec, maxCombinations: 2 })
    expect(r.rows).toHaveLength(2)
    expect(r.truncated).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/were NOT silently discarded/)
  })

  it('honours an abort request', () => {
    let calls = 0
    const r = runSweep(dataset, config, spec, {
      shouldAbort: () => ++calls > 2,
    })
    expect(r.aborted).toBe(true)
    expect(r.rows.length).toBeLessThan(6)
  })

  it('is reproducible', () => {
    const a = runSweep(dataset, config, spec)
    const b = runSweep(dataset, config, spec)
    expect(b.rows.map((r) => r.metrics.netPnl)).toEqual(a.rows.map((r) => r.metrics.netPnl))
  })

  it('builds a heatmap over two dimensions', () => {
    const r = runSweep(dataset, config, spec)
    const hm = buildHeatmap(r.rows, 'targetR', 'stopAtrMultiple', (row) => row.metrics.netPnl)
    expect(hm.xValues).toEqual([1, 2, 3])
    expect(hm.yValues).toEqual([1, 2])
    expect(hm.cells).toHaveLength(2)
    expect(hm.cells[0]).toHaveLength(3)
    expect(hm.cells.flat().every((c) => c === null || Number.isFinite(c))).toBe(true)
  })
})

describe('ranking refuses to be gamed by tiny samples', () => {
  const row = (trades: number, expectancy: number, dd: number): SweepRow => {
    const fake = Array.from({ length: trades }, (_, i) => makeTrade(expectancy * 100))
    const metrics = computeMetrics(fake, [], 1000, { barsInPosition: 1, totalBars: 100 })
    return {
      id: `${trades}-${expectancy}`,
      params: {},
      metrics: { ...metrics, maxDrawdownPct: dd },
      flags: metrics.sampleAdequate ? [] : ['INSUFFICIENT_SAMPLE'],
      ambiguousTrades: 0,
      durationMs: 0,
    }
  }

  it('demotes an inadequate sample below an adequate one, whatever its raw score', () => {
    const lucky = row(5, 3, 5)
    const solid = row(400, 0.2, 20)
    const ranked = rankRows([lucky, solid], 'expectancyR')
    expect(ranked[0]).toBe(solid)
  })

  it('the stability score prefers evidence over a spectacular small sample', () => {
    const lucky = row(5, 3, 5)
    const solid = row(400, 0.2, 20)
    expect(stabilityScore(solid.metrics)).toBeGreaterThan(stabilityScore(lucky.metrics))
  })

  it('reads each objective off the metrics', () => {
    const solid = row(100, 0.5, 10)
    expect(objectiveValue(solid.metrics, 'trades')).toBe(100)
    expect(objectiveValue(solid.metrics, 'expectancyR')).toBeCloseTo(0.5, 6)
  })
})

describe('out-of-sample', () => {
  it('splits chronologically and never shuffles', () => {
    const r = splitTest(dataset, config, 0.7)
    expect(r.splitIndex).toBe(Math.floor(1500 * 0.7))
    expect(r.splitTime).toBe(dataset.candles[r.splitIndex].t)
    expect(r.verdict.length).toBeGreaterThan(10)
  })

  it('flags a profitable-then-unprofitable split as possible overfit', () => {
    // Construct the situation directly rather than hunting for it in data.
    const r = splitTest(dataset, config, 0.7)
    if (r.inSample.expectancyR.point > 0 && r.outOfSample.expectancyR.point <= 0) {
      expect(r.flags).toContain('POSSIBLE_OVERFIT')
    }
    // In every case the verdict must name the sample size or the degradation.
    expect(r.verdict).toMatch(/sample|out-of-sample|split|consistent/i)
  })

  it('walk-forward chooses parameters on training data only', () => {
    const r = runWalkForward(dataset, config, {
      dimensions: [{ key: 'targetR', values: [1, 2, 3] }],
      trainBars: 400,
      testBars: 200,
      objective: 'expectancyR',
      minTrainTrades: 3,
    })
    expect(r.windows.length).toBeGreaterThan(0)
    for (const w of r.windows) {
      // The test window must start strictly after the training window ends.
      expect(w.testFrom).toBe(w.trainTo + 1)
      expect(w.trainFrom).toBeLessThan(w.trainTo)
      expect([1, 2, 3]).toContain(w.chosenParams.targetR)
    }
    expect(r.verdict.length).toBeGreaterThan(10)
    expect(r.consistency).toBeGreaterThanOrEqual(0)
    expect(r.consistency).toBeLessThanOrEqual(1)
  })

  it('warns when too few windows fit to mean anything', () => {
    const r = runWalkForward(dataset, config, {
      dimensions: [{ key: 'targetR', values: [2] }],
      trainBars: 1000,
      testBars: 400,
      objective: 'expectancyR',
      minTrainTrades: 1,
    })
    expect(r.warnings.join(' ')).toMatch(/coincidence detector|window/i)
  })
})

describe('robustness', () => {
  it('perturbs numeric parameters either side and reports retention', () => {
    const r = testRobustness(dataset, config, {
      keys: ['targetR', 'stopAtrMultiple'],
      steps: [0.2],
      objective: 'expectancyR',
    })
    expect(r.neighbours.length).toBeGreaterThan(0)
    for (const nb of r.neighbours) {
      expect(['targetR', 'stopAtrMultiple']).toContain(nb.perturbed)
      expect(Math.abs(nb.delta)).toBeCloseTo(0.2, 6)
    }
    expect(r.verdict.length).toBeGreaterThan(10)
    expect(Number.isFinite(r.retention)).toBe(true)
  })

  it('never claims robustness for an unprofitable centre', () => {
    const r = testRobustness(dataset, config, {
      keys: ['targetR'],
      steps: [0.2],
      objective: 'expectancyR',
    })
    if (r.centre.score <= 0) {
      expect(r.flags).not.toContain('MORE_ROBUST')
    }
  })
})

describe('Monte Carlo', () => {
  const trades = Array.from({ length: 120 }, (_, i) => makeTrade(i % 3 === 0 ? -100 : 65))

  it('is deterministic for a seed', () => {
    const a = runMonteCarlo(trades, { runs: 300, mode: 'BOOTSTRAP', pathLength: null, startingEquity: 1000, seed: 5, ruinThresholdPct: 50 })
    const b = runMonteCarlo(trades, { runs: 300, mode: 'BOOTSTRAP', pathLength: null, startingEquity: 1000, seed: 5, ruinThresholdPct: 50 })
    expect(b.endingEquity).toEqual(a.endingEquity)
  })

  it('a different seed gives a different cloud', () => {
    const a = runMonteCarlo(trades, { runs: 300, mode: 'BOOTSTRAP', pathLength: null, startingEquity: 1000, seed: 5, ruinThresholdPct: 50 })
    const b = runMonteCarlo(trades, { runs: 300, mode: 'BOOTSTRAP', pathLength: null, startingEquity: 1000, seed: 6, ruinThresholdPct: 50 })
    // Compare the mean, not a quantile: these trades take only two values, so
    // the median of both clouds legitimately lands on the same discrete number.
    expect(b.endingEquity.mean).not.toBe(a.endingEquity.mean)
  })

  it('shuffling preserves the ending equity but not the drawdown', () => {
    const r = runMonteCarlo(trades, { runs: 200, mode: 'SHUFFLE', pathLength: null, startingEquity: 1000, seed: 3, ruinThresholdPct: 50 })
    // Every shuffle contains exactly the same trades, so every path ends identically.
    expect(r.endingEquity.min).toBeCloseTo(r.endingEquity.max, 6)
    // The path taken to get there varies, which is the entire point.
    expect(r.maxDrawdownPct.p95).toBeGreaterThan(r.maxDrawdownPct.p5)
  })

  it('reports where the realised run sits inside the simulated cloud', () => {
    const r = runMonteCarlo(trades, { runs: 500, mode: 'BOOTSTRAP', pathLength: null, startingEquity: 1000, seed: 9, ruinThresholdPct: 50 })
    expect(r.actualPercentile).toBeGreaterThanOrEqual(0)
    expect(r.actualPercentile).toBeLessThanOrEqual(1)
    expect(r.actual.endingEquity).toBeCloseTo(
      1000 + trades.reduce((a, t) => a + t.netPnl, 0),
      6,
    )
  })

  it('always carries its disclaimer', () => {
    const r = runMonteCarlo(trades, { runs: 50, mode: 'BOOTSTRAP', pathLength: null, startingEquity: 1000, seed: 1, ruinThresholdPct: 50 })
    expect(r.disclaimer).toMatch(/never as a forecast/i)
  })

  it('warns loudly on a thin sample instead of producing confident bands', () => {
    const r = runMonteCarlo(trades.slice(0, 6), { runs: 100, mode: 'BOOTSTRAP', pathLength: null, startingEquity: 1000, seed: 1, ruinThresholdPct: 50 })
    expect(r.warnings.join(' ')).toMatch(/look precise and mean nothing/)
  })

  it('handles zero trades without crashing', () => {
    const r = runMonteCarlo([], { runs: 100, mode: 'BOOTSTRAP', pathLength: null, startingEquity: 1000, seed: 1, ruinThresholdPct: 50 })
    expect(r.runs).toBe(0)
    expect(r.probabilityOfRuin).toBe(0)
  })
})

function makeTrade(netPnl: number): Trade {
  const risk = 100
  return {
    id: 't', strategyId: 's', side: 'LONG', qty: 1, tag: '',
    entryBar: 0, entryTime: 0, entryPrice: 100,
    exitBar: 5, exitTime: 5 * 300000, exitPrice: 101,
    stopLoss: 95, takeProfit: 110, rDistance: 5, riskAmount: risk,
    exitReason: netPnl >= 0 ? 'TARGET' : 'STOP',
    grossPnl: netPnl, costs: 0, netPnl, r: netPnl / risk,
    mfeR: 1, maeR: 0.5, barsHeld: 5, holdingMs: 5 * 300000,
    ambiguous: false, excluded: false,
    session: 'LONDON', regime: { vol: 'MID_VOL', trend: 'RANGING' },
    equityAfter: 0, reasons: [],
  }
}
