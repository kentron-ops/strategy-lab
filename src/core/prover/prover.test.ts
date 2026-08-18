import { describe, expect, it } from 'vitest'
import { proveEdge } from './prover'
import { bootstrapExpectancy, outlierDependence } from './guards'
import { makeBacktestConfig, makeDataset, zigzag } from '../testing/fixtures'
import { DEFAULT_ACCEPT_IF } from '../spec/types'
import type { AcceptIf } from '../spec/types'
import type { Trade } from '../types'
import { runWalkForward } from '../optimization/walkForward'

const acceptIf: AcceptIf = { ...DEFAULT_ACCEPT_IF, registeredAt: 0 }
const dataset = makeDataset(zigzag(1600, { amplitude: 3, period: 26, drift: 0.005 }))

describe('the trials penalty — the single most important guard', () => {
  const goodTrades = Array.from({ length: 80 }, (_, i) => fakeTrade(i % 3 === 0 ? -1 : 0.8))

  it('the same result gets less credible the more configurations were tried', () => {
    const few = bootstrapExpectancy(goodTrades, 1, { seed: 5 })
    const many = bootstrapExpectancy(goodTrades, 500, { seed: 5 })
    expect(few.point).toBeCloseTo(many.point, 10) // the estimate itself is unchanged
    expect(many.pValueAdjusted).toBeGreaterThan(few.pValueAdjusted) // the trust is not
  })

  it('enough trials can push any marginal result past the threshold', () => {
    const marginal = Array.from({ length: 40 }, (_, i) => fakeTrade(i % 2 === 0 ? -1 : 1.12))
    const one = bootstrapExpectancy(marginal, 1, { seed: 9 })
    const thousand = bootstrapExpectancy(marginal, 1000, { seed: 9 })
    expect(thousand.pValueAdjusted).toBeGreaterThanOrEqual(Math.min(1, one.pValueAdjusted))
    expect(thousand.pValueAdjusted).toBeGreaterThan(0.04)
  })

  it('a bootstrap p-value is never exactly zero', () => {
    const stellar = Array.from({ length: 100 }, () => fakeTrade(2))
    const b = bootstrapExpectancy(stellar, 1, { seed: 3 })
    expect(b.pValue).toBeGreaterThan(0)
  })

  it('refuses to produce intervals from fewer than 5 trades', () => {
    const b = bootstrapExpectancy([fakeTrade(3), fakeTrade(2)], 1)
    expect(b.low).toBe(Number.NEGATIVE_INFINITY)
    expect(b.pValueAdjusted).toBe(1)
  })
})

describe('outlier dependence', () => {
  it('catches the one-lucky-trade portfolio', () => {
    const trades = [fakeTrade(25), ...Array.from({ length: 30 }, () => fakeTrade(-0.4))]
    const check = outlierDependence(trades)
    expect(check.expectancyR).toBeGreaterThan(0)
    expect(check.survives).toBe(false)
    expect(check.note).toMatch(/outliers/)
  })

  it('passes a genuinely spread edge', () => {
    const trades = Array.from({ length: 60 }, (_, i) => fakeTrade(i % 3 === 0 ? -1 : 0.9))
    expect(outlierDependence(trades).survives).toBe(true)
  })
})

describe('purged walk-forward', () => {
  it('leaves an embargo gap between train and test', () => {
    const r = runWalkForward(dataset, makeBacktestConfig('oco_breakout'), {
      dimensions: [{ key: 'targetR', values: [2] }],
      trainBars: 400,
      testBars: 200,
      embargoBars: 50,
      objective: 'expectancyR',
      minTrainTrades: 1,
    })
    expect(r.windows.length).toBeGreaterThan(0)
    for (const w of r.windows) {
      expect(w.testFrom - w.trainTo).toBe(51) // trainTo + 1 + embargo
    }
  })
})

