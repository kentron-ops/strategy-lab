import React, { useMemo } from 'react'
import type { EquityPoint } from '../../core/types'

/**
 * Equity + drawdown, as a plain SVG. Thousands of points render fine as a
 * single path; WebGL is reserved for the surfaces that genuinely need it.
 */

export function EquityChart({
  curve,
  height = 220,
  startingEquity,
}: {
  curve: EquityPoint[]
  height?: number
  startingEquity: number
}): React.ReactElement {
  const W = 900
  const H = height
  const DD_H = 60

  const { equityPath, ddPath, min, max, maxDd } = useMemo(() => {
    if (curve.length < 2) return { equityPath: '', ddPath: '', min: 0, max: 1, maxDd: 0 }

    // Decimate to ~1200 points — visually identical, much cheaper.
    const stride = Math.max(1, Math.floor(curve.length / 1200))
    const pts: EquityPoint[] = []
    for (let i = 0; i < curve.length; i += stride) pts.push(curve[i])
    if (pts[pts.length - 1] !== curve[curve.length - 1]) pts.push(curve[curve.length - 1])

    let lo = Infinity
    let hi = -Infinity
    let dd = 0
    for (const p of pts) {
      if (p.equity < lo) lo = p.equity
      if (p.equity > hi) hi = p.equity
      if (p.drawdownPct > dd) dd = p.drawdownPct
    }
    if (hi === lo) hi = lo + 1

    const x = (i: number): number => (i / (pts.length - 1)) * W
    const y = (v: number): number => H - ((v - lo) / (hi - lo)) * (H - 8) - 4
    const yd = (v: number): number => (dd > 0 ? (v / dd) * (DD_H - 4) : 0)

    const eq = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join('')
    const ddP =
      `M0,0` +
      pts.map((p, i) => `L${x(i).toFixed(1)},${yd(p.drawdownPct).toFixed(1)}`).join('') +
      `L${W},0Z`

    return { equityPath: eq, ddPath: ddP, min: lo, max: hi, maxDd: dd }
  }, [curve, H])

  if (curve.length < 2) {
    return <div className="callout">No equity curve yet — nothing has been computed.</div>
  }

  const startY = H - ((startingEquity - min) / (max - min)) * (H - 8) - 4

  return (
    <div className="chart-box">
      <svg viewBox={`0 0 ${W} ${H + DD_H + 14}`} preserveAspectRatio="none" style={{ height: H + DD_H + 14 }}>
        {/* starting equity reference */}
        {startingEquity >= min && startingEquity <= max ? (
          <line x1={0} x2={W} y1={startY} y2={startY} stroke="var(--ghost)" strokeDasharray="3 5" strokeWidth={1} />
        ) : null}
        <path d={equityPath} fill="none" stroke="var(--accent)" strokeWidth={1.4} />
        <g transform={`translate(0, ${H + 14})`}>
          <path d={ddPath} fill="color-mix(in srgb, var(--neg) 30%, transparent)" stroke="none" />
        </g>
        <text x={6} y={14} fill="var(--ghost)" fontSize={11} fontFamily="var(--mono)">
          {max.toFixed(0)}
        </text>
        <text x={6} y={H - 4} fill="var(--ghost)" fontSize={11} fontFamily="var(--mono)">
          {min.toFixed(0)}
        </text>
        <text x={6} y={H + DD_H + 8} fill="var(--ghost)" fontSize={10} fontFamily="var(--mono)">
          drawdown ≤ {maxDd.toFixed(1)}%
        </text>
      </svg>
    </div>
  )
}
