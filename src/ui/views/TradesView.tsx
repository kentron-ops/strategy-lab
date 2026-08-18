import React, { useMemo, useState } from 'react'
import { useLab } from '../../state/store'
import { Badge, Callout, Section, fmtMoney, fmtNum } from '../components/bits'
import { CandleChart } from '../components/CandleChart'
import { formatDate, formatDuration } from '../../core/util/time'
import type { Trade } from '../../core/types'

/**
 * TRADES — the ledger plus the Event Path Explorer (§10): click a trade, see
 * its lifecycle on the chart with entry, stop, target, excursions, exit, and
 * the machine-readable reasons the engine took it.
 */

export function TradesView(): React.ReactElement {
  const s = useLab()
  const result = s.result
  const [selected, setSelected] = useState<Trade | null>(null)

  const dataset = s.activeDataset()

  const windowCandles = useMemo(() => {
    if (!dataset || !selected) return dataset?.candles.slice(-400) ?? []
    const pad = 60
    const from = Math.max(0, selected.entryBar - pad)
    const to = Math.min(dataset.candles.length - 1, selected.exitBar + pad)
    return dataset.candles.slice(from, to + 1)
  }, [dataset, selected])

  if (!result || !dataset) return <Callout>Run a backtest in LAB first.</Callout>

  const trades = result.trades

  return (
    <>
      <Section title={selected ? `Event path — ${selected.id}` : 'Chart'}>
        <CandleChart
          candles={windowCandles}
          trades={trades}
          selected={selected}
          theme={s.theme}
          height={380}
          onSelectTrade={setSelected}
        />
        {selected && <EventPath trade={selected} />}
      </Section>

      <Section title={`Trade ledger — ${trades.length} trades`} right={<span className="badge">SIMULATION ONLY</span>}>
        <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>#</th><th>side</th><th>entry</th><th>exit</th><th>held</th>
                <th>exit as</th><th>R</th><th>net</th><th>MFE/MAE</th><th></th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr
                  key={t.id}
                  className={selected?.id === t.id ? 'selected' : ''}
                  onClick={() => setSelected(t)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>{t.id.replace('tr_', '')}</td>
                  <td>{t.side === 'LONG' ? '▲ long' : '▼ short'}</td>
                  <td>{fmtNum(t.entryPrice, 2)}</td>
                  <td>{fmtNum(t.exitPrice, 2)}</td>
                  <td>{formatDuration(t.holdingMs)}</td>
                  <td>
                    {t.exitReason}
                    {t.ambiguous && <Badge kind="warn">amb</Badge>}
                    {t.excluded && <Badge kind="bad">excl</Badge>}
                  </td>
                  <td className={t.r > 0 ? 'pos' : t.r < 0 ? 'neg' : ''}>{fmtNum(t.r, 2)}</td>
                  <td className={t.netPnl > 0 ? 'pos' : t.netPnl < 0 ? 'neg' : ''}>{fmtMoney(t.netPnl)}</td>
                  <td>{fmtNum(t.mfeR, 1)} / {fmtNum(t.maeR, 1)}</td>
                  <td>{t.session}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  )
}

function EventPath({ trade }: { trade: Trade }): React.ReactElement {
  return (
    <div style={{ marginTop: 10 }}>
      <div className="table-wrap">
        <table className="data">
          <tbody>
            <tr>
              <td>entry</td>
              <td>{formatDate(trade.entryTime)} @ {trade.entryPrice.toFixed(2)} ({trade.side.toLowerCase()}, qty {trade.qty.toFixed(2)})</td>
            </tr>
            <tr>
              <td>levels</td>
              <td>
                stop {trade.stopLoss.toFixed(2)} · target {trade.takeProfit?.toFixed(2) ?? 'none'} · 1R = {trade.rDistance.toFixed(4)} ({fmtMoney(trade.riskAmount)} at risk)
              </td>
            </tr>
            <tr>
              <td>path</td>
              <td>
                best +{trade.mfeR.toFixed(2)}R · worst −{trade.maeR.toFixed(2)}R over {trade.barsHeld} bars
              </td>
            </tr>
            <tr>
              <td>exit</td>
              <td>
                {formatDate(trade.exitTime)} @ {trade.exitPrice.toFixed(2)} — {trade.exitReason}
                {trade.ambiguous ? ' (intrabar-ambiguous: this outcome was decided by policy, not data)' : ''}
              </td>
            </tr>
            <tr>
              <td>result</td>
              <td className={trade.netPnl >= 0 ? 'pos' : 'neg'}>
                {fmtMoney(trade.grossPnl)} gross − {fmtMoney(trade.costs)} costs = {fmtMoney(trade.netPnl)} ({trade.r.toFixed(2)}R)
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {trade.reasons.length > 0 && (
        <details className="reasons" style={{ marginTop: 8 }}>
          <summary>why the engine took this trade ({trade.reasons.length} reasons)</summary>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {trade.reasons.map((r, i) => (
              <li key={i}>
                <code style={{ fontSize: 11 }}>{r.code}</code> — {r.message}
                {r.data ? <span style={{ color: 'var(--ghost)' }}> {JSON.stringify(r.data)}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
