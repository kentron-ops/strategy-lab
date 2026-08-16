import type { Candle, Timeframe } from '../types'

/**
 * MarketDataAdapter — the single most important interface in the app (§2).
 *
 * Everything that supplies candles sits behind this. The UI never assumes live
 * data exists: it reads `capabilities()` and adapts to reality instead of
 * pretending. Swapping a CSV for a live WebSocket must not touch core logic.
 */

export interface AdapterCapabilities {
  id: string
  label: string
  /** Can serve historical candles. */
  history: boolean
  /** Can push live candles. */
  live: boolean
  /** Requires a user-supplied API key (stored locally, never bundled). */
  needsKey: boolean
  /** Honest label for the feed's latency, shown in the UI. */
  latency: 'NONE' | 'REALTIME' | 'DELAYED' | 'POLLED'
  /** Human-readable caveats, surfaced verbatim. */
  notes: string
}

export interface HistoryRequest {
  symbol: string
  timeframe: Timeframe
  /** Epoch ms, inclusive. Omitted = as much as the source allows. */
  from?: number
  to?: number
  limit?: number
}

export type CandleHandler = (candle: Candle, isFinal: boolean) => void

export interface Subscription {
  unsubscribe(): void
}

export interface MarketDataAdapter {
  capabilities(): AdapterCapabilities
  getHistory(req: HistoryRequest): Promise<Candle[]>
  /**
   * Subscribe to live candles. Implementations that cannot stream throw —
   * callers must check capabilities().live first.
   */
  subscribe(symbol: string, timeframe: Timeframe, onCandle: CandleHandler): Subscription
  /** Free sockets/timers. Safe to call twice. */
  dispose(): void
}

/**
 * ExecutionAdapter — interface only, by design (§3).
 * No implementation exists in this build and none should be added until a paper
 * edge has actually survived shadow trading. The interface exists so that day
 * requires no rewrite.
 */
export interface ExecutionAdapter {
  placeOrder(order: unknown): Promise<{ id: string }>
  modify(id: string, changes: unknown): Promise<void>
  cancel(id: string): Promise<void>
  positions(): Promise<unknown[]>
}

/** NotifierAdapter — browser notification now; webhook/telegram later (§13). */
export interface NotifierAdapter {
  notify(title: string, body: string): Promise<boolean>
  capabilities(): { id: string; requiresPermission: boolean }
}
