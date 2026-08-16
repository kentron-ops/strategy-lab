import * as Comlink from 'comlink'
import type { BacktestConfig, BacktestResult, Dataset } from '../core/types'
import { runBacktest } from '../core/backtest/engine'
import { computeIndicators } from '../core/indicators'
import { splitTest, runWalkForward, type WalkForwardResult, type SplitResult, type WalkForwardSpec } from '../core/optimization/walkForward'
import { testRobustness, type RobustnessResult, type RobustnessSpec } from '../core/optimization/robustness'
import { runMonteCarlo, type MonteCarloResult, type MonteCarloSpec } from '../core/optimization/monteCarlo'
import type { Trade, Indicators } from '../core/types'
import type { ObjectiveKey } from '../core/optimization/scoring'

/**
 * Backtest worker. Keeps the UI thread free while the engine runs.
 * The indicator cache lives here so consecutive runs on the same dataset only
 * pay the indicator cost once.
 */

let cachedDatasetHash: string | null = null
let cachedIndicators: Indicators | null = null
let cachedIndicatorConfigKey: string | null = null
let abortRequested = false

function indicatorsFor(dataset: Dataset, config: BacktestConfig): Indicators {
  const cfgKey = JSON.stringify(config.indicators)
  if (
    cachedDatasetHash === dataset.hash &&
    cachedIndicatorConfigKey === cfgKey &&
    cachedIndicators
  ) {
    return cachedIndicators
  }
  cachedIndicators = computeIndicators(dataset.candles, config.indicators, dataset.timeframe)
  cachedDatasetHash = dataset.hash
  cachedIndicatorConfigKey = cfgKey
  return cachedIndicators
}

const api = {
  run(
    dataset: Dataset,
    config: BacktestConfig,
    onProgress?: (fraction: number) => void,
  ): BacktestResult {
    abortRequested = false
    const ind = indicatorsFor(dataset, config)
    return runBacktest(dataset, config, {
      indicators: ind,
      onProgress: onProgress ? (f) => onProgress(f) : undefined,
      shouldAbort: () => abortRequested,
    })
  },

  split(dataset: Dataset, config: BacktestConfig, ratio: number): SplitResult {
    const ind = indicatorsFor(dataset, config)
    return splitTest(dataset, config, ratio, 'expectancyR', ind)
  },

  walkForward(
    dataset: Dataset,
    config: BacktestConfig,
    spec: WalkForwardSpec,
    onProgress?: (done: number, total: number) => void,
  ): WalkForwardResult {
    abortRequested = false
    const ind = indicatorsFor(dataset, config)
    return runWalkForward(dataset, config, spec, {
      indicators: ind,
      onProgress,
      shouldAbort: () => abortRequested,
    })
  },

  robustness(
    dataset: Dataset,
    config: BacktestConfig,
    spec: RobustnessSpec,
  ): RobustnessResult {
    const ind = indicatorsFor(dataset, config)
    return testRobustness(dataset, config, spec, ind)
  },

  monteCarlo(trades: Trade[], spec: MonteCarloSpec): MonteCarloResult {
    return runMonteCarlo(trades, spec)
  },

  abort(): void {
    abortRequested = true
  },
}

export type BacktestWorkerApi = typeof api

Comlink.expose(api)
