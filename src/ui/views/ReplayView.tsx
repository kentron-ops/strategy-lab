import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useLab } from '../../state/store'
import { Badge, Callout, Section, fmtNum } from '../components/bits'
import { CandleChart } from '../components/CandleChart'
import { ReplayAdapter } from '../../core/marketdata/replayAdapter'
import { BinanceWebSocketAdapter } from '../../core/marketdata/websocketAdapter'
import { ShadowEngine, type ShadowSignal } from '../../core/replay/shadowEngine'
import { buildExpectancyBook, measureDecay, DEFAULT_BOOK_SPEC } from '../../core/recommend/expectancyBook'
import type { Candle, Timeframe } from '../../core/types'
import { formatDate } from '../../core/util/time'

/**
 * REPLAY — candle-by-candle replay and shadow trading, driven by the same core
 * engine as the backtester. Also hosts the live crypto feed (no key, no
 * backend) behind the same adapter interface.
 */

type Source = 'replay' | 'live'

export function ReplayView(): React.ReactElement {
  const s = useLab()
  const dataset = s.activeDataset()
  const result = s.result

  const [source, setSource] = useState<Source>('replay')
  const [liveSymbol, setLiveSymbol] = useState('PAXGUSDT')
  const [liveTf, setLiveTf] = useState<Timeframe>('1m')
  const [liveStatus, setLiveStatus] = useState<'idle' | 'connecting' | 'streaming' | 'error'>('idle')
  const [liveError, setLiveError] = useState('')

  const [visible, setVisible] = useState<Candle[]>([])
  const [signals, setSignals] = useState<ShadowSignal[]>([])
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(8)
  const [progress, setProgress] = useState(0)

  const replayRef = useRef<ReplayAdapter | null>(null)
  const liveRef = useRef<BinanceWebSocketAdapter | null>(null)
  const engineRef = useRef<ShadowEngine | null>(null)

  const book = useMemo(() => {
    if (!result) return buildExpectancyBook([], DEFAULT_BOOK_SPEC)
    return buildExpectancyBook(result.trades, { ...DEFAULT_BOOK_SPEC, minSample: 10 })
  }, [result])

  const decay = useMemo(() => (result ? measureDecay(result.trades) : null), [result])

  // ── engine setup (per source / config change)
  useEffect(() => {
    setVisible([])
    setSignals([])
    setProgress(0)
    setPlaying(false)
    replayRef.current?.dispose()
    liveRef.current?.dispose()
    replayRef.current = null
    liveRef.current = null
    setLiveStatus('idle')

    if (!dataset) return

    const engine = new ShadowEngine({
      config: s.backtestConfig(),
      configs: [s.strategyConfig],
      book,
      decay,
      timeframe: source === 'live' ? liveTf : dataset.timeframe,
      warmupBars: 120,
    })
    engineRef.current = engine

    const un = engine.onSignal((sig) => {
      setSignals((prev) => {
        const next = [...prev, sig]
        return next.length > 200 ? next.slice(-200) : next
      })
    })

    if (source === 'replay') {
      const warmup = 120
      const replay = new ReplayAdapter(dataset.candles, dataset.symbol, dataset.timeframe)
      replayRef.current = replay
      engine.seed(dataset.candles.slice(0, warmup))
      setVisible(dataset.candles.slice(0, warmup))

      // Pre-advance the replay cursor past the seed so it emits from there.
      const controls = replay.controls()
      for (let i = 0; i < warmup; i++) controls.step()
      setProgress(controls.progress())

      replay.subscribe(dataset.symbol, dataset.timeframe, (candle, isFinal) => {
        engine.push(candle, isFinal)
        setVisible((prev) => {
          const next = [...prev, candle]
          return next.length > 600 ? next.slice(-600) : next
        })
        setProgress(replay.controls().progress())
      })
    } else {
      const live = new BinanceWebSocketAdapter()
      liveRef.current = live
      setLiveStatus('connecting')
      setLiveError('')
      live
        .getHistory({ symbol: liveSymbol, timeframe: liveTf, limit: 500 })
        .then((history) => {
          engine.seed(history)
          setVisible(history.slice(-600))
          live.subscribe(liveSymbol, liveTf, (candle, isFinal) => {
            setLiveStatus('streaming')
            engine.push(candle, isFinal)
            setVisible((prev) => {
              const next = [...prev]
              if (next.length && next[next.length - 1].t === candle.t) {
                next[next.length - 1] = candle
              } else {
                next.push(candle)
              }
              return next.length > 600 ? next.slice(-600) : next
            })
          })
        })
        .catch((err: unknown) => {
          setLiveStatus('error')
          setLiveError(err instanceof Error ? err.message : String(err))
        })
    }

    return () => {
      un()
      replayRef.current?.dispose()
      liveRef.current?.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset?.id, source, liveSymbol, liveTf, s.strategyConfig, book])

  const controls = replayRef.current?.controls() ?? null

  if (!dataset) return <Callout>Load a dataset first.</Callout>

  const latest = signals[signals.length - 1] ?? null

  return (
    <>
      <Section
        title="Source"
        right={
          source === 'live' ? (
            <Badge kind={liveStatus === 'streaming' ? 'good' : liveStatus === 'error' ? 'bad' : 'warn'}>
              {liveStatus === 'streaming' ? '● live — realtime, no key' : liveStatus}
            </Badge>
          ) : (
            <Badge>replay — historical, {dataset.timeframe}</Badge>
          )
        }
      >
        <div className="row">
          <div className="field">
            <label>Feed</label>
            <select value={source} onChange={(e) => setSource(e.target.value as Source)}>
              <option value="replay">Replay of {dataset.symbol} ({dataset.candles.length.toLocaleString()} bars)</option>
              <option value="live">Live crypto WebSocket (Binance, no key)</option>
            </select>
          </div>
          {source === 'live' && (
            <>
              <div className="field">
                <label>Symbol</label>
                <input type="text" value={liveSymbol} onChange={(e) => setLiveSymbol(e.target.value.toUpperCase())} />
                <span className="hint">PAXGUSDT ≈ tokenised gold · BTCUSDT etc.</span>
              </div>
              <div className="field">
                <label>Timeframe</label>
                <select value={liveTf} onChange={(e) => setLiveTf(e.target.value as Timeframe)}>
                  {(['1m', '5m', '15m', '1h'] as Timeframe[]).map((tf) => (
                    <option key={tf} value={tf}>{tf}</option>
                  ))}
                </select>
              </div>
            </>
          )}
          {source === 'replay' && controls && (
            <>
              <button
                className="btn"
                onClick={() => {
                  if (playing) controls.pause()
                  else {
                    controls.setSpeed(speed)
                    controls.play()
                  }
                  setPlaying(!playing)
                }}
              >
                {playing ? 'pause' : 'play'}
              </button>
              <button className="btn" onClick={() => controls.step()}>step</button>
              <div className="field" style={{ maxWidth: 120 }}>
                <label>bars / s</label>
                <input
                  type="number" min={1} max={100} value={speed}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    if (Number.isFinite(v)) {
                      setSpeed(v)
                      controls.setSpeed(v)
                    }
                  }}
                />
              </div>
            </>
          )}
        </div>
        {source === 'replay' && (
          <div className="progress-line" style={{ marginTop: 10 }}>
            <div style={{ width: `${progress * 100}%` }} />
          </div>
        )}
        {liveStatus === 'error' && <Callout kind="error">{liveError}</Callout>}
        {source === 'live' && (
          <Callout>
            Crypto trades different hours and spreads than XAU/USD — the expectancy book below was
            measured on {result?.snapshot.symbol ?? 'your dataset'} and does not transfer to this
            feed by default. This surface is for validating the pipeline, not the edge.
          </Callout>
        )}
      </Section>

      <Section title="Chart">
        <CandleChart candles={visible} theme={s.theme} height={340} />
      </Section>

      <Section
        title="Shadow signals"
        right={<span className="badge">NO ORDERS ARE EVER SENT</span>}
      >
        {!signals.length && (
          <span className="hint" style={{ color: 'var(--ghost)', fontSize: 12 }}>
            The engine watches each closed bar and emits WAIT / LONG / SHORT with the historical
            evidence attached. Signals appear here once the warm-up period (120 bars) has passed
            and a setup fires.
          </span>
        )}
        {latest && latest.best && (
          <Callout kind="ok">
            <b>{latest.best.action}</b> {latest.best.setup} @ {fmtNum(latest.best.entry, 2)} · stop{' '}
            {fmtNum(latest.best.stopLoss, 2)} · grade {latest.best.grade} —{' '}
            {latest.best.explanation}
          </Callout>
        )}
        <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>time</th><th>signal</th><th>setup</th><th>entry</th><th>stop</th>
                <th>exp (R)</th><th>n</th><th>grade</th>
              </tr>
            </thead>
            <tbody>
              {[...signals].reverse().slice(0, 60).map((sig) =>
                sig.recommendations.length ? (
                  sig.recommendations.slice(0, 1).map((r) => (
                    <tr key={sig.barIndex + r.id}>
                      <td>{formatDate(sig.time)}</td>
                      <td className={r.action === 'WAIT' ? '' : r.side === 'LONG' ? 'pos' : 'neg'}>
                        {r.action}
                      </td>
                      <td>{r.setup}</td>
                      <td>{fmtNum(r.entry, 2)}</td>
                      <td>{fmtNum(r.stopLoss, 2)}</td>
                      <td>{fmtNum(r.evidence.expectancyR, 3)}</td>
                      <td>{r.evidence.sampleSize}</td>
                      <td>
                        <Badge kind={r.grade === 'A' || r.grade === 'B' ? 'good' : r.grade === 'INSUFFICIENT' ? 'bad' : 'warn'}>
                          {r.grade}
                        </Badge>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr key={sig.barIndex}>
                    <td>{formatDate(sig.time)}</td>
                    <td colSpan={7} style={{ color: 'var(--ghost)' }}>WAIT — no setup</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
        {decay && decay.status !== 'UNKNOWN' && (
          <Callout kind={decay.status === 'HOLDING' ? 'ok' : 'warn'}>
            <b>Edge status: {decay.status}.</b> {decay.message}
          </Callout>
        )}
      </Section>
    </>
  )
}
