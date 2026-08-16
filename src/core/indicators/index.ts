import type {
  Candle,
  IndicatorConfig,
  Indicators,
  Regime,
  Session,
  Timeframe,
  TrendRegime,
  VolRegime,
} from '../types'
import { TF_MS } from '../types'
import { sessionOf } from '../util/time'
import { percentileRank } from '../util/stats'

/**
 * Indicators are computed once over the whole series and read by index.
 *
 * Every series is causal: value at index i uses only bars 0..i. Warm-up periods
 * are `null`, never back-filled — a null is the honest answer for "not enough
 * history yet", and the strategies treat null as "do not trade".
 */

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (period <= 0 || values.length < period) return out
  const k = 2 / (period + 1)
  let acc = 0
  for (let i = 0; i < period; i++) acc += values[i]
  let prev = acc / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (period <= 0) return out
  let acc = 0
  for (let i = 0; i < values.length; i++) {
    acc += values[i]
    if (i >= period) acc -= values[i - period]
    if (i >= period - 1) out[i] = acc / period
  }
  return out
}

export function trueRange(candles: Candle[]): number[] {
  const out: number[] = new Array(candles.length).fill(0)
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    if (i === 0) {
      out[i] = c.h - c.l
      continue
    }
    const prevClose = candles[i - 1].c
    out[i] = Math.max(
      c.h - c.l,
      Math.abs(c.h - prevClose),
      Math.abs(c.l - prevClose),
    )
  }
  return out
}

/** Wilder-smoothed ATR. */
export function atr(candles: Candle[], period: number): (number | null)[] {
  const n = candles.length
  const out: (number | null)[] = new Array(n).fill(null)
  if (period <= 0 || n < period + 1) return out
  const tr = trueRange(candles)
  let acc = 0
  for (let i = 1; i <= period; i++) acc += tr[i]
  let prev = acc / period
  out[period] = prev
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period
    out[i] = prev
  }
  return out
}

