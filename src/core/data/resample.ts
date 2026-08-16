import type { Candle, Dataset, Timeframe } from '../types'
import { TF_MS } from '../types'
import { hashCandles } from '../util/hash'
import { validateCandles } from './validators'

/**
 * Build a higher timeframe from a base timeframe.
 *
 * Only upward resampling is possible — you cannot invent detail you do not have.
 * Attempting to downsample returns an error rather than a plausible-looking lie.
 */

export function resampleCandles(candles: Candle[], target: Timeframe): Candle[] {
  const ms = TF_MS[target]
  const out: Candle[] = []
  let cur: Candle | null = null
  let bucket = -1

  for (const c of candles) {
    const b = Math.floor(c.t / ms) * ms
    if (b !== bucket) {
      if (cur) out.push(cur)
      bucket = b
      cur = { t: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v ?? 0 }
    } else if (cur) {
      cur.h = Math.max(cur.h, c.h)
      cur.l = Math.min(cur.l, c.l)
      cur.c = c.c
      cur.v = (cur.v ?? 0) + (c.v ?? 0)
    }
  }
  if (cur) out.push(cur)
  return out
}

export function resampleDataset(
  ds: Dataset,
  target: Timeframe,
): { dataset: Dataset | null; error: string | null } {
  if (TF_MS[target] < TF_MS[ds.timeframe]) {
    return {
      dataset: null,
      error: `Cannot resample ${ds.timeframe} down to ${target}. Load finer data instead — detail cannot be invented.`,
    }
  }
  if (TF_MS[target] === TF_MS[ds.timeframe]) {
    return { dataset: ds, error: null }
  }
  const candles = resampleCandles(ds.candles, target)
  const hash = hashCandles(candles)
  return {
    dataset: {
      ...ds,
      id: `${ds.id}_${target}`,
      timeframe: target,
      candles,
      hash,
      source: `${ds.source} (resampled from ${ds.timeframe})`,
      quality: validateCandles(candles, target),
      createdAt: Date.now(),
    },
    error: null,
  }
}

/**
 * Map each bar of a coarse series to the finer bars inside it.
 * Used to resolve intrabar ambiguity precisely when finer data is available (§6).
 */
export function buildFineIndex(
  coarse: Candle[],
  fine: Candle[],
  coarseTf: Timeframe,
): Map<number, Candle[]> {
  const ms = TF_MS[coarseTf]
  const byBucket = new Map<number, Candle[]>()
  for (const f of fine) {
    const b = Math.floor(f.t / ms) * ms
    const arr = byBucket.get(b)
    if (arr) arr.push(f)
    else byBucket.set(b, [f])
  }
  const out = new Map<number, Candle[]>()
  for (let i = 0; i < coarse.length; i++) {
    const arr = byBucket.get(Math.floor(coarse[i].t / ms) * ms)
    if (arr) out.set(i, arr)
  }
  return out
}
