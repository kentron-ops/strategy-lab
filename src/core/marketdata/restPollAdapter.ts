import type { Candle, Timeframe } from '../types'
import { TF_MS } from '../types'
import type {
  AdapterCapabilities,
  CandleHandler,
  HistoryRequest,
  MarketDataAdapter,
  Subscription,
} from './adapter'

/**
 * REST polling adapter for XAU/FX via the user's own free API key.
 *
 * The honest design (§4): free tiers are rate-limited and delayed, so the
 * capabilities say POLLED, the poll interval respects the provider's limit, and
 * the UI labels the latency instead of pretending the feed is live.
 *
 * Ships with a TwelveData profile (free tier: 8 req/min, 800/day). The key is
 * supplied by the user at runtime and stored locally — never bundled, never
 * transmitted anywhere except to the provider itself.
 */

export interface RestPollConfig {
  apiKey: string
  symbol: string
  /** Milliseconds between polls. Floor enforced to respect free-tier limits. */
  pollIntervalMs: number
}

const MIN_POLL_MS = 10_000

const TF_MAP: Record<Timeframe, string> = {
  '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min',
  '1h': '1h', '4h': '4h', '1d': '1day',
}

export class TwelveDataPollAdapter implements MarketDataAdapter {
  private cfg: RestPollConfig
  private timers = new Set<ReturnType<typeof setInterval>>()

  constructor(cfg: RestPollConfig) {
    this.cfg = { ...cfg, pollIntervalMs: Math.max(MIN_POLL_MS, cfg.pollIntervalMs) }
  }

  capabilities(): AdapterCapabilities {
    return {
      id: 'twelvedata-poll',
      label: 'TwelveData (XAU/FX, polled)',
      history: true,
      live: true,
      needsKey: true,
      latency: 'POLLED',
      notes: `Free-tier REST polling with your own key, every ${Math.round(this.cfg.pollIntervalMs / 1000)}s. Data is delayed and rate-limited — fine for shadow trading and alerts, not for anything latency-sensitive. The key lives in your browser's local storage only.`,
    }
  }

  async getHistory(req: HistoryRequest): Promise<Candle[]> {
    if (!this.cfg.apiKey) {
      throw new Error('No API key configured. Add your free TwelveData key in DATA → live sources.')
    }
    const params = new URLSearchParams({
      symbol: req.symbol,
      interval: TF_MAP[req.timeframe],
      outputsize: String(Math.min(5000, req.limit ?? 500)),
      apikey: this.cfg.apiKey,
      timezone: 'UTC',
    })
    const res = await fetch(`https://api.twelvedata.com/time_series?${params}`)
    if (!res.ok) throw new Error(`TwelveData request failed: ${res.status}`)
    const body = (await res.json()) as {
      status?: string
      message?: string
      values?: { datetime: string; open: string; high: string; low: string; close: string; volume?: string }[]
    }
    if (body.status === 'error') {
      throw new Error(`TwelveData: ${body.message ?? 'unknown error'}`)
    }
    const values = body.values ?? []
    return values
      .map((v) => ({
        t: Date.parse(v.datetime.includes('T') ? v.datetime : v.datetime.replace(' ', 'T') + 'Z'),
        o: Number(v.open),
        h: Number(v.high),
        l: Number(v.low),
        c: Number(v.close),
        v: v.volume !== undefined ? Number(v.volume) : undefined,
      }))
      .filter((c) => Number.isFinite(c.t))
      .sort((a, b) => a.t - b.t)
  }

  subscribe(symbol: string, timeframe: Timeframe, onCandle: CandleHandler): Subscription {
    let lastEmitted = 0
    const barMs = TF_MS[timeframe]

    const poll = async (): Promise<void> => {
      try {
        const candles = await this.getHistory({ symbol, timeframe, limit: 3 })
        for (const c of candles) {
          if (c.t <= lastEmitted) continue
          // A bar is final once the next bucket has started.
          const isFinal = Date.now() >= c.t + barMs
          if (isFinal) lastEmitted = c.t
          onCandle(c, isFinal)
        }
      } catch {
        // Poll failures are transient by nature; the next tick retries.
        // Persistent failures surface through getHistory when the UI checks.
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), this.cfg.pollIntervalMs)
    this.timers.add(timer)

    return {
      unsubscribe: () => {
        clearInterval(timer)
        this.timers.delete(timer)
      },
    }
  }

  dispose(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers.clear()
  }
}

/**
 * TradingViewWebhookAdapter — deliberately NOT implemented (§4).
 *
 * TradingView has no public pull API; it can only push alert webhooks, and a
 * webhook needs a server to receive it. Implementing this would silently break
 * the no-backend promise, so instead the limitation is documented where a
 * developer will look for the adapter. When a relay exists, implement
 * MarketDataAdapter here and register it — nothing in core will change.
 */
export const TRADINGVIEW_ADAPTER_NOTE =
  'TradingView can only push alerts to a webhook, which requires a relay service. Not available in the no-backend build.'
