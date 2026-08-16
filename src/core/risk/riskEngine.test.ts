import { describe, expect, it } from 'vitest'
import {
  applyTradeResult,
  checkLimits,
  initialRiskState,
  sizePosition,
} from './riskEngine'
import { DEFAULT_INSTRUMENT, DEFAULT_RISK } from '../types'
import type { Instrument, RiskConfig } from '../types'

const inst: Instrument = { ...DEFAULT_INSTRUMENT }
const risk: RiskConfig = { ...DEFAULT_RISK, startingEquity: 10000, riskPercent: 1 }

describe('position sizing', () => {
  it('risks exactly the configured percentage', () => {
    const s = sizePosition({
      equity: 10000,
      entryPrice: 100,
      stopLoss: 95,
      side: 'LONG',
      instrument: inst,
      risk,
      atr: 2,
    })
    expect(s.ok).toBe(true)
    expect(s.rDistance).toBeCloseTo(5, 10)
    expect(s.riskAmount).toBeCloseTo(100, 10) // 1% of 10,000
    expect(s.qty).toBeCloseTo(20, 10) // 100 / 5
    expect(s.effectiveRiskPercent).toBeCloseTo(1, 10)
  })

  it('halves the size when the stop is twice as far away', () => {
    const near = sizePosition({ equity: 10000, entryPrice: 100, stopLoss: 95, side: 'LONG', instrument: inst, risk, atr: 2 })
    const far = sizePosition({ equity: 10000, entryPrice: 100, stopLoss: 90, side: 'LONG', instrument: inst, risk, atr: 2 })
    expect(far.qty).toBeCloseTo(near.qty / 2, 10)
    expect(far.riskAmount).toBeCloseTo(near.riskAmount, 10)
  })

  it('refuses a trade with no defined risk instead of guessing one', () => {
    const s = sizePosition({ equity: 10000, entryPrice: 100, stopLoss: 100, side: 'LONG', instrument: inst, risk, atr: 2 })
    expect(s.ok).toBe(false)
    expect(s.qty).toBe(0)
    expect(s.reason).toMatch(/no defined risk/)
  })

  it('refuses to size on zero or negative equity', () => {
    const s = sizePosition({ equity: 0, entryPrice: 100, stopLoss: 95, side: 'LONG', instrument: inst, risk, atr: 2 })
    expect(s.ok).toBe(false)
  })

  it('refuses rather than rounding up past the instrument minimum', () => {
    const chunky: Instrument = { ...inst, qtyStep: 1, minQty: 1 }
    const s = sizePosition({
      equity: 100,
      entryPrice: 2000,
      stopLoss: 1900, // 100-point stop; 1% of 100 = $1 budget → 0.01 units
      side: 'LONG',
      instrument: chunky,
      risk,
      atr: 20,
    })
    expect(s.ok).toBe(false)
    expect(s.reason).toMatch(/below the instrument minimum/)
  })

  it('scales with pointValue', () => {
    const leveraged: Instrument = { ...inst, pointValue: 10 }
    const s = sizePosition({ equity: 10000, entryPrice: 100, stopLoss: 95, side: 'LONG', instrument: leveraged, risk, atr: 2 })
    expect(s.qty).toBeCloseTo(2, 10)
    expect(s.riskAmount).toBeCloseTo(100, 10)
  })

  it('fixed cash risks the same money regardless of equity', () => {
    const cfg: RiskConfig = { ...risk, sizingMethod: 'FIXED_CASH', fixedCash: 50 }
    const a = sizePosition({ equity: 10000, entryPrice: 100, stopLoss: 95, side: 'LONG', instrument: inst, risk: cfg, atr: 2 })
    const b = sizePosition({ equity: 50000, entryPrice: 100, stopLoss: 95, side: 'LONG', instrument: inst, risk: cfg, atr: 2 })
    expect(a.riskAmount).toBeCloseTo(50, 10)
    expect(b.riskAmount).toBeCloseTo(50, 10)
  })

  it('Kelly refuses to bet when the measured edge is not positive', () => {
    const cfg: RiskConfig = { ...risk, sizingMethod: 'FRACTIONAL_KELLY', kellyFraction: 0.25 }
    const s = sizePosition({
      equity: 10000, entryPrice: 100, stopLoss: 95, side: 'LONG',
      instrument: inst, risk: cfg, atr: 2,
      measuredWinRate: 0.3, measuredPayoffRatio: 1,
    })
    expect(s.ok).toBe(false)
    expect(s.reason).toMatch(/Kelly says do not bet/)
  })

  it('Kelly sizes up on a real edge, and says so with a warning', () => {
    const cfg: RiskConfig = { ...risk, sizingMethod: 'FRACTIONAL_KELLY', kellyFraction: 0.25 }
    const s = sizePosition({
      equity: 10000, entryPrice: 100, stopLoss: 95, side: 'LONG',
      instrument: inst, risk: cfg, atr: 2,
      measuredWinRate: 0.6, measuredPayoffRatio: 2,
    })
    expect(s.ok).toBe(true)
    expect(s.riskAmount).toBeGreaterThan(100)
    expect(s.reason).toMatch(/variance is high/)
  })
})

