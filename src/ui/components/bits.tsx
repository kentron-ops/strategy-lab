import React from 'react'
import type { ConfidenceInterval } from '../../core/types'

/** Shared UI primitives. Every metric explains itself; every state is explicit. */

export function Tip({ text, children }: { text: string; children: React.ReactNode }): React.ReactElement {
  return (
    <span className="tip" tabIndex={0}>
      {children}
      <span className="tipbox">{text}</span>
    </span>
  )
}

/**
 * show-the-math (V2 §6): every metric can reveal its formula and the exact
 * inputs it was computed from, so any number on screen can be recomputed by
 * hand from the exported ledger and must match.
 */
export interface MathInfo {
  formula: string
  inputs: Record<string, string | number>
}

export function ShowMath({ math }: { math: MathInfo }): React.ReactElement {
  return (
    <details className="show-math">
      <summary>show the math</summary>
      <div className="mono small">{math.formula}</div>
      <table className="math-inputs">
        <tbody>
          {Object.entries(math.inputs).map(([k, v]) => (
            <tr key={k}>
              <td className="muted">{k}</td>
              <td className="mono">{String(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted small">
        Recompute this from the exported ledger (TRADES → export) — it must match.
      </div>
    </details>
  )
}

/**
 * Reading pattern (V2 §9): every metric is a value plus a bad|ok|good range
 * bar with a position marker, a one-line caption, and (where probabilistic)
 * its confidence interval and sample size.
 *
 * `range` positions the marker in [0..1]. Provide it when a natural "how good
 * is this" scale exists (win-rate 0..1, profit factor 0..3, drawdown 0..50%…).
 * Skip it when the number has no such scale (raw money, holding times).
 */
export interface RangeSpec {
  /** Marker position 0..1, clamped. */
  position: number
  /** One-line reading of where the marker sits. */
  meaning: string
}

export interface MetricProps {
  label: string
  value: string
  tone?: 'pos' | 'neg' | 'warn' | 'plain'
  sub?: string
  help: string
  math?: MathInfo
  stale?: boolean
  inadequate?: boolean
  range?: RangeSpec
}

export function Metric({ label, value, tone = 'plain', sub, help, math, stale, inadequate, range }: MetricProps): React.ReactElement {
  const toneClass = inadequate ? '' : tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : tone === 'warn' ? 'warn-text' : ''
  const pos = range ? Math.min(1, Math.max(0, range.position)) : 0
  return (
    <div className={`metric${stale ? ' stale' : ''}${inadequate ? ' inadequate' : ''}`}>
      <div className="label">
        <Tip text={help}>{label}</Tip>
        {math ? <ShowMath math={math} /> : null}
      </div>
      <div className={`value fresh ${toneClass}`} key={value}>
        {value}
      </div>
      {range ? (
        <div className="reading">
          <div className="rangebar" role="img" aria-label={range.meaning}>
            <span className="marker" style={{ left: `${pos * 100}%` }} />
          </div>
          <div className="meaning">{range.meaning}</div>
        </div>
      ) : null}
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  )
}

/**
 * Small helpers to build a reading. Each turns a raw metric into a 0..1
 * marker position and a one-line caption. These are UI-only mappings —
 * they never change what the underlying metric computes.
 */
export const reading = {
  winRate(point: number, n: number): RangeSpec {
    // Coin flip = 50%, 60%+ = strong. Marker rescaled 0..1 across 30..70.
    const position = Math.min(1, Math.max(0, (point - 0.3) / 0.4))
    const meaning =
      n < 30
        ? 'sample too thin'
        : point < 0.35
          ? 'well below a coin flip'
          : point < 0.5
            ? 'below a coin flip'
            : point < 0.6
              ? 'roughly a coin flip'
              : 'above a coin flip'
    return { position, meaning }
  },
  profitFactor(pf: number): RangeSpec {
    // <1 loses money, 1..1.3 marginal, 1.3+ good.
    const position = Math.min(1, Math.max(0, (pf - 0.5) / 2))
    const meaning =
      !Number.isFinite(pf) || pf === 0
        ? 'no trades to judge'
        : pf < 1
          ? 'loses money — gross loss exceeds gross profit'
          : pf < 1.3
            ? 'marginal — costs eat most of it'
            : pf < 2
              ? 'solid ratio of profit to loss'
              : 'strong — but check the sample size'
    return { position, meaning }
  },
  expectancyR(r: number): RangeSpec {
    const position = Math.min(1, Math.max(0, (r + 0.5) / 1))
    const meaning =
      r < 0
        ? 'losing edge per trade'
        : r < 0.05
          ? 'barely positive after costs — verify with the Prover'
          : r < 0.2
            ? 'measurable edge per trade'
            : 'strong per-trade edge — sanity-check the sample'
    return { position, meaning }
  },
  maxDrawdownPct(pct: number): RangeSpec {
    // Lower is better. 0..50%. Reversed sense (right = worse).
    const position = Math.min(1, Math.max(0, pct / 50))
    const meaning =
      pct < 10
        ? 'shallow drawdown'
        : pct < 25
          ? 'normal drawdown for a risky rule'
          : pct < 40
            ? 'deep — would you sit through it?'
            : 'catastrophic — near ruin'
    return { position, meaning }
  },
  exposurePct(pct: number): RangeSpec {
    const position = Math.min(1, Math.max(0, pct / 100))
    const meaning =
      pct < 5
        ? 'barely in the market'
        : pct < 30
          ? 'selective exposure'
          : pct < 70
            ? 'often in the market'
            : 'almost always in the market'
    return { position, meaning }
  },
  trades(n: number): RangeSpec {
    // 0..500. 30+ = adequate sample.
    const position = Math.min(1, Math.max(0, n / 500))
    const meaning =
      n < 30
        ? 'below the statistical floor'
        : n < 100
          ? 'adequate but tight'
          : n < 300
            ? 'good sample'
            : 'large sample'
    return { position, meaning }
  },
  costsShare(pct: number): RangeSpec {
    // % of gross profit eaten by costs. Lower is better.
    const position = Math.min(1, Math.max(0, pct / 100))
    const meaning =
      pct < 10
        ? 'costs are negligible'
        : pct < 30
          ? 'costs are noticeable, edge holds'
          : pct < 60
            ? 'costs eat most of the profit'
            : 'costs dominate — edge is fragile'
    return { position, meaning }
  },
}

export function CiText({ ci, pct = false, digits = 3 }: { ci: ConfidenceInterval; pct?: boolean; digits?: number }): string {
  const f = (x: number): string => {
    if (!Number.isFinite(x)) return x > 0 ? '+∞' : '−∞'
    return pct ? `${(x * 100).toFixed(0)}%` : x.toFixed(digits)
  }
  return `${f(ci.low)} … ${f(ci.high)} · n=${ci.n}`
}

export function fmtMoney(x: number): string {
  if (!Number.isFinite(x)) return '—'
  const sign = x < 0 ? '−' : ''
  const abs = Math.abs(x)
  return `${sign}${abs >= 1000 ? abs.toLocaleString(undefined, { maximumFractionDigits: 0 }) : abs.toFixed(2)}`
}

export function fmtNum(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return x > 0 ? '∞' : '—'
  return x.toFixed(digits)
}

export function fmtPct(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return '—'
  return `${x.toFixed(digits)}%`
}

export function toneOf(x: number): 'pos' | 'neg' | 'plain' {
  if (!Number.isFinite(x) || x === 0) return 'plain'
  return x > 0 ? 'pos' : 'neg'
}

export function Callout({ kind = 'warn', children }: { kind?: 'warn' | 'error' | 'ok'; children: React.ReactNode }): React.ReactElement {
  return <div className={`callout ${kind === 'warn' ? '' : kind}`}>{children}</div>
}

export function Badge({ kind = 'plain', children }: { kind?: 'plain' | 'warn' | 'bad' | 'good'; children: React.ReactNode }): React.ReactElement {
  return <span className={`badge ${kind === 'plain' ? '' : kind}`}>{children}</span>
}

export function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="panel">
      <h2>
        {title}
        {right ? <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>{right}</span> : null}
      </h2>
      {children}
    </section>
  )
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('Could not read the file.'))
    r.readAsText(file)
  })
}
