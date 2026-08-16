import type { Candle, Timeframe } from '../types'
import type {
  AdapterCapabilities,
  CandleHandler,
  HistoryRequest,
  MarketDataAdapter,
  Subscription,
} from './adapter'

/**
 * ReplayAdapter — plays a historical series forward as if it were live.
 *
 * This is the bridge between backtesting and live operation: the shadow trader
 * and the setup scanner consume candles from this adapter exactly as they will
 * from a WebSocket, so the code path being validated is the code path that will
 * eventually run.
 */

export interface ReplayControls {
  play(): void
  pause(): void
  /** Advance exactly one bar while paused. */
  step(): void
  reset(): void
  setSpeed(barsPerSecond: number): void
  /** 0..1 of the way through the series. */
  progress(): number
  currentIndex(): number
  isPlaying(): boolean
}

export class ReplayAdapter implements MarketDataAdapter {
  private candles: Candle[]
  private symbol: string
  private timeframe: Timeframe

  private cursor = 0
  private playing = false
  private barsPerSecond = 4
  private timer: ReturnType<typeof setInterval> | null = null
  private handlers = new Set<CandleHandler>()

  constructor(candles: Candle[], symbol: string, timeframe: Timeframe) {
    this.candles = candles
    this.symbol = symbol
    this.timeframe = timeframe
  }

  capabilities(): AdapterCapabilities {
    return {
      id: 'replay',
      label: 'Replay',
      history: true,
      live: true,
      needsKey: false,
      latency: 'NONE',
      notes:
        'Historical data replayed bar by bar. Live in shape, historical in fact — the honest rehearsal space.',
    }
  }

  /** History = everything BEHIND the cursor. The future stays invisible. */
  getHistory(req: HistoryRequest): Promise<Candle[]> {
    let out = this.candles.slice(0, this.cursor)
    if (req.from !== undefined) out = out.filter((c) => c.t >= (req.from as number))
    if (req.to !== undefined) out = out.filter((c) => c.t <= (req.to as number))
    if (req.limit !== undefined && out.length > req.limit) out = out.slice(-req.limit)
    return Promise.resolve(out)
  }

  subscribe(_symbol: string, _tf: Timeframe, onCandle: CandleHandler): Subscription {
    this.handlers.add(onCandle)
    return { unsubscribe: () => this.handlers.delete(onCandle) }
  }

  dispose(): void {
    this.pause()
    this.handlers.clear()
  }

  // ── controls ────────────────────────────────────────────────────────────────

  controls(): ReplayControls {
    return {
      play: () => this.play(),
      pause: () => this.pause(),
      step: () => this.emitNext(),
      reset: () => this.reset(),
      setSpeed: (bps: number) => {
        this.barsPerSecond = Math.max(0.25, Math.min(100, bps))
        if (this.playing) {
          this.pause()
          this.play()
        }
      },
      progress: () => (this.candles.length ? this.cursor / this.candles.length : 0),
      currentIndex: () => this.cursor - 1,
      isPlaying: () => this.playing,
    }
  }

  private play(): void {
    if (this.playing || this.cursor >= this.candles.length) return
    this.playing = true
    this.timer = setInterval(() => this.emitNext(), 1000 / this.barsPerSecond)
  }

  private pause(): void {
    this.playing = false
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private reset(): void {
    this.pause()
    this.cursor = 0
  }

  private emitNext(): void {
    if (this.cursor >= this.candles.length) {
      this.pause()
      return
    }
    const candle = this.candles[this.cursor]
    this.cursor += 1
    for (const h of this.handlers) h(candle, true)
  }
}
