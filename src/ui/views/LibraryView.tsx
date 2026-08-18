import React, { useMemo } from 'react'
import { useLab } from '../../state/store'
import { STR } from '../strings'
import { Badge, Callout, Section, Tip, downloadText, fmtNum } from '../components/bits'
import type { LibraryEntry } from '../../storage/storageAdapter'

/**
 * LIBRARY — proven specs with their evidence. The scatter (expectancy vs max
 * drawdown) makes the trade-off visible: up and to the left is where you want
 * to live, and anything without evidence is a grey draft, not a result.
 */

export function LibraryView(): React.ReactElement {
  const s = useLab()
  const entries = s.library

  return (
    <>
      <Section title={STR.libraryTitle}>
        <p className="muted">{STR.libraryIntro}</p>
        {entries.length === 0 && <Callout>{STR.libraryEmpty}</Callout>}
        {entries.length > 0 && <Scatter entries={entries} />}
      </Section>

      {entries.length > 0 && (
        <Section title="SPECS">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Verdict</th>
                  <th>Grade</th>
                  <th>
                    <Tip text="Expectancy in R over the proving dataset, with the trials penalty already reported alongside.">
                      Expectancy (R)
                    </Tip>
                  </th>
                  <th>Trades</th>
                  <th>Max DD %</th>
                  <th>
                    <Tip text={STR.proverTrialsHelp}>Trials</Tip>
                  </th>
                  <th>Saved</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <Row key={e.id} entry={e} />
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </>
  )
}

function Row({ entry }: { entry: LibraryEntry }): React.ReactElement {
  const s = useLab()
  const ev = entry.evidence
  return (
    <tr>
      <td>
        <b>{entry.spec.name}</b>
        <div className="muted small">{entry.spec.market} · {entry.spec.timeframe}</div>
      </td>
      <td>
        {ev ? (
          <Badge kind={ev.verdict === 'PROVEN' ? 'good' : ev.verdict === 'NOT_PROVEN' ? 'bad' : 'warn'}>
            {ev.verdict}
          </Badge>
        ) : (
          <Badge>{STR.libraryNoEvidence}</Badge>
        )}
      </td>
      <td>{ev?.grade ?? '—'}</td>
      <td className={ev && ev.baseline.expectancyR > 0 ? 'pos' : 'neg'}>
        {ev ? fmtNum(ev.baseline.expectancyR, 3) : '—'}
      </td>
      <td>{ev?.baseline.trades ?? '—'}</td>
      <td>{ev ? fmtNum(ev.baseline.maxDrawdownPct, 1) : '—'}</td>
      <td>{ev?.guards.trials.toLocaleString() ?? '—'}</td>
      <td className="muted small">{new Date(entry.savedAt).toISOString().slice(0, 10)}</td>
      <td>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn small" onClick={() => { s.useSpec(entry.spec); s.setView('LAB') }}>
            {STR.libraryLoad}
          </button>
          <button
            className="btn small"
            onClick={() => downloadText(`${entry.spec.id}.json`, JSON.stringify({ spec: entry.spec, evidence: entry.evidence }, null, 2))}
          >
            {STR.specExport}
          </button>
          <button className="btn small danger" onClick={() => void s.removeFromLibrary(entry.id)}>
            {STR.libraryDelete}
          </button>
        </div>
      </td>
    </tr>
  )
}

/** SVG scatter: x = max drawdown %, y = expectancy R. No library needed. */
function Scatter({ entries }: { entries: LibraryEntry[] }): React.ReactElement {
  const pts = useMemo(
    () =>
      entries
        .filter((e) => e.evidence && e.evidence.baseline.trades > 0)
        .map((e) => ({
          x: e.evidence!.baseline.maxDrawdownPct,
          y: e.evidence!.baseline.expectancyR,
          proven: e.evidence!.verdict === 'PROVEN',
          name: e.spec.name,
        })),
    [entries],
  )
  if (!pts.length) return <></>

  const W = 560
  const H = 240
  const pad = 36
  const maxX = Math.max(10, ...pts.map((p) => p.x)) * 1.15
  const ys = pts.map((p) => p.y)
  const minY = Math.min(0, ...ys) * 1.15
  const maxY = Math.max(0.1, ...ys) * 1.15
  const sx = (x: number): number => pad + (x / maxX) * (W - pad * 2)
  const sy = (y: number): number => H - pad - ((y - minY) / (maxY - minY)) * (H - pad * 2)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="scatter" role="img" aria-label="Library scatter">
      <line x1={pad} y1={sy(0)} x2={W - pad} y2={sy(0)} className="axis" />
      <line x1={pad} y1={pad / 2} x2={pad} y2={H - pad} className="axis" />
      <text x={W - pad} y={H - 8} textAnchor="end" className="axis-label">
        {STR.libraryScatterX} →
      </text>
      <text x={10} y={pad / 2 + 4} className="axis-label">
        {STR.libraryScatterY} ↑
      </text>
      {pts.map((p, i) => (
        <g key={i}>
          <circle
            cx={sx(p.x)}
            cy={sy(p.y)}
            r={5}
            className={p.proven ? 'pt proven' : 'pt'}
          />
          <text x={sx(p.x) + 8} y={sy(p.y) + 4} className="pt-label">
            {p.name.length > 24 ? p.name.slice(0, 24) + '…' : p.name}
          </text>
        </g>
      ))}
    </svg>
  )
}
