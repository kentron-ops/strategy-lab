import type { Instrument, RiskConfig, SizingResult, Side } from '../types'
import { kellyFraction } from '../util/stats'

/**
 * Risk engine — independent of any strategy (§7).
 *
 * The one principle: you decide the loss, the market decides the reward.
 * Certainty is only available on the downside, so the downside is what gets
 * computed exactly here. Liquidation is never a stop.
 */

export interface SizingInput {
  equity: number
  entryPrice: number
  stopLoss: number
  side: Side
  instrument: Instrument
  risk: RiskConfig
  /** For VOLATILITY_NORMALIZED. */
  atr: number | null
  /** For FRACTIONAL_KELLY — measured, never assumed. */
  measuredWinRate?: number
  measuredPayoffRatio?: number
}

export function roundQty(qty: number, instrument: Instrument): number {
  if (instrument.qtyStep > 0) {
    qty = Math.floor(qty / instrument.qtyStep) * instrument.qtyStep
    // Kill floating-point dust introduced by the division.
    const decimals = Math.max(0, Math.ceil(-Math.log10(instrument.qtyStep)))
    qty = Number(qty.toFixed(decimals + 2))
  }
  return qty
}

export function sizePosition(input: SizingInput): SizingResult {
  const { equity, entryPrice, stopLoss, instrument, risk, atr } = input

  const rDistance = Math.abs(entryPrice - stopLoss)

  if (!Number.isFinite(rDistance) || rDistance <= 0) {
    return {
      qty: 0,
      riskAmount: 0,
      effectiveRiskPercent: 0,
      rDistance: 0,
      ok: false,
      reason: 'Stop distance is zero — the trade has no defined risk, so it cannot be sized.',
    }
  }
  if (equity <= 0) {
    return {
      qty: 0,
      riskAmount: 0,
      effectiveRiskPercent: 0,
      rDistance,
      ok: false,
      reason: 'Equity is zero or negative. No further risk may be taken.',
    }
  }

  let riskBudget: number
  let note = ''

  switch (risk.sizingMethod) {
    case 'FIXED_CASH':
      riskBudget = risk.fixedCash
      break

    case 'VOLATILITY_NORMALIZED': {
      // Risk the same % of equity, but size from a volatility-defined stop so
      // position size shrinks automatically when the market gets wilder.
      const volStop = (atr ?? 0) * risk.volTargetAtrMultiple
      riskBudget = (equity * risk.riskPercent) / 100
      if (volStop > 0) {
        const scale = Math.min(2, Math.max(0.25, volStop / rDistance))
        riskBudget = riskBudget / scale
        note = `volatility-normalized (ATR stop ${volStop.toFixed(4)} vs actual ${rDistance.toFixed(4)})`
      }
      break
    }

    case 'FRACTIONAL_KELLY': {
      const wr = input.measuredWinRate ?? 0
      const payoff = input.measuredPayoffRatio ?? 0
      const full = kellyFraction(wr, payoff)
      const f = full * risk.kellyFraction
      riskBudget = equity * f
      note = `fractional Kelly: full ${(full * 100).toFixed(1)}% × ${risk.kellyFraction} — variance is high and the edge estimate is itself uncertain`
      if (f <= 0) {
        return {
          qty: 0,
          riskAmount: 0,
          effectiveRiskPercent: 0,
          rDistance,
          ok: false,
          reason:
            'Kelly says do not bet: the measured edge is not positive. Sizing refused.',
        }
      }
      break
    }

    case 'FIXED_FRACTIONAL':
    default:
      riskBudget = (equity * risk.riskPercent) / 100
      break
  }

  if (!Number.isFinite(riskBudget) || riskBudget <= 0) {
    return {
      qty: 0,
      riskAmount: 0,
      effectiveRiskPercent: 0,
      rDistance,
      ok: false,
      reason: 'Computed risk budget is not positive.',
    }
  }

  const perUnitRisk = rDistance * instrument.pointValue
  let qty = riskBudget / perUnitRisk
  qty = roundQty(qty, instrument)

  if (qty > instrument.maxQty) qty = roundQty(instrument.maxQty, instrument)

  if (qty <= 0 || qty < instrument.minQty) {
    return {
      qty: 0,
      riskAmount: 0,
      effectiveRiskPercent: 0,
      rDistance,
      ok: false,
      reason:
        instrument.minQty > 0
          ? `Required size ${qty} is below the instrument minimum ${instrument.minQty}. Taking it would risk more than the rule allows, so the trade is refused.`
          : 'Required size rounds to zero at this risk budget and stop distance.',
    }
  }

  const riskAmount = qty * perUnitRisk
  return {
    qty,
    riskAmount,
    effectiveRiskPercent: (riskAmount / equity) * 100,
    rDistance,
    ok: true,
    reason: note || `${risk.riskPercent}% of ${equity.toFixed(2)} over a ${rDistance.toFixed(4)} stop`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Limits — always on, never a strategy's decision
// ─────────────────────────────────────────────────────────────────────────────

export interface RiskState {
  equity: number
  peakEquity: number
  openPositions: number
  consecutiveLosses: number
  dayKey: string
  dayStartEquity: number
  /** Once tripped, no new positions for the rest of the run. */
  killed: boolean
  killReason: string | null
}

export function initialRiskState(risk: RiskConfig, dayKey: string): RiskState {
  return {
    equity: risk.startingEquity,
    peakEquity: risk.startingEquity,
    openPositions: 0,
    consecutiveLosses: 0,
    dayKey,
    dayStartEquity: risk.startingEquity,
    killed: false,
    killReason: null,
  }
}

export interface LimitCheck {
  allowed: boolean
  reason: string
  code:
    | 'OK'
    | 'KILLED'
    | 'EQUITY_FLOOR'
    | 'MAX_POSITIONS'
    | 'DAILY_LOSS'
    | 'CONSECUTIVE_LOSSES'
}

/** May a NEW position be opened right now? */
export function checkLimits(state: RiskState, risk: RiskConfig): LimitCheck {
  if (state.killed) {
    return {
      allowed: false,
      reason: state.killReason ?? 'Trading halted by a risk limit.',
      code: 'KILLED',
    }
  }

  if (risk.equityFloorPercent !== null) {
    const floor = (risk.startingEquity * risk.equityFloorPercent) / 100
    if (state.equity <= floor) {
      return {
        allowed: false,
        reason: `Kill switch: equity ${state.equity.toFixed(2)} is at or below the floor of ${floor.toFixed(2)} (${risk.equityFloorPercent}% of starting equity).`,
        code: 'EQUITY_FLOOR',
      }
    }
  }

  if (state.openPositions >= risk.maxConcurrentPositions) {
    return {
      allowed: false,
      reason: `Already holding ${state.openPositions} position(s); the limit is ${risk.maxConcurrentPositions}.`,
      code: 'MAX_POSITIONS',
    }
  }

  if (risk.maxDailyLossPercent !== null) {
    const lost = state.dayStartEquity - state.equity
    const limit = (state.dayStartEquity * risk.maxDailyLossPercent) / 100
    if (lost >= limit && limit > 0) {
      return {
        allowed: false,
        reason: `Daily loss limit hit: down ${lost.toFixed(2)} against a limit of ${limit.toFixed(2)}. No new trades today.`,
        code: 'DAILY_LOSS',
      }
    }
  }

  if (
    risk.maxConsecutiveLosses !== null &&
    state.consecutiveLosses >= risk.maxConsecutiveLosses
  ) {
    return {
      allowed: false,
      reason: `${state.consecutiveLosses} consecutive losses reached the limit of ${risk.maxConsecutiveLosses}.`,
      code: 'CONSECUTIVE_LOSSES',
    }
  }

  return { allowed: true, reason: 'Within all risk limits.', code: 'OK' }
}

/** Apply a closed trade's result to the risk state. */
export function applyTradeResult(
  state: RiskState,
  netPnl: number,
  risk: RiskConfig,
  dayKey: string,
): RiskState {
  const next: RiskState = { ...state }

  if (dayKey !== next.dayKey) {
    next.dayKey = dayKey
    next.dayStartEquity = next.equity
  }

  next.equity += netPnl
  next.peakEquity = Math.max(next.peakEquity, next.equity)
  next.consecutiveLosses = netPnl < 0 ? next.consecutiveLosses + 1 : 0

  if (risk.equityFloorPercent !== null) {
    const floor = (risk.startingEquity * risk.equityFloorPercent) / 100
    if (next.equity <= floor && !next.killed) {
      next.killed = true
      next.killReason = `Kill switch tripped: equity fell to ${next.equity.toFixed(2)}, at or below the ${risk.equityFloorPercent}% floor.`
    }
  }

  return next
}

/** Roll the day boundary without a trade (called as bars advance). */
export function rollDay(state: RiskState, dayKey: string): RiskState {
  if (dayKey === state.dayKey) return state
  return { ...state, dayKey, dayStartEquity: state.equity }
}