describe('limits', () => {
  it('allows a trade inside every limit', () => {
    const state = initialRiskState(risk, '2025-01-06')
    expect(checkLimits(state, risk).allowed).toBe(true)
  })

  it('blocks a second position when the concurrency limit is one', () => {
    const state = { ...initialRiskState(risk, '2025-01-06'), openPositions: 1 }
    const check = checkLimits(state, risk)
    expect(check.allowed).toBe(false)
    expect(check.code).toBe('MAX_POSITIONS')
  })

  it('trips the kill switch at the equity floor and never re-arms', () => {
    const cfg: RiskConfig = { ...risk, equityFloorPercent: 50 }
    let state = initialRiskState(cfg, '2025-01-06')
    state = applyTradeResult(state, -6000, cfg, '2025-01-06')
    expect(state.killed).toBe(true)
    expect(checkLimits(state, cfg).code).toBe('KILLED')

    // Even a big win afterwards does not resurrect trading.
    state = applyTradeResult(state, 8000, cfg, '2025-01-06')
    expect(state.killed).toBe(true)
    expect(checkLimits(state, cfg).allowed).toBe(false)
  })

  it('stops trading for the day once the daily loss limit is hit', () => {
    const cfg: RiskConfig = { ...risk, maxDailyLossPercent: 3, equityFloorPercent: null }
    // 3% of 10,000 = a 300 daily budget.
    let state = initialRiskState(cfg, '2025-01-06')
    state = applyTradeResult(state, -200, cfg, '2025-01-06')
    expect(checkLimits(state, cfg).allowed).toBe(true)
    state = applyTradeResult(state, -150, cfg, '2025-01-06')
    expect(checkLimits(state, cfg).code).toBe('DAILY_LOSS')

    // A new day resets the budget.
    state = applyTradeResult(state, 0, cfg, '2025-01-07')
    expect(checkLimits(state, cfg).allowed).toBe(true)
  })

  it('counts consecutive losses and resets the streak on a win', () => {
    const cfg: RiskConfig = { ...risk, maxConsecutiveLosses: 3, equityFloorPercent: null }
    let state = initialRiskState(cfg, '2025-01-06')
    state = applyTradeResult(state, -10, cfg, '2025-01-06')
    state = applyTradeResult(state, -10, cfg, '2025-01-06')
    expect(checkLimits(state, cfg).allowed).toBe(true)
    state = applyTradeResult(state, 5, cfg, '2025-01-06')
    expect(state.consecutiveLosses).toBe(0)
    state = applyTradeResult(state, -10, cfg, '2025-01-06')
    state = applyTradeResult(state, -10, cfg, '2025-01-06')
    state = applyTradeResult(state, -10, cfg, '2025-01-06')
    expect(checkLimits(state, cfg).code).toBe('CONSECUTIVE_LOSSES')
  })

  it('tracks the equity peak for drawdown', () => {
    let state = initialRiskState(risk, '2025-01-06')
    state = applyTradeResult(state, 500, risk, '2025-01-06')
    state = applyTradeResult(state, -200, risk, '2025-01-06')
    expect(state.peakEquity).toBeCloseTo(10500, 10)
    expect(state.equity).toBeCloseTo(10300, 10)
  })
})
