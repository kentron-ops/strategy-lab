import type { BacktestConfig, Candle, Dataset, Timeframe } from '../types'
import {
  DEFAULT_COSTS,
  DEFAULT_INDICATORS,
  DEFAULT_INSTRUMENT,
  DEFAULT_RISK,
  TF_MS,
} from '../types'
import { makeConfig } from '../strategy/registry'
import { hashCandles } from '../util/hash'
import { validateCandles } from '../data/validators'
import { ZERO_COSTS } from '../execution/costModel'

/**
 * Deterministic fixtures for the test suite.
 * Kept in src (not a test folder) so tests and the app share one definition of
 * "a dataset", and so the shapes stay type-checked by the normal build.
 */

/** Build a dataset from explicit bars. */
export function makeDataset(
  candles: Candle[],
  timeframe: Timeframe = '5m',
  symbol = 'TEST',
): Dataset {
  return {
    id: `ds_test_${hashCandles(candles)}`,
    symbol,
    timeframe,
    candles,
    timezone: 'UTC',
    source: 'test fixture',
    hash: hashCandles(candles),
    createdAt: 0,
    quality: validateCandles(candles, timeframe),
  }
}

/**
 * A simple deterministic zig-zag walk. No RNG, so a failing test always fails
 * the same way.
 */
export function zigzag(
  bars: number,
  opts: {
    start?: number
    amplitude?: number
    period?: number
    drift?: number
    timeframe?: Timeframe
    startTime?: number
    wick?: number
  } = {},
): Candle[] {
  const {
    start = 100,
    amplitude = 2,
    period = 20,
    drift = 0,
    timeframe = '5m',
    startTime = Date.UTC(2025, 0, 6, 0, 0, 0),
    wick = 0.3,
  } = opts

  const step = TF_MS[timeframe]
  const out: Candle[] = []
  for (let i = 0; i < bars; i++) {
    const phase = (i % period) / period
    const wave = Math.sin(phase * Math.PI * 2) * amplitude
    const nextWave = Math.sin((((i + 1) % period) / period) * Math.PI * 2) * amplitude
    const o = start + drift * i + wave
    const c = start + drift * (i + 1) + nextWave
    const h = Math.max(o, c) + wick
    const l = Math.min(o, c) - wick
    out.push({
      t: startTime + i * step,
      o: r4(o),
      h: r4(h),
      l: r4(l),
      c: r4(c),
      v: 100 + (i % 7),
    })
  }
  return out
}

/** A flat series with one clean breakout at `breakAt`, for exact-arithmetic tests. */
export function flatThenBreakout(
  bars: number,
  breakAt: number,
  opts: { start?: number; jump?: number; timeframe?: Timeframe } = {},
): Candle[] {
  const { start = 100, jump = 5, timeframe = '5m' } = opts
  const step = TF_MS[timeframe]
  const startTime = Date.UTC(2025, 0, 6, 8, 0, 0)
  const out: Candle[] = []
  let price = start
  for (let i = 0; i < bars; i++) {
    const wiggle = ((i % 5) - 2) * 0.1
    const o = price + wiggle
    let c = price + wiggle * 0.5
    if (i === breakAt) c = o + jump
    if (i > breakAt) c = o + 0.05
    const h = Math.max(o, c) + 0.2
    const l = Math.min(o, c) - 0.2
    out.push({ t: startTime + i * step, o: r4(o), h: r4(h), l: r4(l), c: r4(c), v: 100 })
    price = c
  }
  return out
}

const r4 = (x: number): number => Math.round(x * 10000) / 10000

export function makeBacktestConfig(
  strategyId = 'oco_breakout',
  overrides: Partial<BacktestConfig> = {},
  params: Record<string, number | string | boolean> = {},
): BacktestConfig {
  return {
    strategy: makeConfig(strategyId, params),
    risk: { ...DEFAULT_RISK, startingEquity: 10000, equityFloorPercent: null },
    costs: { ...DEFAULT_COSTS },
    instrument: { ...DEFAULT_INSTRUMENT, symbol: 'TEST' },
    indicators: { ...DEFAULT_INDICATORS },
    intrabar: 'CONSERVATIVE',
    seed: 1,
    fromIndex: null,
    toIndex: null,
    ...overrides,
  }
}

/** Config with every cost zeroed, so arithmetic assertions are exact. */
export function makeFrictionlessConfig(
  strategyId = 'oco_breakout',
  overrides: Partial<BacktestConfig> = {},
  params: Record<string, number | string | boolean> = {},
): BacktestConfig {
  return makeBacktestConfig(strategyId, { costs: { ...ZERO_COSTS }, ...overrides }, params)
}
