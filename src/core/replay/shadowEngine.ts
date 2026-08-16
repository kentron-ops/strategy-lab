import type {
  BacktestConfig,
  Candle,
  Indicators,
  StrategyConfig,
  Timeframe,
} from '../types'
import { DEFAULT_INDICATORS } from '../types'
import { computeIndicators } from '../indicators'
import type { ExpectancyBook } from '../recommend/expectancyBook'
import type { DecayReport } from '../recommend/expectancyBook'
import { scanSetups, type Recommendation } from '../recommend/scanner'

/**
 * Shadow trading.
 *
 * Point this at a ReplayAdapter or a live adapter and it emits
 * WAIT / LONG / SHORT with full evidence, in real time, without ever sending an
 * order. It is how a strategy earns the right to be believed forward — and it is
 * the bridge to any future live use, because it consumes candles through the
 * same adapter interface a broker connection would.
 *
 * No execution code exists anywhere in this build. That is a feature.
 */

export interface ShadowSignal {
  time: number
  barIndex: number
  recommendations: Recommendation[]
  /** The headline: best actionable recommendation, or null = WAIT. */
  best: Recommendation | null
  candle: Candle
}

export type ShadowListener = (signal: ShadowSignal) => void

export interface ShadowEngineOptions {
  config: BacktestConfig
  configs: StrategyConfig[]
  book: ExpectancyBook
  decay: DecayReport | null
  timeframe: Timeframe
  /** How much history the indicators need before signals begin. */
  warmupBars?: number
  /** Recompute indicators every N bars rather than every bar, for cheap CPUs. */
  recomputeEvery?: number
}

export class ShadowEngine {
  private candles: Candle[] = []
  private ind: Indicators | null = null
  private listeners = new Set<ShadowListener>()
  private opts: ShadowEngineOptions
  private sinceRecompute = 0

  constructor(opts: ShadowEngineOptions) {
    this.opts = { warmupBars: 250, recomputeEvery: 1, ...opts }
  }

  /** Seed with history so the warm-up period is already behind us. */
  seed(history: Candle[]): void {
    this.candles = [...history]
    this.recompute()
  }

  onSignal(listener: ShadowListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Feed one candle. Only FINAL (closed) candles advance the engine — a forming
   * bar is display information, not decision information. This mirrors the
   * backtester exactly: decisions happen at bar close.
   */
  push(candle: Candle, isFinal: boolean): void {
    if (!isFinal) return

    const last = this.candles[this.candles.length - 1]
    if (last && candle.t <= last.t) {
      // Duplicate or out-of-order frame from the feed; the engine's history
      // must stay strictly increasing.
      if (candle.t === last.t) this.candles[this.candles.length - 1] = candle
      return
    }

    this.candles.push(candle)
    this.sinceRecompute += 1

    if (this.candles.length < (this.opts.warmupBars ?? 250)) return

    if (this.ind === null || this.sinceRecompute >= (this.opts.recomputeEvery ?? 1)) {
      this.recompute()
    }
    if (!this.ind) return

    const i = this.candles.length - 1
    const recommendations = scanSetups(this.opts.configs, {
      candles: this.candles,
      i,
      ind: this.ind,
      equity: this.opts.config.risk.startingEquity,
      instrument: this.opts.config.instrument,
      config: this.opts.config,
      book: this.opts.book,
      decay: this.opts.decay,
      minutesToNextEvent: null,
    })

    const best =
      recommendations.find((r) => r.action !== 'WAIT' && r.grade !== 'INSUFFICIENT') ?? null

    const signal: ShadowSignal = {
      time: candle.t,
      barIndex: i,
      recommendations,
      best,
      candle,
    }
    for (const l of this.listeners) l(signal)
  }

  history(): Candle[] {
    return this.candles
  }

  private recompute(): void {
    if (this.candles.length < 30) return
    this.ind = computeIndicators(
      this.candles,
      this.opts.config.indicators ?? DEFAULT_INDICATORS,
      this.opts.timeframe,
    )
    this.sinceRecompute = 0
  }
}
