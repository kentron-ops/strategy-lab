import type { Candle, Dataset, Timeframe } from '../types'
import { TF_MS } from '../types'
import { makeNormal, makeRng } from '../util/rng'
import { hashCandles } from '../util/hash'
import { validateCandles } from './validators'

/**
 * SYNTHETIC sample data, so the app is usable on first open with zero downloads.
 *
 * This is clearly labelled everywhere it is used. It is generated from a random
 * walk with session-dependent volatility and weekend gaps — realistic enough to
 * exercise every code path, and NOT real gold. Any edge found on it is an
 * artefact of the generator, and the UI says so.
 */

export const SAMPLE_DATASET_ID = 'ds_sample_synthetic'

export interface SampleOptions {
  symbol: string
  timeframe: Timeframe
  bars: number
  startPrice: number
  seed: number
  /** Annualised-ish drift, applied per bar. Small on purpose. */
  driftPerBar: number
  baseVolatility: number
  startTime: number
}

export const DEFAULT_SAMPLE: SampleOptions = {
  symbol: 'XAUUSD-SYNTHETIC',
  timeframe: '5m',
  bars: 12000,
  startPrice: 2350,
  seed: 20260816,
  driftPerBar: 0.000002,
  baseVolatility: 0.00035,
  startTime: Date.UTC(2025, 0, 6, 0, 0, 0), // a Monday
}

/** Volatility multiplier by UTC hour — quiet Asia, busy London/NY overlap. */
function volByHour(h: number): number {
  if (h >= 0 && h < 7) return 0.6
  if (h >= 7 && h < 12) return 1.25
  if (h >= 12 && h < 16) return 1.6
  if (h >= 16 && h < 21) return 1.0
  return 0.45
}

export function generateSampleCandles(opts: SampleOptions = DEFAULT_SAMPLE): Candle[] {
  const rng = makeRng(opts.seed)
  const normal = makeNormal(rng)
  const step = TF_MS[opts.timeframe]
  const out: Candle[] = []

  let price = opts.startPrice
  let t = opts.startTime
  // A slow-moving regime factor so volatility clusters instead of being uniform.
  let regime = 1

  while (out.length < opts.bars) {
    const d = new Date(t)
    const dow = d.getUTCDay()
    const hour = d.getUTCHours()

    // Skip the weekend: Friday 21:00 UTC → Sunday 22:00 UTC.
    const isClosed =
      dow === 6 || (dow === 5 && hour >= 21) || (dow === 0 && hour < 22)
    if (isClosed) {
      t += step
      continue
    }

    regime = Math.max(0.4, Math.min(2.6, regime + normal() * 0.02))
    const vol = opts.baseVolatility * volByHour(hour) * regime

    const open = price
    const ret = opts.driftPerBar + normal() * vol
    const close = open * (1 + ret)

    // Wicks: a fraction of the bar's own move plus independent noise.
    const span = Math.abs(close - open)
    const wickUp = Math.abs(normal()) * vol * open * 0.7 + span * 0.15
    const wickDn = Math.abs(normal()) * vol * open * 0.7 + span * 0.15
    const high = Math.max(open, close) + wickUp
    const low = Math.min(open, close) - wickDn

    out.push({
      t,
      o: round2(open),
      h: round2(high),
      l: round2(low),
      c: round2(close),
      v: Math.round(500 + Math.abs(normal()) * 800 * volByHour(hour)),
    })

    price = close
    t += step
  }

  return out
}

const round2 = (x: number): number => Math.round(x * 100) / 100

export function buildSampleDataset(opts: SampleOptions = DEFAULT_SAMPLE): Dataset {
  const candles = generateSampleCandles(opts)
  return {
    id: SAMPLE_DATASET_ID,
    symbol: opts.symbol,
    timeframe: opts.timeframe,
    candles,
    timezone: 'UTC',
    source: `synthetic (seed ${opts.seed}) — NOT REAL MARKET DATA`,
    hash: hashCandles(candles),
    createdAt: Date.now(),
    quality: validateCandles(candles, opts.timeframe),
  }
}
