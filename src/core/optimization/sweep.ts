import type { BacktestConfig, Dataset, Indicators } from '../types'
import { runBacktest } from '../backtest/engine'
import { computeIndicators } from '../indicators'
import { getStrategy } from '../strategy/registry'
import { flagResult, type SweepRow } from './scoring'
import { hashObject } from '../util/hash'

/**
 * Parameter sweep.
 *
 * Indicators are computed ONCE and shared across every combination, because they
 * depend on the dataset rather than on strategy parameters. That is what makes a
 * few thousand backtests feasible in a browser worker.
 */

export interface SweepDimension {
  key: string
  values: (number | string | boolean)[]
}

export interface SweepSpec {
  dimensions: SweepDimension[]
  /** Hard cap on combinations. Exceeding it is reported, never silently trimmed. */
  maxCombinations: number
}

export const DEFAULT_MAX_COMBINATIONS = 4000

export function rangeValues(from: number, to: number, step: number): number[] {
  const out: number[] = []
  if (step <= 0) return [from]
  const decimals = decimalsOf(step)
  for (let v = from; v <= to + step / 1e6; v += step) {
    out.push(Number(v.toFixed(decimals)))
  }
  return out
}

function decimalsOf(step: number): number {
  const s = String(step)
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : Math.min(8, s.length - dot - 1)
}

/** Default sweep dimensions declared by the strategy itself. */
export function defaultSweepFor(strategyId: string, keys?: string[]): SweepDimension[] {
  const s = getStrategy(strategyId)
  return s.paramSpec
    .filter((p) => p.sweep && (!keys || keys.includes(p.key)))
    .map((p) => ({
      key: p.key,
      values: rangeValues(p.sweep!.from, p.sweep!.to, p.sweep!.step),
    }))
}

export function countCombinations(dims: SweepDimension[]): number {
  return dims.reduce((acc, d) => acc * Math.max(1, d.values.length), 1)
}

/** Cartesian product of the dimensions, in a stable order. */
export function expandGrid(
  dims: SweepDimension[],
): Record<string, number | string | boolean>[] {
  let out: Record<string, number | string | boolean>[] = [{}]
  for (const d of dims) {
    const next: Record<string, number | string | boolean>[] = []
    for (const base of out) {
      for (const v of d.values) next.push({ ...base, [d.key]: v })
    }
    out = next
  }
  return out
}

export interface SweepProgress {
  done: number
  total: number
  /** Best row found so far, so the UI can show something immediately. */
  best: SweepRow | null
}

export interface SweepOptions {
  onProgress?: (p: SweepProgress) => void
  progressEvery?: number
  shouldAbort?: () => boolean
  indicators?: Indicators
}

export interface SweepResult {
  rows: SweepRow[]
  total: number
  truncated: boolean
  aborted: boolean
  durationMs: number
  warnings: string[]
}

export function runSweep(
  dataset: Dataset,
  baseConfig: BacktestConfig,
  spec: SweepSpec,
  opts: SweepOptions = {},
): SweepResult {
  const started = Date.now()
  const warnings: string[] = []

  const total = countCombinations(spec.dimensions)
  let combos = expandGrid(spec.dimensions)
  let truncated = false

  if (combos.length > spec.maxCombinations) {
    truncated = true
    warnings.push(
      `${combos.length.toLocaleString()} combinations requested; only the first ${spec.maxCombinations.toLocaleString()} were run. Narrow the ranges or raise the cap — the rest were NOT silently discarded, they were never run.`,
    )
    combos = combos.slice(0, spec.maxCombinations)
  }

  const ind =
    opts.indicators ??
    computeIndicators(dataset.candles, baseConfig.indicators, dataset.timeframe)

  const rows: SweepRow[] = []
  let best: SweepRow | null = null
  let aborted = false
  const every = opts.progressEvery ?? 10

  for (let idx = 0; idx < combos.length; idx++) {
    if (opts.shouldAbort?.()) {
      aborted = true
      warnings.push(`Aborted after ${idx} of ${combos.length} combinations.`)
      break
    }

    const params = combos[idx]
    const config: BacktestConfig = {
      ...baseConfig,
      strategy: {
        ...baseConfig.strategy,
        params: { ...baseConfig.strategy.params, ...params },
      },
    }

    const t0 = Date.now()
    const result = runBacktest(dataset, config, { indicators: ind })
    const row: SweepRow = {
      id: hashObject(params),
      params,
      metrics: result.metrics,
      flags: flagResult(result),
      ambiguousTrades: result.ambiguity.ambiguousTrades,
      durationMs: Date.now() - t0,
    }
    rows.push(row)

    if (
      !best ||
      (row.metrics.expectancyR.point > best.metrics.expectancyR.point &&
        row.metrics.sampleAdequate)
    ) {
      best = row
    }

    if (opts.onProgress && (idx % every === 0 || idx === combos.length - 1)) {
      opts.onProgress({ done: idx + 1, total: combos.length, best })
    }
  }

  const traded = rows.filter((r) => r.metrics.trades > 0).length
  if (traded === 0 && rows.length > 0) {
    warnings.push('No combination produced a single trade. Check the filters before reading anything into this.')
  }

  return {
    rows,
    total,
    truncated,
    aborted,
    durationMs: Date.now() - started,
    warnings,
  }
}

/** Two-dimensional slice of a sweep, for the heatmap. */
export interface Heatmap {
  xKey: string
  yKey: string
  xValues: (number | string | boolean)[]
  yValues: (number | string | boolean)[]
  /** [yIndex][xIndex] — null where no combination exists. */
  cells: (number | null)[][]
  min: number
  max: number
}

export function buildHeatmap(
  rows: SweepRow[],
  xKey: string,
  yKey: string,
  valueOf: (row: SweepRow) => number,
  aggregate: 'best' | 'mean' = 'best',
): Heatmap {
  const xValues = uniqueValues(rows, xKey)
  const yValues = uniqueValues(rows, yKey)

  const buckets = new Map<string, number[]>()
  for (const r of rows) {
    const key = `${String(r.params[xKey])}|${String(r.params[yKey])}`
    const arr = buckets.get(key)
    const v = valueOf(r)
    if (!Number.isFinite(v)) continue
    if (arr) arr.push(v)
    else buckets.set(key, [v])
  }

  let min = Infinity
  let max = -Infinity
  const cells: (number | null)[][] = yValues.map((y) =>
    xValues.map((x) => {
      const arr = buckets.get(`${String(x)}|${String(y)}`)
      if (!arr || !arr.length) return null
      const v =
        aggregate === 'mean'
          ? arr.reduce((a, b) => a + b, 0) / arr.length
          : Math.max(...arr)
      if (v < min) min = v
      if (v > max) max = v
      return v
    }),
  )

  return {
    xKey,
    yKey,
    xValues,
    yValues,
    cells,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
  }
}

function uniqueValues(
  rows: SweepRow[],
  key: string,
): (number | string | boolean)[] {
  const set = new Set<number | string | boolean>()
  for (const r of rows) if (key in r.params) set.add(r.params[key])
  const arr = [...set]
  if (arr.every((v) => typeof v === 'number')) {
    return (arr as number[]).sort((a, b) => a - b)
  }
  return arr.sort((a, b) => String(a).localeCompare(String(b)))
}
