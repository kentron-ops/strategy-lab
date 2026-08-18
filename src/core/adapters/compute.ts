import type { BacktestConfig, BacktestResult, Dataset, Trade } from '../types'
import type { SplitResult, WalkForwardResult, WalkForwardSpec } from '../optimization/walkForward'
import type { RobustnessResult, RobustnessSpec } from '../optimization/robustness'
import type { MonteCarloResult, MonteCarloSpec } from '../optimization/monteCarlo'
import type { SweepProgress, SweepResult, SweepSpec } from '../optimization/sweep'
import type { ProofResult, ProverOptions } from '../prover/prover'

/**
 * ComputeAdapter (V2 §2) — every heavy job goes through this interface.
 *
 * Today it resolves to Web Workers; a future backend implements the same
 * contract over HTTP (see docs/BACKEND_CONTRACT.md) and swaps in without the
 * UI noticing. That is why every request and response here is plain JSON —
 * nothing carries a function, a class instance, or a DOM handle, except the
 * explicitly-optional progress callbacks, which a remote implementation may
 * service via polling or SSE.
 */
export interface ComputeAdapter {
  backtest(
    dataset: Dataset,
    config: BacktestConfig,
    onProgress?: (fraction: number) => void,
  ): Promise<BacktestResult>

  split(dataset: Dataset, config: BacktestConfig, ratio: number): Promise<SplitResult>

  walkForward(
    dataset: Dataset,
    config: BacktestConfig,
    spec: WalkForwardSpec,
    onProgress?: (done: number, total: number) => void,
  ): Promise<WalkForwardResult>

  robustness(
    dataset: Dataset,
    config: BacktestConfig,
    spec: RobustnessSpec,
  ): Promise<RobustnessResult>

  monteCarlo(trades: Trade[], spec: MonteCarloSpec): Promise<MonteCarloResult>

  sweep(
    dataset: Dataset,
    config: BacktestConfig,
    spec: SweepSpec,
    onProgress?: (p: SweepProgress) => void,
  ): Promise<SweepResult>

  prove(
    dataset: Dataset,
    config: BacktestConfig,
    opts: Omit<ProverOptions, 'onProgress' | 'shouldAbort' | 'indicators'>,
    onProgress?: (stage: string, fraction: number) => void,
  ): Promise<ProofResult>

  /** Cooperative cancel of whatever is currently running. */
  abort(): void
}
