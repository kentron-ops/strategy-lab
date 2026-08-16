import React, { useMemo, useState } from 'react'
import { getBacktestWorker, useLab } from '../../state/store'
import { listStrategies, getStrategy } from '../../core/strategy/registry'
import { Badge, Callout, Metric, Section, Tip, fmtMoney, fmtNum, fmtPct, toneOf, CiText } from '../components/bits'
import { EquityChart } from '../components/EquityChart'
import type { IntrabarPolicy, ParamSpec } from '../../core/types'
import { OBJECTIVES } from '../../core/optimization/scoring'
import { roundTripCostInPrice } from '../../core/execution/costModel'

/**
 * LAB — the live, connected surface (§8). Inputs on the left, results on the
 * right; touch anything and every dependent number goes stale, recomputes in
 * the worker, and lands back with a flash.
 */

export function LabView(): React.ReactElement {
  const s = useLab()
  const result = s.result
  const stale = s.recompute.dirty || s.recompute.running
  const strategy = getStrategy(s.strategyConfig.strategyId)
  const [saveName, setSaveName] = useState('')

  const m = result?.metrics ?? null
  const inadequate = m ? !m.sampleAdequate : false

  const rejectionRows = useMemo(() => {
    if (!result) return []
    return Object.entries(result.rejections)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
  }, [result])

  return (
    <div className="grid cols-2">
      <div>
        <Section title="Strategy">
          <div className="field">
            <label>Strategy</label>
            <select
              value={s.strategyConfig.strategyId}
              onChange={(e) => s.setStrategy(e.target.value)}
            >
              {listStrategies().map((st) => (
                <option key={st.id} value={st.id}>
                  {st.name}
                </option>
              ))}
            </select>
            <span className="hint">{strategy.description}</span>
          </div>

          {strategy.paramSpec.map((p) => (
            <ParamField key={p.key} spec={p} />
          ))}

          <div className="row" style={{ marginTop: 10 }}>
            <div className="field">
              <label>Save as</label>
              <input
                type="text"
                value={saveName}
                placeholder="config name"
                onChange={(e) => setSaveName(e.target.value)}
              />
            </div>
            <button
              className="btn"
              disabled={!saveName.trim()}
              onClick={() => {
                void s.saveCurrentConfig(saveName.trim())
                setSaveName('')
              }}
            >
              save
            </button>
            {s.savedConfigs.length > 0 && (
              <div className="field">
                <label>Load saved</label>
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) s.loadConfig(e.target.value)
                  }}
                >
                  <option value="">—</option>
                  {s.savedConfigs.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </Section>

        <Section title="Risk">
          <div className="row">
            <NumField label="Starting equity" value={s.risk.startingEquity} min={1} step={10}
              help="The account the simulation starts with."
              onChange={(v) => s.setRisk({ startingEquity: v })} />
            <NumField label="Risk % per trade" value={s.risk.riskPercent} min={0.05} max={25} step={0.25}
              help="Percent of current equity risked if the stop fills exactly. This is the number that decides survival."
              onChange={(v) => s.setRisk({ riskPercent: v })} />
          </div>
          <div className="row">
            <div className="field">
              <label><Tip text="How the position size is derived from the risk budget. Fractional Kelly is included for study and carries real variance — the warning is not decorative.">Sizing</Tip></label>
              <select
                value={s.risk.sizingMethod}
                onChange={(e) => s.setRisk({ sizingMethod: e.target.value as never })}
              >
                <option value="FIXED_FRACTIONAL">Fixed fractional</option>
                <option value="FIXED_CASH">Fixed cash</option>
                <option value="VOLATILITY_NORMALIZED">Volatility normalized</option>
                <option value="FRACTIONAL_KELLY">Fractional Kelly (high variance)</option>
              </select>
            </div>
            <NumField label="Equity floor %" value={s.risk.equityFloorPercent ?? 0} min={0} max={95} step={5}
              help="Kill switch: all trading stops if equity touches this % of start. 0 disables — not recommended."
              onChange={(v) => s.setRisk({ equityFloorPercent: v > 0 ? v : null })} />
            <NumField label="Max positions" value={s.risk.maxConcurrentPositions} min={1} max={10} step={1}
              help="Concurrent open positions. The hedge baseline needs 2."
              onChange={(v) => s.setRisk({ maxConcurrentPositions: Math.round(v) })} />
          </div>
          {s.risk.sizingMethod === 'FRACTIONAL_KELLY' && (
            <Callout>
              Kelly sizing amplifies both growth and drawdown, and it trusts the measured edge
              completely — including the part of it that is luck. The fraction applied is{' '}
              {s.risk.kellyFraction}. Expect violent equity swings.
            </Callout>
          )}
        </Section>

        <Section title="Costs & execution">
          <div className="row">
            <NumField label="Spread" value={s.costs.spread} min={0} step={0.05}
              help="Full spread in price units, paid across a round trip. Push it up and watch whether the edge survives — that experiment is the point of this input."
              onChange={(v) => s.setCosts({ spread: v })} />
            <NumField label="Slippage" value={s.costs.slippage} min={0} step={0.01}
              help="Adverse movement on stop-type fills, in price units. Limit-style exits do not slip; they simply may not fill."
              onChange={(v) => s.setCosts({ slippage: v })} />
            <NumField label="Commission / unit" value={s.costs.commissionPerUnit} min={0} step={0.01}
              help="Per unit of quantity, per side."
              onChange={(v) => s.setCosts({ commissionPerUnit: v })} />
          </div>
          <div className="field" style={{ marginTop: 6 }}>
            <label>
              <Tip text="When one bar touches both stop and target, OHLC data cannot say which came first. CONSERVATIVE books the loss, OPTIMISTIC the win, SKIP excludes the trade. The count of affected trades is always reported.">
                Intrabar ambiguity policy
              </Tip>
            </label>
            <select value={s.intrabar} onChange={(e) => s.setIntrabar(e.target.value as IntrabarPolicy)}>
              <option value="CONSERVATIVE">CONSERVATIVE — assume the stop hit first (default)</option>
              <option value="OPTIMISTIC">OPTIMISTIC — assume the target hit first</option>
              <option value="SKIP_AMBIGUOUS">SKIP — exclude contested trades entirely</option>
            </select>
          </div>
        </Section>
      </div>

      <div>
        <Section
          title="Results"
          right={
            <>
              {result && (
                <Badge kind={inadequate ? 'warn' : 'plain'}>
                  {result.snapshot.symbol} · {result.snapshot.timeframe} · {result.snapshot.bars.toLocaleString()} bars
                </Badge>
              )}
              <span className="badge">SIMULATION ONLY</span>
            </>
          }
        >
          {!result && <Callout>Waiting for the first computation…</Callout>}

          {result && inadequate && (
            <Callout>
              {m!.trades} trades — below {m!.sampleThreshold}, these numbers are{' '}
              <b>not statistically meaningful</b>. A beautiful curve on a handful of trades is a
              mirage, and this one is greyed accordingly.
            </Callout>
          )}

          {result && result.warnings.map((w, i) => (
            <Callout key={i}>{w}</Callout>
          ))}

          {result && m && (
            <>
              <div className="metric-grid">
                <Metric label="Net P&L" value={fmtMoney(m.netPnl)} tone={toneOf(m.netPnl)}
                  stale={stale} inadequate={inadequate}
                  sub={`${fmtPct(m.returnPct)} return`}
                  help="Ending equity minus starting equity, after every modelled cost. The headline everyone looks at first and should trust last." />
                <Metric label="Expectancy" value={`${fmtNum(m.expectancyR.point, 3)}R`}
                  tone={toneOf(m.expectancyR.point)} stale={stale} inadequate={inadequate}
                  sub={CiText({ ci: m.expectancyR })}
                  help="Average R per trade with its 95% confidence interval. If the interval spans zero, the data cannot distinguish this edge from no edge. Formula: mean(netPnl ÷ riskAmount)." />
                <Metric label="Win rate" value={fmtPct(m.winRate.point * 100, 0)}
                  stale={stale} inadequate={inadequate}
                  sub={CiText({ ci: m.winRate, pct: true })}
                  help="Wins ÷ trades, Wilson interval. Optimising this number directly is how people end up with huge stops and tiny targets — expectancy is the one to watch." />
                <Metric label="Profit factor" value={fmtNum(m.profitFactor)}
                  tone={m.profitFactor >= 1 ? 'pos' : 'neg'} stale={stale} inadequate={inadequate}
                  help="Gross profit ÷ gross loss. Above ~3 on a small sample, be suspicious rather than pleased." />
                <Metric label="Max drawdown" value={fmtPct(m.maxDrawdownPct)}
                  tone={m.maxDrawdownPct > 25 ? 'neg' : 'plain'} stale={stale} inadequate={inadequate}
                  sub={fmtMoney(m.maxDrawdown)}
                  help="Deepest peak-to-trough fall, including open-position drawdown. The number that decides whether you would actually have kept running the system." />
                <Metric label="Trades" value={String(m.trades)}
                  stale={stale} tone={inadequate ? 'warn' : 'plain'}
                  sub={`${m.wins}W / ${m.losses}L`}
                  help="Sample size. Every probabilistic number on this screen is only as good as this one." />
                <Metric label="Avg win / loss" value={`${fmtMoney(m.avgWin)} / ${fmtMoney(m.avgLoss)}`}
                  stale={stale} inadequate={inadequate}
                  help="Averages across winning and losing trades. Their ratio times win rate is the whole game." />
                <Metric label="Costs" value={fmtMoney(m.totalCosts)}
                  stale={stale}
                  sub={m.costPctOfGrossProfit > 0 ? `${fmtPct(m.costPctOfGrossProfit, 0)} of gross profit` : undefined}
                  help="Spread + slippage + commission + financing across all trades. Compare against net P&L: many 'edges' are smaller than this number." />
                <Metric label="Exposure" value={fmtPct(m.exposurePct, 0)}
                  stale={stale}
                  sub={`avg hold ${fmtNum(m.avgHoldingBars, 0)} bars`}
                  help="Share of bars with a position open." />
                <Metric label="MFE / MAE" value={`${fmtNum(m.avgMfeR)}R / ${fmtNum(m.avgMaeR)}R`}
                  stale={stale} inadequate={inadequate}
                  help="Average best and worst excursion per trade, in R. MFE far above the average winner means targets are leaving money on the table; MAE near 1 means stops sit in the noise." />
                <Metric label="Sharpe†" value={fmtNum(m.sharpe)}
                  stale={stale} inadequate={inadequate}
                  help={m.sharpeAssumption} />
                <Metric label="Worst streak" value={`${m.maxConsecutiveLosses} losses`}
                  stale={stale}
                  help="Longest run of consecutive losing trades. Rehearse this number emotionally before trading anything." />
              </div>

              <div style={{ marginTop: 14 }}>
                <EquityChart curve={result.equityCurve} startingEquity={m.startingEquity} />
              </div>

              {result.ambiguity.ambiguousTrades > 0 && (
                <Callout>
                  {result.ambiguity.ambiguousTrades} trade(s) were intrabar-ambiguous and resolved
                  by the <b>{result.ambiguity.policy}</b> policy
                  {result.ambiguity.skippedTrades > 0
                    ? `; ${result.ambiguity.skippedTrades} excluded from the totals`
                    : ''}
                  .
                </Callout>
              )}
            </>
          )}
        </Section>

        {result && (
          <Section title="Why trades were rejected">
            {rejectionRows.length === 0 ? (
              <span className="hint" style={{ color: 'var(--ghost)' }}>
                Nothing was rejected — every evaluated setup traded or no setups occurred.
              </span>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {rejectionRows.map(([code, count]) => (
                      <tr key={code}>
                        <td>{code}</td>
                        <td>{count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        )}

        {result && <SensitivityPanel />}
      </div>
    </div>
  )
}

function ParamField({ spec }: { spec: ParamSpec }): React.ReactElement {
  const s = useLab()
  const value = s.strategyConfig.params[spec.key]

  if (spec.kind === 'boolean') {
    return (
      <div className="field">
        <label>
          <Tip text={spec.help}>{spec.label}</Tip>
        </label>
        <select
          value={String(Boolean(value))}
          onChange={(e) => s.setParam(spec.key, e.target.value === 'true')}
        >
          <option value="true">yes</option>
          <option value="false">no</option>
        </select>
      </div>
    )
  }
  if (spec.kind === 'choice') {
    return (
      <div className="field">
        <label>
          <Tip text={spec.help}>{spec.label}</Tip>
        </label>
        <select value={String(value)} onChange={(e) => s.setParam(spec.key, e.target.value)}>
          {(spec.choices ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
    )
  }
  return (
    <NumField
      label={spec.label}
      help={spec.help}
      value={typeof value === 'number' ? value : 0}
      min={spec.min}
      max={spec.max}
      step={spec.step ?? 0.1}
      onChange={(v) => s.setParam(spec.key, v)}
    />
  )
}

function NumField({
  label, value, onChange, min, max, step = 1, help,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  help: string
}): React.ReactElement {
  return (
    <div className="field">
      <label>
        <Tip text={help}>{label}</Tip>
      </label>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(v)
        }}
      />
    </div>
  )
}

/**
 * Sensitivity — the honest antidote to random fiddling (§8). For each numeric
 * parameter: perturb ±10% and report the local gradient of the chosen output.
 * Runs on demand because it costs a dozen backtests.
 */
function SensitivityPanel(): React.ReactElement {
  const s = useLab()
  const [rows, setRows] = useState<{ key: string; down: number; up: number }[] | null>(null)
  const [running, setRunning] = useState(false)
  const [objective, setObjective] = useState<'expectancyR' | 'netPnl' | 'maxDrawdownPct'>('expectancyR')

  const run = async (): Promise<void> => {
    const dataset = s.activeDataset()
    if (!dataset) return
    setRunning(true)
    try {
      const worker = getBacktestWorker()
      const strategy = getStrategy(s.strategyConfig.strategyId)
      const numeric = strategy.paramSpec.filter(
        (p) => p.kind === 'number' && typeof s.strategyConfig.params[p.key] === 'number',
      )
      const base = s.backtestConfig()
      const read = (m: { expectancyR: { point: number }; netPnl: number; maxDrawdownPct: number }): number =>
        objective === 'expectancyR' ? m.expectancyR.point : objective === 'netPnl' ? m.netPnl : m.maxDrawdownPct

      const centre = await worker.run(dataset, base)
      const centreV = read(centre.metrics)

      const out: { key: string; down: number; up: number }[] = []
      for (const p of numeric) {
        const v = s.strategyConfig.params[p.key] as number
        const vals: number[] = []
        for (const mult of [0.9, 1.1]) {
          let x = v * mult
          if (p.step && p.step >= 1) x = Math.round(x)
          if (p.min !== undefined) x = Math.max(p.min, x)
          if (p.max !== undefined) x = Math.min(p.max, x)
          const cfg = {
            ...base,
            strategy: { ...base.strategy, params: { ...base.strategy.params, [p.key]: x } },
          }
          const r = await worker.run(dataset, cfg)
          vals.push(read(r.metrics) - centreV)
        }
        out.push({ key: p.key, down: vals[0], up: vals[1] })
      }
      out.sort((a, b) => Math.max(Math.abs(b.down), Math.abs(b.up)) - Math.max(Math.abs(a.down), Math.abs(a.up)))
      setRows(out)
    } finally {
      setRunning(false)
    }
  }

  return (
    <Section
      title="Sensitivity"
      right={
        <>
          <select
            value={objective}
            onChange={(e) => setObjective(e.target.value as never)}
            style={{ background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 4, fontFamily: 'var(--mono)', fontSize: 11, padding: '2px 6px' }}
          >
            {OBJECTIVES.filter((o) => ['expectancyR', 'netPnl', 'maxDrawdownPct'].includes(o.key)).map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
          <button className="btn small" disabled={running} onClick={() => void run()}>
            {running ? 'measuring…' : 'measure'}
          </button>
        </>
      }
    >
      {!rows && !running && (
        <span className="hint" style={{ color: 'var(--ghost)', fontSize: 12 }}>
          Perturbs each parameter ±10% and reports how much the chosen output moves. The knobs at
          the top drive the result; the ones near zero are noise — stop turning them.
        </span>
      )}
      {rows && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>parameter</th>
                <th>−10%</th>
                <th>+10%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.key}</td>
                  <td className={r.down > 0 ? 'pos' : r.down < 0 ? 'neg' : ''}>
                    {r.down >= 0 ? '+' : ''}{r.down.toFixed(3)}
                  </td>
                  <td className={r.up > 0 ? 'pos' : r.up < 0 ? 'neg' : ''}>
                    {r.up >= 0 ? '+' : ''}{r.up.toFixed(3)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
