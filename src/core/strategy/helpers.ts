import type { Candle, Reason, StrategyContext } from '../types'

/** Shared helpers for strategy authors. Pure and cheap. */

export const num = (ctx: StrategyContext, key: string, fallback: number): number => {
  const v = ctx.params[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export const bool = (ctx: StrategyContext, key: string, fallback: boolean): boolean => {
  const v = ctx.params[key]
  return typeof v === 'boolean' ? v : fallback
}

export const str = (ctx: StrategyContext, key: string, fallback: string): string => {
  const v = ctx.params[key]
  return typeof v === 'string' ? v : fallback
}

export function reason(
  code: string,
  message: string,
  passed: boolean,
  data?: Record<string, number | string | boolean>,
): Reason {
  return { code, message, passed, ...(data ? { data } : {}) }
}

/**
 * Highest high over the `period` bars ending at i-1.
 * Excludes the current bar, because including it is a look-ahead bug: you cannot
 * place an order at a level derived from a bar that has not finished forming.
 */
export function highestHigh(candles: Candle[], i: number, period: number): number | null {
  const end = i - 1
  const start = end - period + 1
  if (start < 0) return null
  let m = -Infinity
  for (let j = start; j <= end; j++) if (candles[j].h > m) m = candles[j].h
  return m
}

export function lowestLow(candles: Candle[], i: number, period: number): number | null {
  const end = i - 1
  const start = end - period + 1
  if (start < 0) return null
  let m = Infinity
  for (let j = start; j <= end; j++) if (candles[j].l < m) m = candles[j].l
  return m
}

/** Parse a comma-separated session filter such as "LONDON,NY". Empty = all. */
export function sessionAllowed(filter: string, session: string): boolean {
  const trimmed = filter.trim()
  if (!trimmed || trimmed.toUpperCase() === 'ALL') return true
  return trimmed
    .toUpperCase()
    .split(',')
    .map((s) => s.trim())
    .includes(session)
}

/** True when the strategy already has an order working in this OCO group. */
export function hasWorkingGroup(ctx: StrategyContext, group: string): boolean {
  return ctx.pendingOrders.some((o) => o.status === 'PENDING' && o.ocoGroup === group)
}
