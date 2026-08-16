import * as Comlink from 'comlink'
import type { BacktestConfig, Dataset, Indicators } from '../core/types'
import { computeIndicators } from '../core/indicators'
import {
  runSweep,
  type SweepProgress,
  type SweepResult,
  type SweepSpec,
} from '../core/optimization/sweep'

/** Optimizer worker — parameter sweeps off the UI thread. */

let cachedDatasetHash: string | null = null
let cachedIndicators: Indicators | null = null
let cachedIndicatorConfigKey: string | null = null
let abortRequested = false

const api = {
  sweep(
    dataset: Dataset,
    config: BacktestConfig,
    spec: SweepSpec,
    onProgress?: (p: SweepProgress) => void,
  ): SweepResult {
    abortRequested = false
    const cfgKey = JSON.stringify(config.indicators)
    if (
      cachedDatasetHash !== dataset.hash ||
      cachedIndicatorConfigKey !== cfgKey ||
      !cachedIndicators
    ) {
      cachedIndicators = computeIndicators(
        dataset.candles,
        config.indicators,
        dataset.timeframe,
      )
      cachedDatasetHash = dataset.hash
      cachedIndicatorConfigKey = cfgKey
    }
    return runSweep(dataset, config, spec, {
      indicators: cachedIndicators,
      onProgress,
      shouldAbort: () => abortRequested,
    })
  },

  abort(): void {
    abortRequested = true
  },
}

export type OptimizerWorkerApi = typeof api

Comlink.expose(api)
