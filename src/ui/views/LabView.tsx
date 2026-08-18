import React, { useMemo, useState } from 'react'
import { compute, useLab } from '../../state/store'
import { resolveStrategyConfig } from '../../core/spec/resolve'
import { listStrategies, getStrategy } from '../../core/strategy/registry'
import {
  Badge,
  Callout,
  CiText,
  Metric,
  SliderNumber,
  Tip,
  fmtMoney,
  fmtNum,
  fmtPct,
  reading,
  toneOf,
} from '../components/bits'
import { defaultSweepFor } from '../../core/optimization/sweep'
import { rankRows } from '../../core/optimization/scoring'
import { EquityChart } from '../components/EquityChart'
import { CandleChart } from '../components/CandleChart'
import { SpecEditor } from '../components/SpecEditor'
import { STR } from '../strings'
import { useCollapsed } from '../hooks/useCollapsed'
import { PRESET_SPECS } from '../../core/spec/presets'
import type { StrategySpec } from '../../core/spec/types'
import type { IntrabarPolicy, ParamSpec } from '../../core/types'
import { OBJECTIVES } from '../../core/optimization/scoring'

/**
 * LAB — the Workbench (V2 §8).
 *
 * Three columns: inputs on the left (Strategy / Risk / Costs, collapsible),
 * chart + equity in the centre, live results on the right. No page scroll —
 * each column scrolls internally, so the shell always fits a 13" laptop.
 *
 * Every input from V1 is preserved by design (hard rule from the redesign
 * brief) — only their layout and grouping change here.
 */

