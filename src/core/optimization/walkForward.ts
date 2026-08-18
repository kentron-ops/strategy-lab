import type { BacktestConfig, Dataset, Indicators, Metrics } from '../types'
import { runBacktest } from '../backtest/engine'
import { computeIndicators } from '../indicators'
import { expandGrid, type SweepDimension } from './sweep'
import { objectiveValue, type ObjectiveKey, type ResultFlag } from './scoring'

/**
 * Out-of-sample validation.
 *
 * A parameter set chosen on the same data it is judged on has told you nothing
 * except that a computer can memorise. These two procedures are the difference
 * between a measurement and a story:
 *
 *   splitTest    — one chronological cut, cheap, catches the worst offenders.
 *   walkForward  — rolling re-optimisation, expensive, and the honest answer to
 *                  "would I actually have had these parameters at the time?"
 *
 * Neither ever shuffles. Shuffling a time series destroys the only thing that
 * makes out-of-sample meaningful: that the test data comes AFTER the training.
 */

export interface SplitResult {
  inSample: Metrics
  outOfSample: Metrics
  splitIndex: number
  splitTime: number
  /** OOS objective ÷ IS objective. Below ~0.4 is a red flag. */
  degradation: number
  flags: ResultFlag[]
  verdict: string
}

export function splitTest(
  dataset: Dataset,
  config: BacktestConfig,
  ratio = 0.7,
  objective: ObjectiveKey = 'expectancyR',
  indicators?: Indicators,
): SplitResult {
  const n = dataset.candles.length
  const splitIndex = Math.floor(n * ratio)
  const ind =
    indicators ?? computeIndicators(dataset.candles, config.indicators, dataset.timeframe)

  const is = runBacktest(
    dataset,
    { ...config, fromIndex: 0, toIndex: splitIndex },
    { indicators: ind },
  )
  const oos = runBacktest(
    dataset,
    { ...config, fromIndex: splitIndex + 1, toIndex: n - 1 },
    { indicators: ind },
  )

  const isV = objectiveValue(is.metrics, objective)
  const oosV = objectiveValue(oos.metrics, objective)
  const degradation = isV !== 0 ? oosV / isV : oosV > 0 ? Infinity : 0

  const flags: ResultFlag[] = []
  let verdict: string

  if (oos.metrics.trades < 10) {
    flags.push('INSUFFICIENT_SAMPLE')
    verdict = `Only ${oos.metrics.trades} out-of-sample trades. This split cannot confirm or deny anything — use a longer dataset or a looser filter.`
  } else if (isV > 0 && oosV <= 0) {
    flags.push('POSSIBLE_OVERFIT')
    verdict = `Profitable in-sample and unprofitable out-of-sample. This is the signature of curve fitting, not of an edge.`
  } else if (isV > 0 && degradation < 0.4) {
    flags.push('POSSIBLE_OVERFIT')
    verdict = `Out-of-sample performance is ${(degradation * 100).toFixed(0)}% of in-sample. Some decay is normal; this much usually means the parameters were fitted to noise.`
  } else if (oosV > 0) {
    verdict = `The edge survived the split at ${(degradation * 100).toFixed(0)}% of its in-sample level. That is evidence, not proof — the market can still change.`
  } else {
    verdict = 'Unprofitable in both halves. At least it is consistent.'
  }

  return {
    inSample: is.metrics,
    outOfSample: oos.metrics,
    splitIndex,
    splitTime: dataset.candles[splitIndex]?.t ?? 0,
    degradation,
    flags,
    verdict,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Walk-forward
// ─────────────────────────────────────────────────────────────────────────────

export interface WalkForwardWindow {
  index: number
  trainFrom: number
  trainTo: number
  testFrom: number
  testTo: number
  trainFromTime: number
  testFromTime: number
  testToTime: number
  /** Parameters the optimiser picked on the TRAINING window only. */
  chosenParams: Record<string, number | string | boolean>
  trainMetrics: Metrics
  testMetrics: Metrics
}

export interface WalkForwardResult {
  windows: WalkForwardWindow[]
  /** Metrics of the concatenated out-of-sample periods — the only number that counts. */
  aggregate: {
    trades: number
    netPnl: number
    expectancyR: number
    winRate: number
    profitFactor: number
    maxDrawdownPct: number
  }
  /** Fraction of windows whose test period was profitable. */
  consistency: number
  efficiency: number
  flags: ResultFlag[]
  verdict: string
  warnings: string[]
  durationMs: number
}

export interface WalkForwardSpec {
  dimensions: SweepDimension[]
  trainBars: number
  testBars: number
  /** How far each window advances. Defaults to testBars (non-overlapping tests). */
  stepBars?: number
  /**
   * Purge/embargo gap (López de Prado): bars skipped between the end of
   * training and the start of testing, so a trade OPENED in training cannot
   * still be influencing bars the test window is judged on. Set it to at least
   * the strategy's maximum holding period.
   */
  embargoBars?: number
  objective: ObjectiveKey
  minTrainTrades: number
}

export function runWalkForward(
  dataset: Dataset,
  baseConfig: BacktestConfig,
  spec: WalkForwardSpec,
  opts: {
    onProgress?: (done: number, total: number) => void
    shouldAbort?: () => boolean
    indicators?: Indicators
  } = {},
): WalkForwardResult {
  const started = Date.now()
  const warnings: string[] = []
  const n = dataset.candles.length
  const step = spec.stepBars ?? spec.testBars
  const embargo = Math.max(0, Math.round(spec.embargoBars ?? 0))
  const ind =
    opts.indicators ??
    computeIndicators(dataset.candles, baseConfig.indicators, dataset.timeframe)

  const combos = expandGrid(spec.dimensions)
  const windows: WalkForwardWindow[] = []

  const totalWindows = Math.max(
    0,
    Math.floor((n - spec.trainBars - embargo - spec.testBars) / step) + 1,
  )
  if (totalWindows < 3) {
    warnings.push(
      `Only ${totalWindows} walk-forward window(s) fit in ${n} bars. Fewer than three windows is a coincidence detector, not a validation.`,
    )
  }

  let wIndex = 0
  for (
    let trainFrom = 0;
    trainFrom + spec.trainBars + embargo + spec.testBars <= n;
    trainFrom += step
  ) {
    if (opts.shouldAbort?.()) {
      warnings.push(`Aborted after ${wIndex} windows.`)
      break
    }

    const trainTo = trainFrom + spec.trainBars - 1
    const testFrom = trainTo + 1 + embargo
    const testTo = Math.min(n - 1, testFrom + spec.testBars - 1)

    // ── train: pick the best parameters using ONLY the training window
    let bestParams: Record<string, number | string | boolean> | null = null
    let bestScore = -Infinity
    let bestTrain: Metrics | null = null

    for (const params of combos) {
      const cfg: BacktestConfig = {
        ...baseConfig,
        strategy: {
          ...baseConfig.strategy,
          params: { ...baseConfig.strategy.params, ...params },
        },
        fromIndex: trainFrom,
        toIndex: trainTo,
      }
      const r = runBacktest(dataset, cfg, { indicators: ind })
      if (r.metrics.trades < spec.minTrainTrades) continue
      const score = objectiveValue(r.metrics, spec.objective)
      if (score > bestScore) {
        bestScore = score
        bestParams = params
        bestTrain = r.metrics
      }
    }

    if (!bestParams || !bestTrain) {
      warnings.push(
        `Window ${wIndex}: no parameter set reached ${spec.minTrainTrades} training trades. Window skipped.`,
      )
      wIndex += 1
      continue
    }

    // ── test: run those parameters forward, untouched
    const testCfg: BacktestConfig = {
      ...baseConfig,
      strategy: {
        ...baseConfig.strategy,
        params: { ...baseConfig.strategy.params, ...bestParams },
      },
      fromIndex: testFrom,
      toIndex: testTo,
    }
    const testRun = runBacktest(dataset, testCfg, { indicators: ind })

    windows.push({
      index: wIndex,
      trainFrom,
      trainTo,
      testFrom,
      testTo,
      trainFromTime: dataset.candles[trainFrom].t,
      testFromTime: dataset.candles[testFrom].t,
      testToTime: dataset.candles[testTo].t,
      chosenParams: bestParams,
      trainMetrics: bestTrain,
      testMetrics: testRun.metrics,
    })

    wIndex += 1
    opts.onProgress?.(wIndex, totalWindows)
  }

  // ── aggregate the out-of-sample periods
  const testMetrics = windows.map((w) => w.testMetrics)
  const trades = testMetrics.reduce((a, m) => a + m.trades, 0)
  const netPnl = testMetrics.reduce((a, m) => a + m.netPnl, 0)
  const weightedExpectancy =
    trades > 0
      ? testMetrics.reduce((a, m) => a + m.expectancyR.point * m.trades, 0) / trades
      : 0
  const wins = testMetrics.reduce((a, m) => a + m.wins, 0)
  const grossProfit = testMetrics.reduce((a, m) => a + Math.max(0, m.netPnl), 0)
  const grossLoss = testMetrics.reduce((a, m) => a + Math.max(0, -m.netPnl), 0)
  const maxDd = testMetrics.reduce((a, m) => Math.max(a, m.maxDrawdownPct), 0)

  const profitableWindows = windows.filter((w) => w.testMetrics.netPnl > 0).length
  const consistency = windows.length ? profitableWindows / windows.length : 0

  const trainExpectancy =
    windows.length
      ? windows.reduce((a, w) => a + w.trainMetrics.expectancyR.point, 0) / windows.length
      : 0
  const efficiency = trainExpectancy !== 0 ? weightedExpectancy / trainExpectancy : 0

  const flags: ResultFlag[] = []
  let verdict: string

  if (!windows.length) {
    verdict = 'No usable windows. There is not enough data to walk forward over.'
  } else if (trades < 30) {
    flags.push('INSUFFICIENT_SAMPLE')
    verdict = `${trades} out-of-sample trades across ${windows.length} windows is too thin to conclude anything.`
  } else if (weightedExpectancy <= 0) {
    flags.push('POSSIBLE_OVERFIT')
    verdict = `Re-optimised every window and still lost money forward (${weightedExpectancy.toFixed(3)}R per trade). The in-sample results were fitted, not found.`
  } else if (efficiency < 0.4) {
    flags.push('POSSIBLE_OVERFIT')
    verdict = `Forward performance is ${(efficiency * 100).toFixed(0)}% of training performance. Positive, but most of the apparent edge does not survive being chosen in advance.`
  } else if (consistency >= 0.6) {
    verdict = `${profitableWindows} of ${windows.length} windows were profitable forward, at ${weightedExpectancy.toFixed(3)}R per trade. This is about as good as evidence gets here — and it still says nothing about tomorrow.`
  } else {
    verdict = `Positive overall (${weightedExpectancy.toFixed(3)}R) but only ${profitableWindows} of ${windows.length} windows held up. The result depends heavily on which period you happen to trade.`
  }

  return {
    windows,
    aggregate: {
      trades,
      netPnl,
      expectancyR: weightedExpectancy,
      winRate: trades > 0 ? wins / trades : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      maxDrawdownPct: maxDd,
    },
    consistency,
    efficiency,
    flags,
    verdict,
    warnings,
    durationMs: Date.now() - started,
  }
}
