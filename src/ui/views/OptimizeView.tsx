import React, { useMemo, useState } from 'react'
import { compute, useLab } from '../../state/store'
import { getStrategy } from '../../core/strategy/registry'
import { resolveStrategyConfig } from '../../core/spec/resolve'
import { Badge, Callout, Metric, Section, Tip, fmtNum, fmtPct } from '../components/bits'
import {
  buildHeatmap,
  defaultSweepFor,
  countCombinations,
  DEFAULT_MAX_COMBINATIONS,
  type SweepDimension,
} from '../../core/optimization/sweep'
import { OBJECTIVES, rankRows, objectiveValue, FLAG_HELP, type ObjectiveKey } from '../../core/optimization/scoring'
import type { WalkForwardResult } from '../../core/optimization/walkForward'
import type { RobustnessResult } from '../../core/optimization/robustness'

/** OPTIMIZE — sweep, heatmap, walk-forward, robustness. Overfitting protection is not optional. */

export function OptimizeView(): React.ReactElement {
  const s = useLab()
  const resolvedId = resolveStrategyConfig(s.strategyConfig).strategyId
  const strategy = getStrategy(resolvedId)
  const sweepable = strategy.paramSpec.filter((p) => p.sweep)

  const [selectedKeys, setSelectedKeys] = useState<string[]>(
    sweepable.slice(0, 2).map((p) => p.key),
  )
  const [objective, setObjective] = useState<ObjectiveKey>('expectancyR')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [wf, setWf] = useState<WalkForwardResult | null>(null)
  const [wfProgress, setWfProgress] = useState<{ done: number; total: number } | null>(null)
  const [robust, setRobust] = useState<RobustnessResult | null>(null)
  const [busy, setBusy] = useState(false)

  const dims: SweepDimension[] = useMemo(
    () => defaultSweepFor(resolvedId, selectedKeys),
    [resolvedId, selectedKeys],
  )
  const comboCount = countCombinations(dims)

  const runSweep = async (): Promise<void> => {
    const dataset = s.activeDataset()
    if (!dataset || !dims.length) return
    setBusy(true)
    setProgress({ done: 0, total: comboCount })
    try {
      const result = await compute.sweep(
        dataset,
        s.backtestConfig(),
        { dimensions: dims, maxCombinations: DEFAULT_MAX_COMBINATIONS },
        (p) => setProgress({ done: p.done, total: p.total }),
      )
      s.setSweepResult(result)
      // Every combination tried is a trial — the Prover's penalty depends on
      // this count being honest.
      s.addTrials(s.currentFamilyKey(), result.rows.length)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const runWalkForward = async (): Promise<void> => {
    const dataset = s.activeDataset()
    if (!dataset || !dims.length) return
    setBusy(true)
    setWfProgress({ done: 0, total: 1 })
    try {
      const bars = dataset.candles.length
      const trainBars = Math.floor(bars * 0.3)
      const testBars = Math.floor(bars * 0.12)
      const result = await compute.walkForward(
        dataset,
        s.backtestConfig(),
        { dimensions: dims, trainBars, testBars, objective, minTrainTrades: 5 },
        (done, total) => setWfProgress({ done, total }),
      )
      setWf(result)
    } finally {
      setBusy(false)
      setWfProgress(null)
    }
  }

  const runRobustness = async (): Promise<void> => {
    const dataset = s.activeDataset()
    if (!dataset) return
    setBusy(true)
    try {
      const result = await compute.robustness(dataset, s.backtestConfig(), {
        keys: selectedKeys,
        steps: [0.1, 0.25],
        objective,
      })
      setRobust(result)
    } finally {
      setBusy(false)
    }
  }

  const ranked = useMemo(
    () => (s.sweep ? rankRows(s.sweep.rows, objective).slice(0, 25) : []),
    [s.sweep, objective],
  )

  const heatmap = useMemo(() => {
    if (!s.sweep || selectedKeys.length < 2) return null
    return buildHeatmap(s.sweep.rows, selectedKeys[0], selectedKeys[1], (r) =>
      objectiveValue(r.metrics, objective),
    )
  }, [s.sweep, selectedKeys, objective])

  return (
    <>
      <Section title="Sweep setup">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 2 }}>
            <label>
              <Tip text="Which parameters to sweep, using the ranges each strategy declares for itself. Two selected parameters also feed the heatmap.">
                Parameters
              </Tip>
            </label>
            <div className="row">
              {sweepable.map((p) => (
                <label key={p.key} style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 12, fontFamily: 'var(--mono)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selectedKeys.includes(p.key)}
                    onChange={(e) =>
                      setSelectedKeys(
                        e.target.checked
                          ? [...selectedKeys, p.key]
                          : selectedKeys.filter((k) => k !== p.key),
                      )
                    }
                  />
                  {p.key}
                </label>
              ))}
            </div>
          </div>
          <div className="field">
            <label>
              <Tip text={OBJECTIVES.find((o) => o.key === objective)?.help ?? ''}>Rank by</Tip>
            </label>
            <select value={objective} onChange={(e) => setObjective(e.target.value as ObjectiveKey)}>
              {OBJECTIVES.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
          </div>
          <button className="btn primary" disabled={busy || !dims.length} onClick={() => void runSweep()}>
            sweep {comboCount.toLocaleString()} combos
          </button>
        </div>
        {progress && (
          <div style={{ marginTop: 10 }}>
            <div className="progress-line"><div style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
            <span className="hint" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ghost)' }}>
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
            </span>
          </div>
        )}
        {comboCount > DEFAULT_MAX_COMBINATIONS && (
          <Callout>
            {comboCount.toLocaleString()} combinations exceeds the cap of {DEFAULT_MAX_COMBINATIONS.toLocaleString()}.
            Only the first {DEFAULT_MAX_COMBINATIONS.toLocaleString()} will run — narrow the selection for full coverage.
          </Callout>
        )}
      </Section>

      {s.sweep && (
        <>
          {s.sweep.warnings.map((w, i) => <Callout key={i}>{w}</Callout>)}

          {heatmap && (
            <Section title={`Heatmap — ${heatmap.xKey} × ${heatmap.yKey} (${OBJECTIVES.find((o) => o.key === objective)?.label})`}>
              <HeatmapGrid hm={heatmap} />
              <p style={{ fontSize: 11, color: 'var(--ghost)', marginBottom: 0 }}>
                Look for broad plateaus, not the single brightest cell. The brightest cell is where
                overfitting lives.
              </p>
            </Section>
          )}

          <Section title="Top configurations">
            <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>params</th><th>trades</th><th>exp (R)</th><th>PF</th><th>maxDD%</th><th>score</th><th>flags</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((row) => (
                    <tr key={row.id}>
                      <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {Object.entries(row.params).map(([k, v]) => `${k}=${v}`).join(' ')}
                      </td>
                      <td>{row.metrics.trades}</td>
                      <td className={row.metrics.expectancyR.point > 0 ? 'pos' : 'neg'}>
                        {row.metrics.expectancyR.point.toFixed(3)}
                      </td>
                      <td>{fmtNum(row.metrics.profitFactor)}</td>
                      <td>{fmtPct(row.metrics.maxDrawdownPct)}</td>
                      <td>{fmtNum(objectiveValue(row.metrics, objective), 3)}</td>
                      <td>
                        {row.flags.map((f) => (
                          <Tip key={f} text={FLAG_HELP[f]}>
                            <Badge kind={f === 'MORE_ROBUST' ? 'good' : 'warn'}>{f}</Badge>
                          </Tip>
                        ))}
                      </td>
                      <td>
                        <button
                          className="btn small"
                          onClick={() => {
                            for (const [k, v] of Object.entries(row.params)) s.setParam(k, v)
                            s.setView('LAB')
                          }}
                        >
                          apply
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}

      <div className="grid cols-2">
        <Section
          title="Walk-forward"
          right={
            <button className="btn small" disabled={busy || !dims.length} onClick={() => void runWalkForward()}>
              {wf ? 're-run' : 'run'}
            </button>
          }
        >
          {wfProgress && (
            <div className="progress-line" style={{ marginBottom: 8 }}>
              <div style={{ width: `${(wfProgress.done / Math.max(1, wfProgress.total)) * 100}%` }} />
            </div>
          )}
          {!wf && !wfProgress && (
            <span className="hint" style={{ color: 'var(--ghost)', fontSize: 12 }}>
              Rolling re-optimisation: pick the best parameters on each training window, test them on
              the unseen window after it, repeat. Answers the only honest question — would I have had
              these parameters at the time?
            </span>
          )}
          {wf && (
            <>
              <div className="metric-grid">
                <Metric label="Forward expectancy" value={`${fmtNum(wf.aggregate.expectancyR, 3)}R`}
                  tone={wf.aggregate.expectancyR > 0 ? 'pos' : 'neg'}
                  sub={`${wf.aggregate.trades} OOS trades`}
                  help="Trade-weighted expectancy across all out-of-sample windows only. The single most honest performance number this app produces." />
                <Metric label="Consistency" value={fmtPct(wf.consistency * 100, 0)}
                  sub={`${wf.windows.length} windows`}
                  help="Fraction of forward windows that were profitable." />
                <Metric label="Efficiency" value={fmtPct(wf.efficiency * 100, 0)}
                  tone={wf.efficiency >= 0.4 ? 'plain' : 'warn'}
                  help="Forward expectancy ÷ training expectancy. How much of the in-sample promise survives being chosen in advance." />
              </div>
              <Callout kind={wf.flags.includes('POSSIBLE_OVERFIT') ? 'error' : 'ok'}>{wf.verdict}</Callout>
              {wf.warnings.map((w, i) => <Callout key={i}>{w}</Callout>)}
            </>
          )}
        </Section>

        <Section
          title="Robustness — the neighbourhood test"
          right={
            <button className="btn small" disabled={busy} onClick={() => void runRobustness()}>
              {robust ? 're-run' : 'run'}
            </button>
          }
        >
          {!robust && (
            <span className="hint" style={{ color: 'var(--ghost)', fontSize: 12 }}>
              Perturbs the current parameters ±10% and ±25%. A real effect is a plateau — nearby
              values also work. A fitted artefact is a spike.
            </span>
          )}
          {robust && (
            <>
              <div className="metric-grid">
                <Metric label="Centre score" value={fmtNum(robust.centre.score, 3)}
                  tone={robust.centre.score > 0 ? 'pos' : 'neg'}
                  sub={`${robust.centre.trades} trades`}
                  help="The current configuration's score on the chosen objective." />
                <Metric label="Neighbour retention" value={fmtPct(robust.retention * 100, 0)}
                  tone={robust.retention >= 0.7 ? 'pos' : robust.retention >= 0.35 ? 'plain' : 'neg'}
                  help="Mean neighbour score ÷ centre score, across every perturbation." />
                <Metric label="Dispersion" value={fmtNum(robust.dispersion)}
                  help="Spread of neighbour scores relative to their mean. Lower = steadier plateau." />
              </div>
              <Callout kind={robust.flags.includes('FRAGILE') ? 'error' : robust.flags.includes('MORE_ROBUST') ? 'ok' : 'warn'}>
                {robust.flags.map((f) => <Badge key={f} kind={f === 'MORE_ROBUST' ? 'good' : 'bad'}>{f}</Badge>)}{' '}
                {robust.verdict}
              </Callout>
            </>
          )}
        </Section>
      </div>
    </>
  )
}

function HeatmapGrid({ hm }: { hm: ReturnType<typeof buildHeatmap> }): React.ReactElement {
  const span = hm.max - hm.min || 1
  return (
    <div className="table-wrap">
      <table style={{ borderCollapse: 'separate', borderSpacing: 2, width: '100%' }}>
        <thead>
          <tr>
            <th style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ghost)', textAlign: 'left' }}>
              {hm.yKey} \ {hm.xKey}
            </th>
            {hm.xValues.map((x) => (
              <th key={String(x)} style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ghost)' }}>
                {String(x)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {hm.yValues.map((y, yi) => (
            <tr key={String(y)}>
              <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ghost)' }}>{String(y)}</td>
              {hm.xValues.map((x, xi) => {
                const v = hm.cells[yi][xi]
                if (v === null) return <td key={String(x)} className="heat-cell">·</td>
                const t = (v - hm.min) / span
                const bg =
                  v >= 0
                    ? `color-mix(in srgb, var(--pos) ${Math.round(t * 55)}%, var(--panel-2))`
                    : `color-mix(in srgb, var(--neg) ${Math.round((1 - t) * 55)}%, var(--panel-2))`
                return (
                  <td key={String(x)} className="heat-cell" style={{ background: bg }}>
                    {Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
