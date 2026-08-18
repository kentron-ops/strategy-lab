import * as Comlink from 'comlink'
import type { ComputeAdapter } from '../core/adapters/compute'
import type { BacktestWorkerApi } from '../workers/backtest.worker'
import type { OptimizerWorkerApi } from '../workers/optimizer.worker'

/**
 * LocalComputeAdapter — ComputeAdapter over Web Workers via Comlink.
 * The UI and store import `compute`, never a worker. A future
 * RemoteComputeAdapter implements the same interface over HTTP.
 */

let backtestWorker: Comlink.Remote<BacktestWorkerApi> | null = null
let optimizerWorker: Comlink.Remote<OptimizerWorkerApi> | null = null

function bt(): Comlink.Remote<BacktestWorkerApi> {
  if (!backtestWorker) {
    const w = new Worker(new URL('../workers/backtest.worker.ts', import.meta.url), {
      type: 'module',
    })
    backtestWorker = Comlink.wrap<BacktestWorkerApi>(w)
  }
  return backtestWorker
}

function opt(): Comlink.Remote<OptimizerWorkerApi> {
  if (!optimizerWorker) {
    const w = new Worker(new URL('../workers/optimizer.worker.ts', import.meta.url), {
      type: 'module',
    })
    optimizerWorker = Comlink.wrap<OptimizerWorkerApi>(w)
  }
  return optimizerWorker
}

export const compute: ComputeAdapter = {
  backtest: (dataset, config, onProgress) =>
    bt().run(dataset, config, onProgress ? Comlink.proxy(onProgress) : undefined),

  split: (dataset, config, ratio) => bt().split(dataset, config, ratio),

  walkForward: (dataset, config, spec, onProgress) =>
    bt().walkForward(dataset, config, spec, onProgress ? Comlink.proxy(onProgress) : undefined),

  robustness: (dataset, config, spec) => bt().robustness(dataset, config, spec),

  monteCarlo: (trades, spec) => bt().monteCarlo(trades, spec),

  sweep: (dataset, config, spec, onProgress) =>
    opt().sweep(dataset, config, spec, onProgress ? Comlink.proxy(onProgress) : undefined),

  prove: (dataset, config, opts, onProgress) =>
    bt().prove(dataset, config, opts, onProgress ? Comlink.proxy(onProgress) : undefined),

  abort: () => {
    void bt().abort()
    void opt().abort()
  },
}