export function LabView(): React.ReactElement {
  const s = useLab()
  const result = s.result
  const stale = s.recompute.dirty || s.recompute.running
  const strategy = getStrategy(resolveStrategyConfig(s.strategyConfig).strategyId)
  const activeSpec = s.strategyConfig.spec as StrategySpec | undefined
  const dataset = s.activeDataset()
  const [saveName, setSaveName] = useState('')

  // Collapsed state per input group persists across sessions.
  const [strategyOpen, setStrategyOpen] = useCollapsed('strategy', true)
  const [riskOpen, setRiskOpen] = useCollapsed('risk', true)
  const [costsOpen, setCostsOpen] = useCollapsed('costs', true)

  // Responsive: phone/tablet segmented pane; mid-width results drawer.
  const [pane, setPane] = useState<'inputs' | 'chart' | 'results'>('chart')
  const [drawerOpen, setDrawerOpen] = useState(false)

  const pickStrategy = (value: string): void => {
    if (value.startsWith('preset:')) {
      const p = PRESET_SPECS.find((x) => `preset:${x.id}` === value)
      if (p) s.useSpec(JSON.parse(JSON.stringify(p)) as StrategySpec)
      return
    }
    if (value.startsWith('lib:')) {
      const e = s.library.find((x) => `lib:${x.id}` === value)
      if (e) s.useSpec(e.spec)
      return
    }
    s.setStrategy(value)
  }
  const pickerValue = activeSpec
    ? s.library.some((e) => e.id === activeSpec.id)
      ? `lib:${activeSpec.id}`
      : PRESET_SPECS.some((p) => p.id === activeSpec.id)
        ? `preset:${activeSpec.id}`
        : 'custom'
    : s.strategyConfig.strategyId

  const m = result?.metrics ?? null
  const inadequate = m ? !m.sampleAdequate : false

  const rejectionRows = useMemo(() => {
    if (!result) return []
    return Object.entries(result.rejections)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
  }, [result])

  const headline = useMemo(() => {
    if (!m) return null
    if (m.trades === 0)
      return { kind: 'neutral' as const, head: 'No trades yet', body: 'The rules never fired on this data. Check the rejection breakdown below.' }
    if (inadequate)
      return {
        kind: 'neutral' as const,
        head: 'Not enough evidence',
        body: `${m.trades} trades sits under the ${m.sampleThreshold} floor. Every headline here should read as a hint, not a measurement.`,
      }
    const r = m.expectancyR
    if (r.high < 0)
      return {
        kind: 'neg' as const,
        head: 'Negative edge — this rule lost money on this data',
        body: `Expectancy is ${fmtNum(r.point, 3)}R and the whole confidence range (${fmtNum(r.low, 2)} to ${fmtNum(r.high, 2)}) sits below zero, so this is not noise: on ${result?.snapshot.symbol} ${result?.snapshot.timeframe} the rule is genuinely unprofitable. Widen the target toward the MFE winners actually reach, or restrict to a session where the edge was positive, then re-run.`,
      }
    if (r.low <= 0 && r.high >= 0)
      return {
        kind: 'neutral' as const,
        head: 'Indistinguishable from no edge',
        body: `Expectancy ${fmtNum(r.point, 3)}R with a 95% interval of ${fmtNum(r.low, 3)} to ${fmtNum(r.high, 3)}. It spans zero, so the sample cannot separate this from a coin flip. Prove it in PROVER or accumulate more data.`,
      }
    return {
      kind: 'pos' as const,
      head: 'Measured positive edge on this data',
      body: `Expectancy ${fmtNum(r.point, 3)}R, CI ${fmtNum(r.low, 3)} to ${fmtNum(r.high, 3)}. Still a statement about the past — send it to PROVER to see whether it survives out-of-sample and the trials penalty.`,
    }
  }, [m, inadequate, result])

  const summaryLine = headline
    ? `${headline.head}${m ? ` · ${fmtNum(m.expectancyR.point, 3)}R · ${m.trades} trades` : ''}`
    : 'computing…'

  return (
    <div className={`workbench pane-${pane}${drawerOpen ? ' drawer-open' : ''}`}>
      {/* Phone/tablet: segmented pane switcher + always-visible verdict line */}
      <div className="mobile-bar">
        <div className="segmented" role="tablist" aria-label="Workbench pane">
          {(['inputs', 'chart', 'results'] as const).map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={pane === p}
              className={pane === p ? 'active' : ''}
              onClick={() => setPane(p)}
            >
              {p === 'inputs' ? 'Inputs' : p === 'chart' ? 'Chart' : 'Results'}
            </button>
          ))}
        </div>
        <div
          className={`sticky-summary ${headline?.kind === 'pos' ? 'pos' : headline?.kind === 'neg' ? 'neg' : ''}`}
          onClick={() => setPane('results')}
        >
          {summaryLine}
        </div>
      </div>

      {/* Mid-width: results live in a drawer; this toggle floats at the edge */}
      <button
        className="drawer-toggle btn"
        onClick={() => setDrawerOpen(!drawerOpen)}
        aria-expanded={drawerOpen}
      >
        {drawerOpen ? 'CLOSE ✕' : '◂ RESULTS'}
      </button>

      {/* ── LEFT: strategy / risk / costs ────────────────────────────── */}
      <div className="col col-left">
        <div className="panel">
          <h2>Inputs <span className="right"><Badge>live · updates on every change</Badge></span></h2>

          <details
            className="subsection"
            open={strategyOpen}
            onToggle={(e) => setStrategyOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary>Strategy</summary>
            <div className="body">
              <div className="field">
                <label>Strategy</label>
                <select value={pickerValue} onChange={(e) => pickStrategy(e.target.value)}>
                  <optgroup label={STR.specPresets}>
                    {PRESET_SPECS.map((p) => (
                      <option key={p.id} value={`preset:${p.id}`}>
                        {p.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={STR.specBuiltins}>
                    {listStrategies().map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.name}
                      </option>
                    ))}
                  </optgroup>
                  {s.library.length > 0 && (
                    <optgroup label={STR.specSaved}>
                      {s.library.map((e) => (
                        <option key={e.id} value={`lib:${e.id}`}>
                          {e.spec.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {pickerValue === 'custom' && <option value="custom">custom spec (edited)</option>}
                </select>
                <span className="hint">{strategy.description}</span>
              </div>

              {activeSpec ? (
                <SpecEditor
                  key={activeSpec.id + String(activeSpec.meta.createdAt)}
                  spec={activeSpec}
                />
              ) : (
                <div className="param-list" style={{ marginTop: 8 }}>
                  {strategy.paramSpec.map((p) => (
                    <ParamField key={p.key} spec={p} />
                  ))}
                </div>
              )}

              <FindBest />

              <div className="row wrap" style={{ marginTop: 12, gap: 8 }}>
                <div className="field grow">
                  <label>Save current config as</label>
                  <input
                    type="text"
                    value={saveName}
                    placeholder="name"
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
                  Save
                </button>
              </div>
              {s.savedConfigs.length > 0 && (
                <div className="field" style={{ marginTop: 6 }}>
                  <label>Load a saved config</label>
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
          </details>

          <details
            className="subsection"
            open={riskOpen}
            onToggle={(e) => setRiskOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary>Risk</summary>
            <div className="body">
              <div className="grid-2">
                <NumField
                  label="Starting equity"
                  value={s.risk.startingEquity}
                  min={1}
                  step={10}
                  help="The account the simulation starts with."
                  onChange={(v) => s.setRisk({ startingEquity: v })}
                />
                <SliderNumber
                  label="Risk % per trade"
                  value={s.risk.riskPercent}
                  min={0.05}
                  max={25}
                  step={0.25}
                  help="Percent of current equity risked if the stop fills exactly. This is the number that decides survival."
                  onChange={(v) => s.setRisk({ riskPercent: v })}
                />
                <div className="field">
                  <label>
                    <Tip text="How the position size is derived from the risk budget. Fractional Kelly is included for study and carries real variance — the warning is not decorative.">
                      Sizing method
                    </Tip>
                  </label>
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
                <SliderNumber
                  label="Equity floor %"
                  value={s.risk.equityFloorPercent ?? 0}
                  min={0}
                  max={95}
                  step={5}
                  help="Kill switch: trading halts if equity touches this % of start. 0 disables — not recommended."
                  onChange={(v) => s.setRisk({ equityFloorPercent: v > 0 ? v : null })}
                />
                <SliderNumber
                  label="Max concurrent positions"
                  value={s.risk.maxConcurrentPositions}
                  min={1}
                  max={10}
                  step={1}
                  help="Concurrent open positions. The hedge baseline needs 2."
                  onChange={(v) => s.setRisk({ maxConcurrentPositions: Math.round(v) })}
                />
              </div>
              {s.risk.sizingMethod === 'FRACTIONAL_KELLY' && (
                <Callout>
                  Kelly sizing amplifies growth and drawdown, and it trusts the measured edge —
                  including the part that is luck. Fraction applied is {s.risk.kellyFraction}.
                </Callout>
              )}
            </div>
          </details>

          <details
            className="subsection"
            open={costsOpen}
            onToggle={(e) => setCostsOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary>Costs &amp; execution</summary>
            <div className="body">
              <div className="grid-2">
                <NumField
                  label="Spread"
                  value={s.costs.spread}
                  min={0}
                  step={0.05}
                  help="Full spread in price units, paid across a round trip. Push it up and watch whether the edge survives."
                  onChange={(v) => s.setCosts({ spread: v })}
                />
                <NumField
                  label="Slippage"
                  value={s.costs.slippage}
                  min={0}
                  step={0.01}
                  help="Adverse movement on stop-type fills, in price units. Limits do not slip; they simply may not fill."
                  onChange={(v) => s.setCosts({ slippage: v })}
                />
                <NumField
                  label="Commission / unit"
                  value={s.costs.commissionPerUnit}
                  min={0}
                  step={0.01}
                  help="Per unit of quantity, per side."
                  onChange={(v) => s.setCosts({ commissionPerUnit: v })}
                />
              </div>
              <div className="field" style={{ marginTop: 8 }}>
                <label>
                  <Tip text="When one bar touches both stop and target, OHLC alone cannot say which came first. CONSERVATIVE books the loss, OPTIMISTIC the win, SKIP excludes the trade. The count of affected trades is always reported.">
                    Intrabar ambiguity
                  </Tip>
                </label>
                <select
                  value={s.intrabar}
                  onChange={(e) => s.setIntrabar(e.target.value as IntrabarPolicy)}
                >
                  <option value="CONSERVATIVE">CONSERVATIVE — assume the stop hit first (default)</option>
                  <option value="OPTIMISTIC">OPTIMISTIC — assume the target hit first</option>
                  <option value="SKIP_AMBIGUOUS">SKIP — exclude contested trades</option>
                </select>
              </div>
            </div>
          </details>
        </div>
      </div>

      {/* ── CENTER: chart + equity ──────────────────────────────────── */}
      <div className="col col-center">
        <div className="panel">
          <h2>
            Chart
            <span className="right">
              {result && (
                <Badge>
                  {result.snapshot.symbol} · {result.snapshot.timeframe}
                </Badge>
              )}
            </span>
          </h2>
          <div className="chart-wrap">
            {dataset ? (
              <CandleChart
                candles={dataset.candles.slice(-500)}
                trades={result?.trades.filter((t) => t.entryBar >= dataset.candles.length - 500) ?? []}
                theme={s.theme}
              />
            ) : (
              <Callout>No dataset loaded.</Callout>
            )}
          </div>
        </div>

        <div className="panel">
          <h2>
            Equity
            {result && m && (
              <span className="right">
                <Badge kind={toneOf(m.netPnl) === 'pos' ? 'good' : toneOf(m.netPnl) === 'neg' ? 'bad' : 'plain'}>
                  {fmtMoney(m.startingEquity)} → {fmtMoney(m.endingEquity)} · net {fmtPct(m.returnPct, 1)}
                </Badge>
              </span>
            )}
          </h2>
          <div className="chart-wrap">
            {result ? (
              <EquityChart curve={result.equityCurve} startingEquity={m?.startingEquity ?? 0} />
            ) : (
              <Callout>Waiting for the first computation…</Callout>
            )}
          </div>
        </div>
      </div>

      {/* ── RIGHT: live results ─────────────────────────────────────── */}
      <div className="col col-right">
        <div className="panel">
          <h2>
            Results
            <span className="right">
              <Badge>live · updates on any change</Badge>
            </span>
          </h2>

          {headline && (
            <div className={`headline-callout ${headline.kind}`}>
              <div className="head">{headline.head}</div>
              <div style={{ fontSize: 12 }}>{headline.body}</div>
            </div>
          )}

          {result && m && (
            <>
              <div style={{ padding: '0 0 8px', color: 'var(--text-ghost)', fontSize: 11 }}>
                each tile: value · where it sits <span className="mono">bad|ok|good</span> · what it means
              </div>

              <ResultTile
                label="Expectancy (per trade)"
                value={`${fmtNum(m.expectancyR.point, 3)} R`}
                tone={toneOf(m.expectancyR.point)}
                stale={stale}
                inadequate={inadequate}
                help="Average R per trade with its 95% CI. If the interval spans zero, the data cannot distinguish this from no edge."
                range={reading.expectancyR(m.expectancyR.point)}
                meaningOverride={
                  m.expectancyR.high < 0
                    ? `95% CI ${fmtNum(m.expectancyR.low, 3)} to ${fmtNum(m.expectancyR.high, 3)} · n=${m.expectancyR.n}. The interval never crosses zero, so the losing edge is real, not a small sample.`
                    : m.expectancyR.low > 0
                      ? `95% CI ${fmtNum(m.expectancyR.low, 3)} to ${fmtNum(m.expectancyR.high, 3)} · n=${m.expectancyR.n}. The interval clears zero — evidence of a real edge.`
                      : `95% CI ${fmtNum(m.expectancyR.low, 3)} to ${fmtNum(m.expectancyR.high, 3)} · n=${m.expectancyR.n}. The interval spans zero — cannot distinguish from noise.`
                }
                math={{
                  formula: 'expectancyR = mean(netPnl ÷ riskAmount) · 95% CI via t-interval',
                  inputs: {
                    n: m.expectancyR.n,
                    mean: fmtNum(m.expectancyR.point, 4),
                    'CI low': fmtNum(m.expectancyR.low, 4),
                    'CI high': fmtNum(m.expectancyR.high, 4),
                  },
                }}
              />

              <div className="tiles">
                <ResultTile
                  label="Net P&L"
                  value={fmtMoney(m.netPnl)}
                  tone={toneOf(m.netPnl)}
                  stale={stale}
                  inadequate={inadequate}
                  help="Ending equity minus starting equity, after every modelled cost."
                  meaningOverride={`return ${fmtPct(m.returnPct, 1)}`}
                  math={{
                    formula: 'netPnl = Σ trade.netPnl · returnPct = netPnl ÷ startingEquity × 100',
                    inputs: {
                      trades: m.trades,
                      'Σ grossPnl': fmtMoney(m.grossPnl),
                      'Σ costs': fmtMoney(m.totalCosts),
                    },
                  }}
                />
                <ResultTile
                  label="Profit factor"
                  value={fmtNum(m.profitFactor)}
                  tone={m.profitFactor >= 1 ? 'pos' : 'neg'}
                  stale={stale}
                  inadequate={inadequate}
                  help="Gross profit ÷ gross loss. Above ~3 on a small sample, be suspicious rather than pleased."
                  range={reading.profitFactor(m.profitFactor)}
                />
                <ResultTile
                  label="Win rate"
                  value={fmtPct(m.winRate.point * 100, 0)}
                  stale={stale}
                  inadequate={inadequate}
                  help="Wins ÷ trades, Wilson interval. Optimising this directly is how people end up with huge stops and tiny targets — expectancy is the one to watch."
                  range={reading.winRate(m.winRate.point, m.winRate.n)}
                  meaningOverride={CiText({ ci: m.winRate, pct: true })}
                />
                <ResultTile
                  label="Max drawdown"
                  value={fmtPct(m.maxDrawdownPct)}
                  tone={m.maxDrawdownPct > 25 ? 'neg' : 'plain'}
                  stale={stale}
                  inadequate={inadequate}
                  help="Deepest peak-to-trough fall, including open-position drawdown. Decides whether you would actually keep running the system."
                  range={reading.maxDrawdownPct(m.maxDrawdownPct)}
                  meaningOverride={`peak-to-trough ${fmtMoney(m.maxDrawdown)}`}
                />
                <ResultTile
                  label="Trades"
                  value={String(m.trades)}
                  stale={stale}
                  tone={inadequate ? 'warn' : 'plain'}
                  help="Sample size. Every probabilistic number here is only as good as this one."
                  range={reading.trades(m.trades)}
                  meaningOverride={`${m.wins}W / ${m.losses}L`}
                />
                <ResultTile
                  label="Avg win / loss"
                  value={`${fmtMoney(m.avgWin)} / ${fmtMoney(m.avgLoss)}`}
                  stale={stale}
                  inadequate={inadequate}
                  help="Averages across winning and losing trades. Their ratio times win rate is the whole game."
                  meaningOverride={`ratio ${fmtNum(m.avgLoss !== 0 ? m.avgWin / -m.avgLoss : 0, 2)} · needs >${fmtNum((1 - m.winRate.point) / Math.max(0.0001, m.winRate.point), 1)}`}
                />
                <ResultTile
                  label="Costs"
                  value={fmtMoney(m.totalCosts)}
                  stale={stale}
                  tone={m.costPctOfGrossProfit > 50 ? 'warn' : 'plain'}
                  help="Spread + slippage + commission + financing across all trades. Many 'edges' are smaller than this number."
                  range={reading.costsShare(m.costPctOfGrossProfit)}
                  meaningOverride={
                    m.costPctOfGrossProfit > 0
                      ? `${fmtPct(m.costPctOfGrossProfit, 0)} of gross profit`
                      : 'no gross profit to consume'
                  }
                />
                <ResultTile
                  label="Exposure"
                  value={fmtPct(m.exposurePct, 0)}
                  stale={stale}
                  help="Share of bars with a position open."
                  range={reading.exposurePct(m.exposurePct)}
                  meaningOverride={`avg hold ${fmtNum(m.avgHoldingBars, 0)} bars`}
                />
                <ResultTile
                  label="MFE / MAE"
                  value={`${fmtNum(m.avgMfeR)} / ${fmtNum(m.avgMaeR)}`}
                  stale={stale}
                  inadequate={inadequate}
                  help="Average best and worst excursion per trade, in R. MFE far above the average winner means targets leave money on the table; MAE near 1 means stops sit in the noise."
                  meaningOverride="winners barely run → widen target"
                />
                <ResultTile
                  label="Worst streak"
                  value={`${m.maxConsecutiveLosses}`}
                  stale={stale}
                  tone={m.maxConsecutiveLosses > 8 ? 'warn' : 'plain'}
                  help="Longest run of consecutive losing trades. Rehearse this number emotionally before trading anything."
                  meaningOverride="consecutive losses"
                />
                <ResultTile
                  label="Sharpe†"
                  value={fmtNum(m.sharpe)}
                  stale={stale}
                  inadequate={inadequate}
                  help={m.sharpeAssumption}
                  meaningOverride="assumptions in tooltip"
                />
                <ResultTile
                  label="Recompute"
                  value={
                    s.recompute.running
                      ? `${(s.recompute.progress * 100).toFixed(0)}%`
                      : s.recompute.lastDurationMs !== null
                        ? `${s.recompute.lastDurationMs}ms`
                        : '—'
                  }
                  stale={false}
                  help="Latest backtest wall time, in the worker. Green = fresh; grey = stale while recomputing."
                  meaningOverride={
                    s.recompute.error
                      ? s.recompute.error
                      : s.recompute.dirty
                        ? 'inputs changed — recomputing'
                        : 'up to date'
                  }
                />
              </div>

              {result.ambiguity.ambiguousTrades > 0 && (
                <Callout>
                  {result.ambiguity.ambiguousTrades} trade(s) were intrabar-ambiguous and resolved
                  by <b>{result.ambiguity.policy}</b>
                  {result.ambiguity.skippedTrades > 0
                    ? `; ${result.ambiguity.skippedTrades} excluded from totals`
                    : ''}
                  .
                </Callout>
              )}
              {result.warnings.map((w, i) => (
                <Callout key={i}>{w}</Callout>
              ))}
            </>
          )}
        </div>

        {result && rejectionRows.length > 0 && (
          <div className="panel">
            <h2>Why trades were rejected</h2>
            <div className="table-wrap">
              <table>
                <tbody>
                  {rejectionRows.map(([code, count]) => (
                    <tr key={code}>
                      <td>{code}</td>
                      <td style={{ textAlign: 'right' }}>{count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {result && <SensitivityPanel />}
      </div>
    </div>
  )
}

/**
 * Result tile — Metric with the reading pattern, plus support for overriding
 * the auto-generated meaning line with something more specific to the metric
 * (like a confidence interval string).
 */
function ResultTile({
  label,
  value,
  tone = 'plain',
  stale,
  inadequate,
  help,
  math,
  range,
  meaningOverride,
}: {
  label: string
  value: string
  tone?: 'pos' | 'neg' | 'warn' | 'plain'
  stale?: boolean
  inadequate?: boolean
  help: string
  math?: import('../components/bits').MathInfo
  range?: import('../components/bits').RangeSpec
  meaningOverride?: string
}): React.ReactElement {
  const rangeWithMeaning = range && meaningOverride ? { ...range, meaning: meaningOverride } : range
  return (
    <Metric
      label={label}
      value={value}
      tone={tone}
      stale={stale}
      inadequate={inadequate}
      help={help}
      math={math}
      range={rangeWithMeaning}
      sub={!range && meaningOverride ? meaningOverride : undefined}
    />
  )
}

// ── param helpers (unchanged from V1, only their container class-names moved) ─

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
  // Numeric: metadata-driven. Slider only when the strategy declares BOTH
  // bounds — an unbounded slider would be an invented range.
  if (spec.min !== undefined && spec.max !== undefined) {
    return (
      <SliderNumber
        label={spec.label}
        help={spec.help}
        value={typeof value === 'number' ? value : spec.min}
        min={spec.min}
        max={spec.max}
        step={spec.step ?? 0.1}
        onChange={(v) => s.setParam(spec.key, v)}
      />
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
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  help,
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
 * FIND BEST — a bounded sweep on the REAL engine, scored by the stability
 * objective (CI lower bound × sample weight × drawdown penalty — risk-adjusted
 * EV that a thin sample cannot game), with the multiple-testing count reported
 * and added to the trials ledger that the Prover's penalty reads.
 *
 * It never invents numbers: every row is a full backtest, and the verdict
 * states plainly when NO setting turns the edge positive.
 */
function FindBest(): React.ReactElement {
  const s = useLab()
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [report, setReport] = useState<{
    tried: number
    applied: Record<string, number | string | boolean> | null
    expectancyR: number
    ciLow: number
    ciHigh: number
    trades: number
    verdict: 'POSITIVE' | 'NONE_POSITIVE' | 'THIN'
    keys: string[]
  } | null>(null)

  const run = async (): Promise<void> => {
    const dataset = s.activeDataset()
    if (!dataset) return
    setBusy(true)
    setReport(null)
    try {
      const resolvedId = resolveStrategyConfig(s.strategyConfig).strategyId
      // Bound the sweep: at most 3 sweepable dimensions, each thinned to ≤6
      // values, so FIND BEST stays interactive (≤216 backtests) instead of
      // silently launching thousands.
      const dims = defaultSweepFor(resolvedId)
        .slice(0, 3)
        .map((d) => ({
          key: d.key,
          values: thin(d.values, 6),
        }))
      if (!dims.length) {
        setBusy(false)
        return
      }
      const result = await compute.sweep(
        dataset,
        s.backtestConfig(),
        { dimensions: dims, maxCombinations: 400 },
        (p) => setProgress({ done: p.done, total: p.total }),
      )
      // Every combination evaluated is a trial the Prover must know about.
      s.addTrials(s.currentFamilyKey(), result.rows.length)

      const ranked = rankRows(result.rows, 'stability')
      const best = ranked[0]
      if (!best || best.metrics.trades === 0) {
        setReport({
          tried: result.rows.length,
          applied: null,
          expectancyR: 0,
          ciLow: 0,
          ciHigh: 0,
          trades: 0,
          verdict: 'NONE_POSITIVE',
          keys: dims.map((d) => d.key),
        })
        return
      }

      // Apply the winner to the live config — the sliders move to it and the
      // reactive graph recomputes from the same engine that scored it.
      for (const [k, v] of Object.entries(best.params)) s.setParam(k, v)

      const m = best.metrics
      setReport({
        tried: result.rows.length,
        applied: best.params,
        expectancyR: m.expectancyR.point,
        ciLow: m.expectancyR.low,
        ciHigh: m.expectancyR.high,
        trades: m.trades,
        verdict:
          m.trades < m.sampleThreshold ? 'THIN' : m.expectancyR.low > 0 ? 'POSITIVE' : 'NONE_POSITIVE',
        keys: dims.map((d) => d.key),
      })
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <div className="find-best">
      <button className="btn primary" disabled={busy} onClick={() => void run()}>
        {busy && progress
          ? `Sweeping ${progress.done}/${progress.total}…`
          : busy
            ? 'Sweeping…'
            : 'FIND BEST'}
      </button>
      <span className="hint">
        Bounded sweep on the real engine over up to 3 parameters, scored by
        risk-adjusted EV with a sample penalty. Every configuration tried is
        counted against you in the Prover.
      </span>
      {report && (
        <Callout
          kind={report.verdict === 'POSITIVE' ? 'ok' : report.verdict === 'THIN' ? 'warn' : 'error'}
        >
          <b>
            {report.verdict === 'POSITIVE'
              ? 'Best setting has a measured positive edge on this data'
              : report.verdict === 'THIN'
                ? 'Best setting found — but the sample is thin'
                : report.applied
                  ? 'No setting turns the edge positive'
                  : 'No configuration produced a single trade'}
          </b>
          {report.applied && (
            <div className="small" style={{ marginTop: 4 }}>
              Applied {Object.entries(report.applied).map(([k, v]) => `${k}=${v}`).join(' · ')} —
              expectancy {fmtNum(report.expectancyR, 3)}R (CI {fmtNum(report.ciLow, 3)} …{' '}
              {fmtNum(report.ciHigh, 3)}, n={report.trades}
              {report.verdict === 'THIN' ? ' — sample thin, treat as a hint' : ''}).
            </div>
          )}
          <div className="small muted" style={{ marginTop: 4 }}>
            {report.tried} configurations tried in this sweep (over {report.keys.join(', ')});
            total trials against this strategy now {s.currentTrials().toLocaleString()}. The more
            you search, the stronger a result must be before PROVER will believe it.
          </div>
        </Callout>
      )}
    </div>
  )
}

function thin(values: (number | string | boolean)[], maxCount: number): (number | string | boolean)[] {
  if (values.length <= maxCount) return values
  const stride = (values.length - 1) / (maxCount - 1)
  const out: (number | string | boolean)[] = []
  for (let i = 0; i < maxCount; i++) out.push(values[Math.round(i * stride)])
  return [...new Set(out)]
}

/**
 * Sensitivity — the antidote to random fiddling (§8). Runs a dozen extra
 * backtests to show which parameter actually moves the chosen output.
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
      const strategy = getStrategy(resolveStrategyConfig(s.strategyConfig).strategyId)
      const numeric = strategy.paramSpec.filter(
        (p) => p.kind === 'number' && typeof s.strategyConfig.params[p.key] === 'number',
      )
      const base = s.backtestConfig()
      const read = (m: { expectancyR: { point: number }; netPnl: number; maxDrawdownPct: number }): number =>
        objective === 'expectancyR' ? m.expectancyR.point : objective === 'netPnl' ? m.netPnl : m.maxDrawdownPct

      const centre = await compute.backtest(dataset, base)
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
          const r = await compute.backtest(dataset, cfg)
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
    <div className="panel">
      <h2>
        Sensitivity
        <span className="right">
          <select
            value={objective}
            onChange={(e) => setObjective(e.target.value as never)}
            style={{ width: 'auto' }}
          >
            {OBJECTIVES.filter((o) => ['expectancyR', 'netPnl', 'maxDrawdownPct'].includes(o.key)).map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          <button className="btn small" disabled={running} onClick={() => void run()}>
            {running ? 'measuring…' : 'measure'}
          </button>
        </span>
      </h2>
      {!rows && !running && (
        <span className="hint" style={{ color: 'var(--text-ghost)', fontSize: 12 }}>
          Perturbs each parameter ±10% and reports how much the chosen output moves. The knobs at
          the top drive the result; the ones near zero are noise — stop turning them.
        </span>
      )}
      {rows && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>parameter</th>
                <th style={{ textAlign: 'right' }}>−10%</th>
                <th style={{ textAlign: 'right' }}>+10%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.key}</td>
                  <td className={r.down > 0 ? 'pos' : r.down < 0 ? 'neg' : ''} style={{ textAlign: 'right' }}>
                    {r.down >= 0 ? '+' : ''}
                    {r.down.toFixed(3)}
                  </td>
                  <td className={r.up > 0 ? 'pos' : r.up < 0 ? 'neg' : ''} style={{ textAlign: 'right' }}>
                    {r.up >= 0 ? '+' : ''}
                    {r.up.toFixed(3)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
