import type { CostConfig, Session, Side } from '../types'

/**
 * Cost model.
 *
 * Convention: candle prices are treated as MID. A round trip therefore pays the
 * full spread (half on each side) regardless of direction, which keeps long and
 * short symmetric instead of quietly favouring one.
 *
 * Slippage is applied to orders that cross the book under pressure — stop
 * entries and stop exits. Limit-style exits (take-profit) pay the spread but not
 * adverse slippage, because a resting limit order does not slip; it simply may
 * not fill. Modelling it otherwise would understate the strategy for the wrong
 * reason.
 */

export interface FillContext {
  atr: number | null
  session: Session
}

export function effectiveSpread(costs: CostConfig, ctx: FillContext): number {
  const base =
    costs.spreadMode === 'ATR_SCALED'
      ? (ctx.atr ?? 0) * costs.spreadAtrMultiple
      : costs.spread
  const mult = costs.sessionSpreadMultiplier[ctx.session] ?? 1
  return Math.max(0, base * mult)
}

export function effectiveSlippage(costs: CostConfig, ctx: FillContext): number {
  const base =
    costs.slippageMode === 'ATR_SCALED'
      ? (ctx.atr ?? 0) * costs.slippageAtrMultiple
      : costs.slippage
  return Math.max(0, base)
}

export type FillKind = 'STOP_ENTRY' | 'MARKET' | 'STOP_EXIT' | 'LIMIT_EXIT'

/**
 * Convert a raw trigger/reference price into the price actually paid.
 * `side` is the direction of the POSITION; entering long buys, exiting long sells.
 */
export function fillPrice(
  rawPrice: number,
  side: Side,
  kind: FillKind,
  costs: CostConfig,
  ctx: FillContext,
): number {
  const half = effectiveSpread(costs, ctx) / 2
  const slip = kind === 'LIMIT_EXIT' ? 0 : effectiveSlippage(costs, ctx)
  const isBuy = (side === 'LONG') === (kind === 'STOP_ENTRY' || kind === 'MARKET')
  const adverse = half + slip
  return isBuy ? rawPrice + adverse : rawPrice - adverse
}

/** Commission for one side of a trade. */
export function commission(qty: number, costs: CostConfig): number {
  return Math.abs(qty) * costs.commissionPerUnit
}

/** Financing accrued for holding `qty` for `bars` bars. */
export function financing(qty: number, bars: number, costs: CostConfig): number {
  return Math.abs(qty) * bars * costs.financingPerBarPerUnit
}

/** Gross P&L in account currency, before any costs. */
export function grossPnl(
  side: Side,
  entryPrice: number,
  exitPrice: number,
  qty: number,
  pointValue: number,
): number {
  const move = side === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice
  return move * qty * pointValue
}

/**
 * Total round-trip cost in price units, for the cost-sensitivity panel.
 * This is the number that decides whether a small edge survives contact with a
 * broker, so it is surfaced directly rather than buried inside net P&L.
 */
export function roundTripCostInPrice(costs: CostConfig, ctx: FillContext): number {
  return effectiveSpread(costs, ctx) + effectiveSlippage(costs, ctx) * 2
}

export const ZERO_COSTS: CostConfig = {
  spread: 0,
  spreadMode: 'FIXED',
  spreadAtrMultiple: 0,
  sessionSpreadMultiplier: { ASIA: 1, LONDON: 1, NY: 1, OFF: 1 },
  commissionPerUnit: 0,
  slippage: 0,
  slippageMode: 'FIXED',
  slippageAtrMultiple: 0,
  financingPerBarPerUnit: 0,
}
