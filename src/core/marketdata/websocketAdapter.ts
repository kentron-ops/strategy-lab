import type { Candle, Timeframe } from '../types'
import type {
  AdapterCapabilities,
  CandleHandler,
  HistoryRequest,
  MarketDataAdapter,
  Subscription,
} from './adapter'

/**
 * Binance public WebSocket + REST adapter.
 *
 * Chosen as the first live adapter because it is the cleanest honest live demo:
 * real streaming candles, in-browser, no backend, no API key, no login. Crypto
 * rather than gold — but the engine is market-agnostic, and PAXG/USDT is a
 * tokenised-gold proxy if a gold-shaped live feed is wanted.
 *
 * Endpoints are public, documented and rate-limited generously for one browser.
 */

const REST = 'https://api.binance.com/api/v3'
const WS = 'wss://stream.binance.com:9443/ws'

const TF_MAP: Record<Timeframe, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h', '1d': '1d',
}

export class BinanceWebSocketAdapter implements MarketDataAdapter {
  private sockets = new Map<string, WebSocket>()
  private disposed = false

  capabilities(): AdapterCapabilities {
    return {
      id: 'binance-ws',
      label: 'Binance (crypto, live)',
      history: true,
      live: true,
      needsKey: false,
      latency: 'REALTIME',
      notes:
        'Public crypto feed, no key required. Try PAXGUSDT for a tokenised-gold proxy. Crypto spreads and hours differ from XAU/USD — an edge measured there does not transfer by default.',
    }
  }

  async getHistory(req: HistoryRequest): Promise<Candle[]> {
    const params = new URLSearchParams({
      symbol: req.symbol.toUpperCase(),
      interval: TF_MAP[req.timeframe],
      limit: String(Math.min(1000, req.limit ?? 1000)),
    })
    if (req.from !== undefined) params.set('startTime', String(req.from))
    if (req.to !== undefined) params.set('endTime', String(req.to))

    const res = await fetch(`${REST}/klines?${params}`)
    if (!res.ok) {
      throw new Error(`Binance history request failed: ${res.status} ${res.statusText}`)
    }
    const rows = (await res.json()) as unknown[]
    return rows.map((r) => {
      const k = r as [number, string, string, string, string, string]
      return {
        t: k[0],
        o: Number(k[1]),
        h: Number(k[2]),
        l: Number(k[3]),
        c: Number(k[4]),
        v: Number(k[5]),
      }
    })
  }

  subscribe(symbol: string, timeframe: Timeframe, onCandle: CandleHandler): Subscription {
    const stream = `${symbol.toLowerCase()}@kline_${TF_MAP[timeframe]}`
    const key = stream

    let ws = this.sockets.get(key)
    const handlers = new Set<CandleHandler>()
    handlers.add(onCandle)

    if (!ws) {
      ws = new WebSocket(`${WS}/${stream}`)
      this.sockets.set(key, ws)

      ws.onmessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            k?: { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean }
          }
          const k = msg.k
          if (!k) return
          const candle: Candle = {
            t: k.t,
            o: Number(k.o),
            h: Number(k.h),
            l: Number(k.l),
            c: Number(k.c),
            v: Number(k.v),
          }
          // k.x === true only when the bar has CLOSED. Strategies act on closed
          // bars; the forming bar is display-only. This flag is the difference.
          for (const h of handlers) h(candle, k.x)
        } catch {
          // Malformed frame — drop it. The next one is a second away.
        }
      }

      ws.onclose = () => {
        this.sockets.delete(key)
        // Reconnect with a delay unless deliberately disposed.
        if (!this.disposed && handlers.size) {
          setTimeout(() => {
            if (!this.disposed && handlers.size) {
              const again = this.subscribe(symbol, timeframe, (c, f) => {
                for (const h of handlers) h(c, f)
              })
              void again
            }
          }, 3000)
        }
      }
    }

    return {
      unsubscribe: () => {
        handlers.delete(onCandle)
        if (!handlers.size) {
          const sock = this.sockets.get(key)
          this.sockets.delete(key)
          sock?.close()
        }
      },
    }
  }

  dispose(): void {
    this.disposed = true
    for (const ws of this.sockets.values()) ws.close()
    this.sockets.clear()
  }
}
