import React, { useEffect, useRef } from 'react'
import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts'
import type { Candle, Trade } from '../../core/types'

/** Candle chart via lightweight-charts, with optional trade markers and levels. */

export interface TradeOverlay {
  trade: Trade
}

export function CandleChart({
  candles,
  trades = [],
  selected = null,
  height,
  theme,
  onSelectTrade,
}: {
  candles: Candle[]
  trades?: Trade[]
  selected?: Trade | null
  /** Optional explicit height. When omitted the chart fills its container. */
  height?: number
  theme: 'dark' | 'light'
  onSelectTrade?: (t: Trade) => void
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const markersRef = useRef<ReturnType<typeof createSeriesMarkers<Time>> | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const dark = theme === 'dark'
    // Carbon-derived palette; the redesign brief demands ≥4.5:1 on chart labels,
    // and the previous #8b93a0 fell short on Gray 100.
    const chart = createChart(host, {
      layout: {
        background: { color: 'transparent' },
        textColor: dark ? '#c6c6c6' : '#393939',
        fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: dark ? '#26262a' : '#e0e0e0' },
        horzLines: { color: dark ? '#26262a' : '#e0e0e0' },
      },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: dark ? '#333338' : '#d0d0d0' },
      rightPriceScale: { borderColor: dark ? '#333338' : '#d0d0d0' },
      crosshair: { mode: 0 },
      autoSize: true,
      ...(height !== undefined ? { height } : {}),
    })

    const series = chart.addSeries(CandlestickSeries, {
      upColor: dark ? '#24a148' : '#198038',
      downColor: dark ? '#f24d5a' : '#da1e28',
      borderVisible: false,
      wickUpColor: dark ? '#24a148' : '#198038',
      wickDownColor: dark ? '#f24d5a' : '#da1e28',
    })

    chartRef.current = chart
    seriesRef.current = series
    markersRef.current = createSeriesMarkers(series, [])

    return () => {
      markersRef.current = null
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [theme, height])

  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    series.setData(
      candles.map((c) => ({
        time: (c.t / 1000) as Time,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      })),
    )
    chartRef.current?.timeScale().fitContent()
  }, [candles])

  useEffect(() => {
    const markersApi = markersRef.current
    if (!markersApi) return
    const markers: SeriesMarker<Time>[] = []
    for (const t of trades) {
      markers.push({
        time: (t.entryTime / 1000) as Time,
        position: t.side === 'LONG' ? 'belowBar' : 'aboveBar',
        color: t.side === 'LONG' ? 'rgba(111,174,143,0.9)' : 'rgba(201,129,129,0.9)',
        shape: t.side === 'LONG' ? 'arrowUp' : 'arrowDown',
        text: '',
        size: selected?.id === t.id ? 2 : 1,
      })
      markers.push({
        time: (t.exitTime / 1000) as Time,
        position: 'inBar',
        color:
          t.netPnl >= 0 ? 'rgba(111,174,143,0.65)' : 'rgba(201,129,129,0.65)',
        shape: 'circle',
        text: selected?.id === t.id ? `${t.r.toFixed(2)}R` : '',
        size: selected?.id === t.id ? 2 : 1,
      })
    }
    markers.sort((a, b) => Number(a.time) - Number(b.time))
    markersApi.setMarkers(markers)
  }, [trades, selected])

  // click → nearest trade
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !onSelectTrade) return
    const handler = (param: { time?: Time }): void => {
      if (param.time === undefined) return
      const t = Number(param.time) * 1000
      let best: Trade | null = null
      let bestDist = Infinity
      for (const tr of trades) {
        const d = Math.min(Math.abs(tr.entryTime - t), Math.abs(tr.exitTime - t))
        if (d < bestDist) {
          bestDist = d
          best = tr
        }
      }
      if (best) onSelectTrade(best)
    }
    chart.subscribeClick(handler)
    return () => chart.unsubscribeClick(handler)
  }, [trades, onSelectTrade])

  return (
    <div
      ref={hostRef}
      className="chart-box"
      style={height !== undefined ? { height } : { position: 'absolute', inset: 0 }}
    />
  )
}
