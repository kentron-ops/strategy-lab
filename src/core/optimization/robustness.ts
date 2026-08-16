import type { BacktestConfig, Dataset, Indicators } from '../types'
import { runBacktest } from '../backtest/engine'
import { computeIndicators } from '../indicators'
import { getStrategy } from '../strategy/registry'
import { objectiveValue, type ObjectiveKey, type ResultFlag } from './scoring'
import { mean, stdev } from '../util/stats'

/**
 * Robustness — the neighbourhood test.
 *
 * A real effect is usually a plateau: nearby parameter values also work, because
 * the market does not care that you chose 1.5 rather than 1.4. A fitted artefact
 * is usually a spike: one magic value works and its neighbours collapse.
 *
 * This is the cheapest good defence against overfitting, and unlike walk-forward
 * it costs only a handful of extra runs.
 */

export interface NeighbourResult {
  params: Record<string, number | string | boolean>
  score: number
  trades: number
  /** Which parameter was perturbed, and by how much. */
  perturbed: string
  delta: number
}

export interface RobustnessResult {
  centre: { params: Record<string, number | string | boolean>; score: number; trades: number }
  neighbours: NeighbourResult[]
  /** Mean neighbour score ÷ centre score. */
  retention: number
  /** Spread of neighbour scores relative to their mean. Lower is steadier. */
  dispersion: number
  worst: NeighbourResult | null
  flags: ResultFlag[]
  verdict: string
}

export interface RobustnessSpec {
  /** Which numeric params to perturb. Defaults to every sweepable one. */
  keys?: string[]
  /** Fractional steps applied either side, e.g. [0.1, 0.2] = ±10%, ±20%. */
  steps: number[]
  objective: ObjectiveKey
}

export const DEFAULT_ROBUSTNESS: RobustnessSpec = {
  steps: [0.1, 0.25],
  objective: 'expectancyR',
}

export function testRobustness(
  dataset: Dataset,
  config: BacktestConfig,
  spec: RobustnessSpec = DEFAULT_ROBUSTNESS,
  indicators?: Indicators,
): RobustnessResult {
  const ind =
    indicators ?? computeIndicators(dataset.candles, config.indicators, dataset.timeframe)

  const strategy = getStrategy(config.strategy.strategyId)
  const numericKeys = strategy.paramSpec
    .filter((p) => p.kind === 'number' && (!spec.keys || spec.keys.includes(p.key)))
    .filter((p) => (spec.keys ? true : Boolean(p.sweep)))

  const centreRun = runBacktest(dataset, config, { indicators: ind })
  const centreScore = objectiveValue(centreRun.metrics, spec.objective)

  const neighbours: NeighbourResult[] = []

  for (const p of numericKeys) {
    const base = config.strategy.params[p.key]
    if (typeof base !== 'number') continue

    for (const frac of spec.steps) {
      for (const sign of [-1, 1]) {
        let value: number = base * (1 + sign * frac)
        if (p.step && p.step >= 1) value = Math.round(value)
        else value = Number(value.toFixed(4))
        if (p.min !== undefined) value = Math.max(p.min, value)
        if (p.max !== undefined) value = Math.min(p.max, value)
        if (value === base) continue

        const cfg: BacktestConfig = {
          ...config,
          strategy: {
            ...config.strategy,
            params: { ...config.strategy.params, [p.key]: value },
          },
        }
        const r = runBacktest(dataset, cfg, { indicators: ind })
        neighbours.push({
          params: cfg.strategy.params,
          score: objectiveValue(r.metrics, spec.objective),
          trades: r.metrics.trades,
          perturbed: p.key,
          delta: sign * frac,
        })
      }
    }
  }

  const scores = neighbours.map((nb) => nb.score)
  const avg = scores.length ? mean(scores) : 0
  const retention = centreScore !== 0 ? avg / centreScore : 0
  const dispersion = scores.length && avg !== 0 ? stdev(scores) / Math.abs(avg) : 0
  const worst = neighbours.length
    ? neighbours.reduce((a, b) => (b.score < a.score ? b : a))
    : null

  const flags: ResultFlag[] = []
  let verdict: string

  if (!neighbours.length) {
    verdict = 'No numeric parameters to perturb, so robustness cannot be assessed here.'
  } else if (centreScore <= 0) {
    verdict = 'The centre configuration is not profitable, so there is no plateau to test.'
  } else if (retention < 0.35 || (worst && worst.score < 0 && centreScore > 0)) {
    flags.push('FRAGILE')
    verdict = `Neighbouring parameters retain only ${(retention * 100).toFixed(0)}% of the centre's score${
      worst ? `, and ${worst.perturbed} at ${(worst.delta * 100).toFixed(0)}% turns it negative` : ''
    }. This result sits on a spike. Spikes are almost always luck.`
  } else if (retention >= 0.7 && dispersion < 0.6) {
    flags.push('MORE_ROBUST')
    verdict = `A broad neighbourhood holds up (${(retention * 100).toFixed(0)}% retention, low dispersion). This is what a real effect tends to look like — which is evidence, not a guarantee.`
  } else {
    verdict = `Neighbours retain ${(retention * 100).toFixed(0)}% of the centre's score with moderate spread. Neither a spike nor a plateau; treat the exact values as arbitrary and prefer the middle of the region.`
  }

  return {
    centre: {
      params: config.strategy.params,
      score: centreScore,
      trades: centreRun.metrics.trades,
    },
    neighbours,
    retention,
    dispersion,
    worst,
    flags,
    verdict,
  }
}