export function rsi(candles: Candle[], period: number): (number | null)[] {
  const n = candles.length
  const out: (number | null)[] = new Array(n).fill(null)
  if (period <= 0 || n < period + 1) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = candles[i].c - candles[i - 1].c
    if (d >= 0) gain += d
    else loss -= d
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < n; i++) {
    const d = candles[i].c - candles[i - 1].c
    const g = d > 0 ? d : 0
    const l = d < 0 ? -d : 0
    avgGain = (avgGain * (period - 1) + g) / period
    avgLoss = (avgLoss * (period - 1) + l) / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

/** Wilder ADX. Used only as a ranging/trending classifier, never as a signal. */
export function adx(candles: Candle[], period: number): (number | null)[] {
  const n = candles.length
  const out: (number | null)[] = new Array(n).fill(null)
  if (period <= 0 || n < period * 2 + 1) return out

  const tr = trueRange(candles)
  const plusDM: number[] = new Array(n).fill(0)
  const minusDM: number[] = new Array(n).fill(0)
  for (let i = 1; i < n; i++) {
    const up = candles[i].h - candles[i - 1].h
    const down = candles[i - 1].l - candles[i].l
    plusDM[i] = up > down && up > 0 ? up : 0
    minusDM[i] = down > up && down > 0 ? down : 0
  }

  let trSum = 0
  let pSum = 0
  let mSum = 0
  for (let i = 1; i <= period; i++) {
    trSum += tr[i]
    pSum += plusDM[i]
    mSum += minusDM[i]
  }

  const dxs: number[] = []
  let firstAdxIndex = -1
  for (let i = period + 1; i < n; i++) {
    trSum = trSum - trSum / period + tr[i]
    pSum = pSum - pSum / period + plusDM[i]
    mSum = mSum - mSum / period + minusDM[i]
    const pDI = trSum === 0 ? 0 : (100 * pSum) / trSum
    const mDI = trSum === 0 ? 0 : (100 * mSum) / trSum
    const denom = pDI + mDI
    const dx = denom === 0 ? 0 : (100 * Math.abs(pDI - mDI)) / denom
    dxs.push(dx)
    if (dxs.length === period) {
      let s = 0
      for (const d of dxs) s += d
      out[i] = s / period
      firstAdxIndex = i
    } else if (dxs.length > period && firstAdxIndex >= 0) {
      const prev = out[i - 1] as number
      out[i] = (prev * (period - 1) + dx) / period
    }
  }
  return out
}

/** Highest high over the `period` bars ENDING at i-1 (excludes the current bar). */
export function rollingHigh(
  candles: Candle[],
  period: number,
  excludeCurrent = true,
): (number | null)[] {
  const n = candles.length
  const out: (number | null)[] = new Array(n).fill(null)
  const off = excludeCurrent ? 1 : 0
  for (let i = 0; i < n; i++) {
    const end = i - off
    const start = end - period + 1
    if (start < 0) continue
    let m = -Infinity
    for (let j = start; j <= end; j++) if (candles[j].h > m) m = candles[j].h
    out[i] = m
  }
  return out
}

/** Lowest low over the `period` bars ENDING at i-1 (excludes the current bar). */
export function rollingLow(
  candles: Candle[],
  period: number,
  excludeCurrent = true,
): (number | null)[] {
  const n = candles.length
  const out: (number | null)[] = new Array(n).fill(null)
  const off = excludeCurrent ? 1 : 0
  for (let i = 0; i < n; i++) {
    const end = i - off
    const start = end - period + 1
    if (start < 0) continue
    let m = Infinity
    for (let j = start; j <= end; j++) if (candles[j].l < m) m = candles[j].l
    out[i] = m
  }
  return out
}

/**
 * Where the current ATR sits within its own recent history, in [0,1].
 * This is what makes "high volatility" mean something relative rather than a
 * hardcoded number that only fits one instrument.
 */
export function rollingPercentile(
  series: (number | null)[],
  window: number,
): (number | null)[] {
  const n = series.length
  const out: (number | null)[] = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    const v = series[i]
    if (v === null) continue
    const start = Math.max(0, i - window + 1)
    const hist: number[] = []
    for (let j = start; j <= i; j++) {
      const x = series[j]
      if (x !== null) hist.push(x)
    }
    if (hist.length < Math.min(20, window)) continue
    out[i] = percentileRank(hist, v)
  }
  return out
}

export function sessionSeries(
  candles: Candle[],
  bounds: Record<Session, [number, number]>,
): Session[] {
  return candles.map((c) => sessionOf(c.t, bounds))
}

/**
 * Regime = volatility bucket × trend/range classification.
 * Both are relative and causal. An unconditional edge often only exists inside
 * one of these buckets, which is why every metric can be sliced by regime.
 */
export function regimeSeries(
  atrPct: (number | null)[],
  adxSeries: (number | null)[],
  adxTrendThreshold = 22,
): (Regime | null)[] {
  const n = atrPct.length
  const out: (Regime | null)[] = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    const p = atrPct[i]
    const a = adxSeries[i]
    if (p === null || a === null) continue
    const vol: VolRegime = p < 0.33 ? 'LOW_VOL' : p < 0.67 ? 'MID_VOL' : 'HIGH_VOL'
    const trend: TrendRegime = a >= adxTrendThreshold ? 'TRENDING' : 'RANGING'
    out[i] = { vol, trend }
  }
  return out
}

/**
 * Higher-timeframe trend aligned onto base bars.
 *
 * Causality note: bar i is assigned the HTF trend computed from HTF bars that
 * CLOSED at or before bar i's open time. An HTF bar still forming is never used,
 * which is the classic multi-timeframe look-ahead bug.
 */
