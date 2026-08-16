import type { Candle, Dataset, Timeframe } from '../types'
import type {
  AdapterCapabilities,
  CandleHandler,
  HistoryRequest,
  MarketDataAdapter,
  Subscription,
} from './adapter'

/** Serves candles from datasets already imported. No network, works offline. */
export class CsvAdapter implements MarketDataAdapter {
  private datasets: Dataset[]

  constructor(datasets: Dataset[]) {
    this.datasets = datasets
  }

  capabilities(): AdapterCapabilities {
    return {
      id: 'csv',
      label: 'Imported files',
      history: true,
      live: false,
      needsKey: false,
      latency: 'NONE',
      notes: 'Static historical data. As current as the file you loaded, and no more.',
    }
  }

  getHistory(req: HistoryRequest): Promise<Candle[]> {
    const ds = this.datasets.find(
      (d) => d.symbol === req.symbol && d.timeframe === req.timeframe,
    ) ?? this.datasets.find((d) => d.symbol === req.symbol)

    if (!ds) return Promise.resolve([])

    let candles = ds.candles
    if (req.from !== undefined) candles = candles.filter((c) => c.t >= (req.from as number))
    if (req.to !== undefined) candles = candles.filter((c) => c.t <= (req.to as number))
    if (req.limit !== undefined && candles.length > req.limit) {
      candles = candles.slice(-req.limit)
    }
    return Promise.resolve(candles)
  }

  subscribe(_s: string, _tf: Timeframe, _h: CandleHandler): Subscription {
    throw new Error('CsvAdapter cannot stream. Check capabilities().live before subscribing.')
  }

  dispose(): void {
    // nothing to free
  }
}
