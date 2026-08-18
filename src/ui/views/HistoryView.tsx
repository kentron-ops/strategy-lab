import React, { useMemo, useState } from 'react'
import { useLab } from '../../state/store'
import { Badge, Callout, Section, downloadText, fmtMoney, fmtNum, fmtPct } from '../components/bits'
import { formatDate } from '../../core/util/time'
import type { RunRecord } from '../../storage/storageAdapter'

/**
 * RUN HISTORY — the record of everything tested.
 *
 * Its purpose is not nostalgia. A strategy that looks good on its fortieth
 * variation is a different claim from one that looked good on its first, and
 * without a durable record there is no way to tell those apart a week later.
 * This is the same instinct as the trials counter in the Prover, kept where
 * the user can read it.
 */

type SortKey = 'ranAt' | 'expectancyR' | 'netPnl' | 'trades' | 'winRate'

export function HistoryView(): React.ReactElement {
  const s = useLab()
  const [sortKey, setSortKey] = useState<SortKey>('ranAt')
  const [onlyAdequate, setOnlyAdequate] = useState(false)
  const [query, setQuery] = useState('')

  const rows = useMemo(() => {
    let out = [...s.runs]
    if (onlyAdequate) out = out.filter((r) => r.sampleAdequate)
    const q = query.trim().toLowerCase()
    if (q) {
      out = out.filter(
        (r) =>
          r.strategyName.toLowerCase().includes(q) ||
          r.datasetSymbol.toLowerCase().includes(q),
      )
    }
    out.sort((a, b) => (sortKey === 'ranAt' ? b.ranAt - a.ranAt : b[sortKey] - a[sortKey]))
    return out
  }, [s.runs, sortKey, onlyAdequate, query])

  const best = useMemo(
    () => s.runs.filter((r) => r.sampleAdequate).sort((a, b) => b.expectancyR - a.expectancyR)[0],
    [s.runs],
  )

  if (!s.runs.length) {
    return (
      <Section title="RUN HISTORY">
        <Callout>
          Nothing recorded yet. Every backtest you run in LAB is saved here automatically —
          strategy, dataset, date and the headline metrics — so you can see what you have
          already tried instead of rediscovering it.
        </Callout>
      </Section>
    )
  }

  return (
    <>
      <Section
        title={`RUN HISTORY — ${s.runs.length} run${s.runs.length === 1 ? '' : 's'}`}
        right={
          <>
            <button
              className="btn small"
              onClick={() => downloadText('run-history.csv', runsToCsv(s.runs), 'text/csv')}
            >
              Export CSV
            </button>
            <button
              className="btn small danger"
              onClick={() => {
                if (confirm('Clear the entire run history? This cannot be undone.')) {
                  void s.clearRuns()
                }
              }}
            >
              Clear
            </button>
          </>
        }
      >
        <p className="muted">
          Every completed backtest, newest first. Identical consecutive runs are collapsed.
          This is the honest count of how much you have searched — the Prover penalises
          exactly this.
        </p>

        {best && (
          <Callout kind={best.expectancyR > 0 ? 'ok' : 'warn'}>
            <b>Best adequately-sampled run so far:</b> {best.strategyName} on{' '}
            {best.datasetSymbol} — {fmtNum(best.expectancyR, 3)}R over {best.trades} trades
            (CI {fmtNum(best.expectancyCiLow, 3)} … {fmtNum(best.expectancyCiHigh, 3)}).{' '}
            {best.expectancyCiLow > 0
              ? 'The interval clears zero on this dataset — take it to PROVER before believing it.'
              : 'The interval still spans zero, so this is not yet a measured edge.'}
          </Callout>
        )}

        <div className="row wrap" style={{ gap: 12, margin: '12px 0' }}>
          <label className="field" style={{ maxWidth: 220 }}>
            <span>Search</span>
            <input
              type="search"
              value={query}
              placeholder="strategy or symbol"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label className="field" style={{ maxWidth: 200 }}>
            <span>Sort by</span>
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              <option value="ranAt">most recent</option>
              <option value="expectancyR">expectancy</option>
              <option value="netPnl">net P&amp;L</option>
              <option value="trades">trades</option>
              <option value="winRate">win rate</option>
            </select>
          </label>
          <label className="check" style={{ alignSelf: 'flex-end', paddingBottom: 8 }}>
            <input
              type="checkbox"
              checked={onlyAdequate}
              onChange={(e) => setOnlyAdequate(e.target.checked)}
            />
            <span>only statistically meaningful samples</span>
          </label>
        </div>

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>when</th>
                <th>strategy</th>
                <th>dataset</th>
                <th>expectancy</th>
                <th>net</th>
                <th>win rate</th>
                <th>trades</th>
                <th>PF</th>
                <th>max DD</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="muted small">{formatDate(r.ranAt)}</td>
                  <td>
                    {r.strategyName}
                    {!r.sampleAdequate && (
                      <>
                        {' '}
                        <Badge kind="warn">thin</Badge>
                      </>
                    )}
                  </td>
                  <td className="muted small">
                    {r.datasetSymbol} · {r.datasetTimeframe}
                  </td>
                  <td className={r.expectancyR > 0 ? 'pos' : r.expectancyR < 0 ? 'neg' : ''}>
                    {fmtNum(r.expectancyR, 3)}R
                  </td>
                  <td className={r.netPnl > 0 ? 'pos' : r.netPnl < 0 ? 'neg' : ''}>
                    {fmtMoney(r.netPnl)}
                  </td>
                  <td>{fmtPct(r.winRate * 100, 0)}</td>
                  <td>{r.trades}</td>
                  <td>{fmtNum(r.profitFactor, 2)}</td>
                  <td>{fmtPct(r.maxDrawdownPct, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <Callout>No runs match that filter.</Callout>}
      </Section>
    </>
  )
}

function runsToCsv(runs: RunRecord[]): string {
  const header = [
    'ran_at', 'strategy', 'strategy_id', 'spec_id',
    'dataset', 'timeframe', 'dataset_hash',
    'expectancy_r', 'ci_low', 'ci_high',
    'net_pnl', 'return_pct', 'win_rate', 'trades',
    'profit_factor', 'max_drawdown_pct', 'sample_adequate',
    'ambiguous_trades', 'intrabar', 'duration_ms',
  ].join(',')
  const rows = runs.map((r) =>
    [
      new Date(r.ranAt).toISOString(), r.strategyName, r.strategyId, r.specId ?? '',
      r.datasetSymbol, r.datasetTimeframe, r.datasetHash,
      r.expectancyR, r.expectancyCiLow, r.expectancyCiHigh,
      r.netPnl, r.returnPct, r.winRate, r.trades,
      r.profitFactor, r.maxDrawdownPct, r.sampleAdequate ? 1 : 0,
      r.ambiguousTrades, r.intrabar, r.durationMs,
    ]
      .map((v) => (typeof v === 'string' && /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v)))
      .join(','),
  )
  return [header, ...rows].join('\n')
}