export function htfTrendSeries(
  candles: Candle[],
  baseTf: Timeframe,
  htfTf: Timeframe,
  fastPeriod: number,
  slowPeriod: number,
): (('UP' | 'DOWN' | 'FLAT') | null)[] {
  const n = candles.length
  const out: (('UP' | 'DOWN' | 'FLAT') | null)[] = new Array(n).fill(null)
  const htfMs = TF_MS[htfTf]
  const baseMs = TF_MS[baseTf]
  if (htfMs <= baseMs) return out

  const htf = resampleForTrend(candles, htfMs)
  if (htf.bars.length < slowPeriod + 1) return out

  const closes = htf.bars.map((b) => b.c)
  const f = ema(closes, fastPeriod)
  const s = ema(closes, slowPeriod)

  // For each base bar, find the last HTF bar that had fully closed by then.
  let k = -1
  for (let i = 0; i < n; i++) {
    const t = candles[i].t
    while (k + 1 < htf.bars.length && htf.closeTimes[k + 1] <= t) k++
    if (k < 0) continue
    const fv = f[k]
    const sv = s[k]
    if (fv === null || sv === null) continue
    out[i] = fv > sv ? 'UP' : fv < sv ? 'DOWN' : 'FLAT'
  }
  return out
}

function resampleForTrend(
  candles: Candle[],
  bucketMs: number,
): { bars: Candle[]; closeTimes: number[] } {
  const bars: Candle[] = []
  const closeTimes: number[] = []
  let cur: Candle | null = null
  let curBucket = -1
  for (const c of candles) {
    const bucket = Math.floor(c.t / bucketMs) * bucketMs
    if (bucket !== curBucket) {
      if (cur) {
        bars.push(cur)
        closeTimes.push(curBucket + bucketMs)
      }
      curBucket = bucket
      cur = { t: bucket, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v ?? 0 }
    } else if (cur) {
      cur.h = Math.max(cur.h, c.h)
      cur.l = Math.min(cur.l, c.l)
      cur.c = c.c
      cur.v = (cur.v ?? 0) + (c.v ?? 0)
    }
  }
  if (cur) {
    bars.push(cur)
    closeTimes.push(curBucket + bucketMs)
  }
  return { bars, closeTimes }
}

/** |close - open| / (high - low). Small values = indecision. */
export function bodyRatioSeries(candles: Candle[]): (number | null)[] {
  return candles.map((c) => {
    const range = c.h - c.l
    if (range <= 0) return null
    return Math.abs(c.c - c.o) / range
  })
}

/** Current bar range divided by average range — detects range expansion. */
export function rangeExpansionSeries(
  candles: Candle[],
  period: number,
): (number | null)[] {
  const ranges = candles.map((c) => c.h - c.l)
  const avg = sma(ranges, period)
  return candles.map((_, i) => {
    const a = avg[i]
    if (a === null || a <= 0) return null
    return ranges[i] / a
  })
}

/** Compute every indicator series a strategy or slice may need, once. */
export function computeIndicators(
  candles: Candle[],
  cfg: IndicatorConfig,
  baseTf: Timeframe,
): Indicators {
  const closes = candles.map((c) => c.c)
  const atrSeries = atr(candles, cfg.atrPeriod)
  const adxSeries = adx(candles, cfg.adxPeriod)
  const atrPct = rollingPercentile(atrSeries, cfg.atrPercentileWindow)
  return {
    atr: atrSeries,
    emaFast: ema(closes, cfg.emaFastPeriod),
    emaSlow: ema(closes, cfg.emaSlowPeriod),
    rsi: rsi(candles, cfg.rsiPeriod),
    adx: adxSeries,
    highestHigh: rollingHigh(candles, cfg.lookback, true),
    lowestLow: rollingLow(candles, cfg.lookback, true),
    atrPercentile: atrPct,
    session: sessionSeries(candles, cfg.sessionBoundsUtc),
    regime: regimeSeries(atrPct, adxSeries),
    htfTrend: htfTrendSeries(
      candles,
      baseTf,
      cfg.htfTimeframe,
      cfg.emaFastPeriod,
      cfg.emaSlowPeriod,
    ),
    bodyRatio: bodyRatioSeries(candles),
    rangeExpansion: rangeExpansionSeries(candles, cfg.lookback),
  }
}
