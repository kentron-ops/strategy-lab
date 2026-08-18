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

export interface MetricProps {
  label: string
  value: string
  tone?: 'pos' | 'neg' | 'warn' | 'plain'
  sub?: string
  help: string
  math?: MathInfo
  stale?: boolean
  inadequate?: boolean
}

export function Metric({ label, value, tone = 'plain', sub, help, math, stale, inadequate }: MetricProps): React.ReactElement {
  const toneClass = inadequate ? '' : tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : tone === 'warn' ? 'warn-text' : ''
  return (
    <div className={`metric${stale ? ' stale' : ''}${inadequate ? ' inadequate' : ''}`}>
      <div className="label">
        <Tip text={help}>{label}</Tip>
        {math ? <ShowMath math={math} /> : null}
      </div>
      <div className={`value fresh ${toneClass}`} key={value}>
        {value}
      </div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  )
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
