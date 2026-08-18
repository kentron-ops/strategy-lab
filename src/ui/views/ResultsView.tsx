import React, { useMemo } from 'react'
import { useLab } from '../../state/store'
import { Badge, Callout, Metric, Section, fmtMoney, fmtNum, fmtPct, toneOf } from '../components/bits'
import { sliceBy, buyAndHoldBenchmark } from '../../core/backtest/metrics'
import { regimeKey } from '../../core/types'
import { utcDayOfWeek, DAY_NAMES } from '../../core/util/time'
import { summariseMonteCarlo } from '../../core/optimization/monteCarlo'

/**
 * RESULTS — slices, benchmarks, out-of-sample, Monte Carlo.
 * Where the edge lives, where it dies, and how much of it was the order the
 * trades happened to arrive in.
 */

export function ResultsView(): React.ReactElement {
  const s = useLab()
  const result = s.result

  const slices = useMemo(() => {
    if (!result) return null
    const trades = result.trades.filter((t) => !t.excluded)
    return {
      session: sliceBy(trades, (t) => t.session),
      regime: sliceBy(trades, (t) => regimeKey(t.regime)),
      dow: sliceBy(trades, (t) => String(utcDayOfWeek(t.entryTime)), (k) => DAY_NAMES[Number(k)] ?? k),
      exit: sliceBy(trades, (t) => t.exitReason),
    }
  }, [result])

  const benchmark = useMemo(() => {
    const ds = s.activeDataset()
    if (!ds || !result) return null
    return buyAndHoldBenchmark(ds.candles, result.metrics.startingEquity)
  }, [result, s])

  if (!result) return <Callout>Run a backtest in LAB first.</Callout>
  const m = result.metrics

  return (
    <>
      <Section title="Against doing nothing">
        <div className="metric-grid">
          <Metric label="Strategy" value={fmtMoney(m.netPnl)} tone={toneOf(m.netPnl)}
            sub={fmtPct(m.returnPct)}
            help="Net result of the strategy, after costs."
            math={{
              formula: 'netPnl = Σ trade.netPnl = Σ (grossPnl − costs) · returnPct = netPnl ÷ startingEquity × 100',
              inputs: {
                trades: m.trades,
                'Σ grossPnl': fmtMoney(m.grossPnl),
                'Σ costs': fmtMoney(m.totalCosts),
                startingEquity: fmtMoney(m.startingEquity),
                endingEquity: fmtMoney(m.endingEquity),
              },
            }} />
          {benchmark && (
            <Metric label="Buy & hold" value={fmtMoney(benchmark.netPnl)} tone={toneOf(benchmark.netPnl)}
              sub={fmtPct(benchmark.returnPct)}
              help={benchmark.note} />
          )}
          {benchmark && (
            <Metric
              label="Verdict"
              value={m.netPnl > benchmark.netPnl ? 'above drift' : 'below drift'}
              tone={m.netPnl > benchmark.netPnl ? 'pos' : 'warn'}
              help="A strategy that underperforms simply holding the instrument is paying costs for the privilege of underperforming. This comparison is what separates edge from market drift."
            />
          )}
        </div>
      </Section>

      {slices && (
        <div className="grid cols-2">
          <SliceTable title="By session" rows={slices.session}
            note="Most edges are session-specific. Averaging a real London edge into a dead Asia one produces a mediocre everything." />
          <SliceTable title="By regime" rows={slices.regime}
            note="Volatility percentile × trend classification at entry. An edge that only exists in one regime needs that regime detected live before it is worth anything." />
          <SliceTable title="By day of week" rows={slices.dow}
            note="Beware: with 5 buckets and a modest sample, one of them will look special by chance alone." />
          <SliceTable title="By exit type" rows={slices.exit}
            note="How trades actually ended. A strategy whose profits come mostly from timeouts is not the strategy you thought you wrote." />
        </div>
      )}

      <Section
        title="Out-of-sample (70/30 chronological)"
        right={
          <button className="btn small" onClick={() => void s.runSplit()}>
            {s.split ? 're-run' : 'run'}
          </button>
        }
      >
        {!s.split && (
          <span className="hint" style={{ color: 'var(--ghost)', fontSize: 12 }}>
            Splits the data chronologically, never shuffled: parameters are judged on the last 30%
            they have never seen. The single cheapest honesty check available.
          </span>
        )}
        {s.split && (
          <>
            <div className="metric-grid">
              <Metric label="In-sample" value={`${fmtNum(s.split.inSample.expectancyR.point, 3)}R`}
                tone={toneOf(s.split.inSample.expectancyR.point)}
                sub={`${s.split.inSample.trades} trades`}
                help="Expectancy on the first 70% of the data." />
              <Metric label="Out-of-sample" value={`${fmtNum(s.split.outOfSample.expectancyR.point, 3)}R`}
                tone={toneOf(s.split.outOfSample.expectancyR.point)}
                sub={`${s.split.outOfSample.trades} trades`}
                help="Expectancy on the last 30% — data the parameters never saw. This is the number that matters."
                math={{
                  formula: 'expectancyR = mean(trade.r) where r = netPnl ÷ riskAmount · CI = t-interval, 95%',
                  inputs: {
                    n: s.split.outOfSample.trades,
                    mean: fmtNum(s.split.outOfSample.expectancyR.point, 4),
                    'CI low': fmtNum(s.split.outOfSample.expectancyR.low, 4),
                    'CI high': fmtNum(s.split.outOfSample.expectancyR.high, 4),
                  },
                }} />
              <Metric label="Retention" value={fmtPct(s.split.degradation * 100, 0)}
                tone={s.split.degradation >= 0.4 ? 'plain' : 'warn'}
                help="Out-of-sample ÷ in-sample. Some decay is normal. Below ~40% usually means the parameters memorised the past." />
            </div>
            <Callout kind={s.split.flags.includes('POSSIBLE_OVERFIT') ? 'error' : s.split.flags.length ? 'warn' : 'ok'}>
              {s.split.flags.map((f) => (
                <Badge key={f} kind="warn">{f}</Badge>
              ))}{' '}
              {s.split.verdict}
            </Callout>
          </>
        )}
      </Section>

      <Section
        title="Monte Carlo — the same trades, reshuffled"
        right={
          <button className="btn small" disabled={!result.trades.length} onClick={() => void s.runMonteCarlo()}>
            {s.monteCarlo ? 're-run' : 'run 2,000 paths'}
          </button>
        }
      >
        {!s.monteCarlo && (
          <span className="hint" style={{ color: 'var(--ghost)', fontSize: 12 }}>
            Resamples the trade sequence to show how much of the equity curve was the order the
            trades arrived in. Explicitly not a prediction of the future.
          </span>
        )}
        {s.monteCarlo && s.monteCarlo.runs > 0 && (
          <>
            <div className="metric-grid">
              <Metric label="Ending equity p5–p95"
                value={`${fmtMoney(s.monteCarlo.endingEquity.p5)} … ${fmtMoney(s.monteCarlo.endingEquity.p95)}`}
                help="90% of simulated paths ended inside this range. The realised outcome is one draw from this cloud." />
              <Metric label="Drawdown p95" value={fmtPct(s.monteCarlo.maxDrawdownPct.p95)}
                tone={s.monteCarlo.maxDrawdownPct.p95 > 30 ? 'warn' : 'plain'}
                help="1 in 20 reshuffles of these same trades saw a drawdown at least this deep. It was always possible; you just did not draw it." />
              <Metric label="P(ruin)" value={fmtPct(s.monteCarlo.probabilityOfRuin * 100)}
                tone={s.monteCarlo.probabilityOfRuin > 0.05 ? 'neg' : 'plain'}
                help="Fraction of paths that touched the ruin threshold at any point." />
              <Metric label="Losing streak p95" value={String(Math.round(s.monteCarlo.consecutiveLosses.p95))}
                help="Consecutive losses at the 95th percentile. Decide now how you will behave during it." />
              <Metric label="Your run's percentile" value={fmtPct(s.monteCarlo.actualPercentile * 100, 0)}
                help="Where the realised sequence sits inside the simulated distribution. Near the top = you got a lucky ordering; near the bottom = an unlucky one." />
            </div>
            <MonteCarloFan />
            <Callout>{summariseMonteCarlo(s.monteCarlo)}</Callout>
            <p style={{ fontSize: 11, color: 'var(--ghost)', fontFamily: 'var(--mono)' }}>
              {s.monteCarlo.disclaimer} seed {s.monteCarlo.seed} · {s.monteCarlo.mode}
            </p>
          </>
        )}
      </Section>

      <Section title="Provenance">
        <div className="table-wrap">
          <table className="data">
            <tbody>
              <tr><td>dataset</td><td>{result.snapshot.symbol} · {result.snapshot.timeframe} · hash {result.snapshot.datasetHash}</td></tr>
              <tr><td>engine</td><td>v{result.snapshot.engineVersion} · seed {result.snapshot.config.seed} · {result.durationMs}ms</td></tr>
              <tr><td>intrabar</td><td>{result.snapshot.config.intrabar} · {result.ambiguity.ambiguousTrades} ambiguous trades</td></tr>
              <tr><td>strategy</td><td>{result.snapshot.config.strategy.strategyId} v{result.snapshot.config.strategy.version} · {JSON.stringify(result.snapshot.config.strategy.params)}</td></tr>
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11, color: 'var(--ghost)', fontFamily: 'var(--mono)', marginBottom: 0 }}>
          Everything needed to reproduce this exact result. If a number cannot be reproduced, it is
          an anecdote.
        </p>
      </Section>
    </>
  )
}