describe('proveEdge end to end', () => {
  it('produces a complete evidence card with all 7 gates', () => {
    const proof = proveEdge(dataset, makeBacktestConfig('oco_breakout'), {
      trials: 12,
      acceptIf,
      mcRuns: 300,
      randomRuns: 12,
      seed: 11,
    })
    expect(proof.gates).toHaveLength(7)
    expect(proof.gates.map((g) => g.id)).toEqual([1, 2, 3, 4, 5, 6, 7])
    for (const g of proof.gates) {
      expect(['PASS', 'FAIL', 'PENDING', 'SKIPPED']).toContain(g.status)
      expect(g.summary.length).toBeGreaterThan(5)
    }
    expect(['PROVEN', 'INSUFFICIENT_EVIDENCE', 'NOT_PROVEN']).toContain(proof.verdict)
    expect(['A', 'B', 'C', 'D']).toContain(proof.grade)
    expect(proof.guards.trials).toBe(12)
    expect(proof.headline).toMatch(/12/)
  })

  it('never says PROVEN with a pending forward gate at grade A', () => {
    const proof = proveEdge(dataset, makeBacktestConfig('oco_breakout'), {
      trials: 1,
      acceptIf,
      mcRuns: 200,
      randomRuns: 10,
      seed: 2,
    })
    const forward = proof.gates.find((g) => g.key === 'forward')!
    if (forward.status === 'PENDING' && proof.verdict === 'PROVEN') {
      expect(proof.grade).not.toBe('A')
    }
  })

  it('a zig-zag with no drift and honest costs is NOT proven', () => {
    // The generator has no exploitable structure at these costs; a verdict of
    // PROVEN here would itself be a bug in the Prover.
    const noise = makeDataset(zigzag(1600, { amplitude: 2.2, period: 17, drift: 0 }))
    const proof = proveEdge(noise, makeBacktestConfig('simultaneous_hedge'), {
      trials: 5,
      acceptIf,
      mcRuns: 200,
      randomRuns: 10,
      seed: 4,
    })
    expect(proof.verdict).not.toBe('PROVEN')
  })

  it('the word "certain" never appears in any prover output', () => {
    const proof = proveEdge(dataset, makeBacktestConfig('oco_breakout'), {
      trials: 3,
      acceptIf,
      mcRuns: 200,
      randomRuns: 10,
      seed: 6,
    })
    const text = JSON.stringify(proof).toLowerCase()
    expect(text.includes('certain')).toBe(false)
  })

  it('is deterministic for the same seed and inputs', () => {
    const run = () =>
      proveEdge(dataset, makeBacktestConfig('oco_breakout'), {
        trials: 4,
        acceptIf,
        mcRuns: 200,
        randomRuns: 10,
        seed: 21,
      })
    const a = run()
    const b = run()
    expect(b.verdict).toBe(a.verdict)
    expect(b.grade).toBe(a.grade)
    expect(b.gates.map((g) => g.status)).toEqual(a.gates.map((g) => g.status))
    expect(b.guards.bootstrap.pValueAdjusted).toBeCloseTo(a.guards.bootstrap.pValueAdjusted, 12)
  })

  it('reports when the pre-registered AcceptIf is not met', () => {
    const strict: AcceptIf = { minTrades: 10_000, minExpectancyR: 5, registeredAt: 0, revisions: 0 }
    const proof = proveEdge(dataset, makeBacktestConfig('oco_breakout'), {
      trials: 1,
      acceptIf: strict,
      mcRuns: 200,
      randomRuns: 10,
      seed: 8,
    })
    expect(proof.guards.acceptIfHeld).toBe(false)
    expect(proof.verdict).not.toBe('PROVEN')
  })
})

function fakeTrade(r: number): Trade {
  const risk = 100
  return {
    id: 't', strategyId: 's', side: 'LONG', qty: 1, tag: '',
    entryBar: 0, entryTime: 0, entryPrice: 100,
    exitBar: 5, exitTime: 1500000, exitPrice: 101,
    stopLoss: 95, takeProfit: 110, rDistance: 5, riskAmount: risk,
    exitReason: r >= 0 ? 'TARGET' : 'STOP',
    grossPnl: r * risk, costs: 0, netPnl: r * risk, r,
    mfeR: Math.max(0, r), maeR: Math.max(0, -r), barsHeld: 5, holdingMs: 1500000,
    ambiguous: false, excluded: false,
    session: 'LONDON', regime: { vol: 'MID_VOL', trend: 'RANGING' },
    equityAfter: 0, reasons: [],
  }
}