function SliceTable({ title, rows, note }: { title: string; rows: ReturnType<typeof sliceBy>; note: string }): React.ReactElement {
  return (
    <Section title={title}>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>slice</th><th>n</th><th>win%</th><th>exp (R)</th><th>P&L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  {r.label}{' '}
                  {!r.adequate && <Badge kind="warn">thin</Badge>}
                </td>
                <td>{r.trades}</td>
                <td>{(r.winRate.point * 100).toFixed(0)}%</td>
                <td className={r.adequate ? (r.expectancyR.point > 0 ? 'pos' : r.expectancyR.point < 0 ? 'neg' : '') : ''}
                    style={r.adequate ? {} : { color: 'var(--ghost)' }}>
                  {r.expectancyR.point.toFixed(3)}
                </td>
                <td className={r.netPnl > 0 ? 'pos' : r.netPnl < 0 ? 'neg' : ''}>{fmtMoney(r.netPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11, color: 'var(--ghost)', marginBottom: 0 }}>{note}</p>
    </Section>
  )
}

/** The Monte Carlo fan as a plain SVG band chart. */
function MonteCarloFan(): React.ReactElement | null {
  const mc = useLab((s) => s.monteCarlo)
  if (!mc || !mc.fan.p50.length) return null

  const W = 900
  const H = 180
  const all = [...mc.fan.p5, ...mc.fan.p95]
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const span = hi - lo || 1
  const x = (i: number): number => (i / (mc.fan.p50.length - 1)) * W
  const y = (v: number): number => H - ((v - lo) / span) * (H - 8) - 4

  const band = (upper: number[], lower: number[]): string =>
    upper.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('') +
    lower.map((v, i) => `L${x(lower.length - 1 - i).toFixed(1)},${y(lower[lower.length - 1 - i]).toFixed(1)}`).join('') +
    'Z'

  const line = (vals: number[]): string =>
    vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')

  return (
    <div className="chart-box" style={{ marginTop: 10 }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }}>
        <path d={band(mc.fan.p95, mc.fan.p5)} fill="color-mix(in srgb, var(--accent) 10%, transparent)" />
        <path d={band(mc.fan.p75, mc.fan.p25)} fill="color-mix(in srgb, var(--accent) 18%, transparent)" />
        <path d={line(mc.fan.p50)} fill="none" stroke="var(--accent)" strokeWidth={1.2} />
        <text x={6} y={14} fill="var(--ghost)" fontSize={11} fontFamily="var(--mono)">{hi.toFixed(0)}</text>
        <text x={6} y={H - 6} fill="var(--ghost)" fontSize={11} fontFamily="var(--mono)">{lo.toFixed(0)}</text>
      </svg>
    </div>
  )
}
