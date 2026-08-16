import React, { useRef, useState } from 'react'
import { useLab } from '../../state/store'
import { Badge, Callout, Section, downloadText, readFileAsText } from '../components/bits'
import { parseCsv, toCsv, DEFAULT_CSV_OPTIONS } from '../../core/data/csvLoader'
import { resampleDataset } from '../../core/data/resample'
import { SAMPLE_DATASET_ID } from '../../core/data/sample'
import { storage } from '../../storage/storageAdapter'
import { formatDate } from '../../core/util/time'
import { TIMEFRAMES, type Timeframe } from '../../core/types'

/** DATA — import, validate, resample, export. The quality report is not optional reading. */

export function DataView(): React.ReactElement {
  const s = useLab()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [importSymbol, setImportSymbol] = useState('XAUUSD')
  const [utcOffset, setUtcOffset] = useState(0)
  const [report, setReport] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [busyMsg, setBusyMsg] = useState('')

  const active = s.activeDataset()

  const handleFile = async (file: File): Promise<void> => {
    setBusyMsg(`Parsing ${file.name}…`)
    try {
      const text = await readFileAsText(file)
      const r = parseCsv(text, {
        ...DEFAULT_CSV_OPTIONS,
        symbol: importSymbol.trim() || 'UNKNOWN',
        utcOffsetMinutes: utcOffset * 60,
        source: file.name,
      })
      const lines = [...r.errors]
      if (r.dataset) {
        await s.addDataset(r.dataset)
        lines.unshift(
          `Imported ${r.dataset.candles.length.toLocaleString()} bars as ${r.dataset.symbol} ${r.dataset.timeframe} (hash ${r.dataset.hash}).`,
        )
      }
      setReport(lines)
    } finally {
      setBusyMsg('')
    }
  }

  const resample = (target: Timeframe): void => {
    if (!active) return
    const out = resampleDataset(active, target)
    if (out.error) {
      setReport([out.error])
      return
    }
    if (out.dataset && out.dataset !== active) {
      void s.addDataset(out.dataset)
      setReport([`Resampled to ${target}: ${out.dataset.candles.length.toLocaleString()} bars.`])
    }
  }

  return (
    <>
      <Section title="Import CSV">
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const f = e.dataTransfer.files?.[0]
            if (f) void handleFile(f)
          }}
          onClick={() => fileRef.current?.click()}
          style={{
            border: `1px dashed ${dragOver ? 'var(--accent)' : 'var(--line)'}`,
            borderRadius: 6, padding: '26px 16px', textAlign: 'center',
            color: 'var(--sec)', cursor: 'pointer', marginBottom: 12,
            background: dragOver ? 'color-mix(in srgb, var(--accent) 6%, transparent)' : 'transparent',
          }}
        >
          {busyMsg || 'Drop a CSV here or click to choose. Expected columns: timestamp, open, high, low, close, volume (names are flexible; volume optional).'}
        </div>
        <input
          ref={fileRef} type="file" accept=".csv,.txt" style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleFile(f)
            e.target.value = ''
          }}
        />
        <div className="row">
          <div className="field">
            <label>Symbol label</label>
            <input type="text" value={importSymbol} onChange={(e) => setImportSymbol(e.target.value)} />
          </div>
          <div className="field">
            <label>File timezone (hours from UTC)</label>
            <input
              type="number" min={-12} max={14} step={1} value={utcOffset}
              onChange={(e) => setUtcOffset(Number(e.target.value) || 0)}
            />
            <span className="hint">
              For naive timestamps only. Getting this wrong shifts every session-based result — it
              is recorded on the dataset so results stay traceable.
            </span>
          </div>
        </div>
        {report.map((line, i) => <Callout key={i}>{line}</Callout>)}
      </Section>

      <Section title="Datasets">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>symbol</th><th>tf</th><th>bars</th><th>from</th><th>to</th>
                <th>quality</th><th>source</th><th></th>
              </tr>
            </thead>
            <tbody>
              {s.datasets.map((d) => {
                const errors = d.quality?.issues.filter((i) => i.severity === 'ERROR').length ?? 0
                const warns = d.quality?.issues.filter((i) => i.severity === 'WARNING').length ?? 0
                return (
                  <tr key={d.id} className={d.id === s.activeDatasetId ? 'selected' : ''}
                      style={{ cursor: 'pointer' }} onClick={() => s.setActiveDataset(d.id)}>
                    <td>
                      {d.symbol}{' '}
                      {d.id === SAMPLE_DATASET_ID && <Badge kind="warn">SYNTHETIC</Badge>}
                      {d.id === s.activeDatasetId && <Badge kind="good">active</Badge>}
                    </td>
                    <td>{d.timeframe}</td>
                    <td>{d.candles.length.toLocaleString()}</td>
                    <td>{formatDate(d.quality?.from ?? d.candles[0]?.t ?? 0)}</td>
                    <td>{formatDate(d.quality?.to ?? d.candles[d.candles.length - 1]?.t ?? 0)}</td>
                    <td>
                      {errors > 0 ? <Badge kind="bad">{errors} errors</Badge>
                        : warns > 0 ? <Badge kind="warn">{warns} warnings</Badge>
                        : <Badge kind="good">clean</Badge>}
                    </td>
                    <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.source}</td>
                    <td>
                      <button
                        className="btn small"
                        onClick={(e) => {
                          e.stopPropagation()
                          downloadText(`${d.symbol}-${d.timeframe}.csv`, toCsv(d.candles), 'text/csv')
                        }}
                      >
                        csv
                      </button>{' '}
                      {d.id !== SAMPLE_DATASET_ID && (
                        <button
                          className="btn small"
                          onClick={(e) => {
                            e.stopPropagation()
                            void s.removeDataset(d.id)
                          }}
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {active && (
        <Section title={`Quality report — ${active.symbol} ${active.timeframe}`}>
          {active.id === SAMPLE_DATASET_ID && (
            <Callout>
              This is the bundled <b>synthetic</b> dataset (seed-generated random walk with
              session-shaped volatility). It exists so the app works on first open. Any edge found
              on it is an artefact of the generator — use it to learn the tool, never to validate a
              strategy.
            </Callout>
          )}
          {!active.quality?.issues.length && <Callout kind="ok">No issues found.</Callout>}
          {active.quality?.issues.map((issue, i) => (
            <Callout key={i} kind={issue.severity === 'ERROR' ? 'error' : 'warn'}>
              <b>{issue.code}</b> ({issue.count}×) — {issue.message}
              {issue.indices.length > 0 && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                  {' '}bars {issue.indices.slice(0, 8).join(', ')}{issue.count > 8 ? '…' : ''}
                </span>
              )}
            </Callout>
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <span className="hint" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
              resample to:
            </span>
            {TIMEFRAMES.filter((tf) => tf !== active.timeframe).map((tf) => (
              <button key={tf} className="btn small" onClick={() => resample(tf)}>{tf}</button>
            ))}
          </div>
        </Section>
      )}

      <Section title="Backup — everything, as one file">
        <div className="row">
          <button
            className="btn"
            onClick={() => {
              void storage.exportAll().then((json) =>
                downloadText(`strategy-lab-backup-${new Date().toISOString().slice(0, 10)}.json`, json),
              )
            }}
          >
            export everything
          </button>
          <ImportAllButton onReport={(msg) => setReport([msg])} />
        </div>
        <p style={{ fontSize: 11, color: 'var(--ghost)', marginBottom: 0 }}>
          Datasets, strategy configs, journal and settings in one JSON file. Your data lives in this
          browser's storage and nowhere else — this file is how it moves between devices, and your
          only backup.
        </p>
      </Section>

      <Section title="Where to get free data">
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--sec)', lineHeight: 1.7 }}>
          <li><b>XAU/USD history:</b> Dukascopy's historical export (choose UTC, 5m or 1m, CSV) is the standard free source. Set the timezone field above to match what you exported.</li>
          <li><b>Crypto:</b> the REPLAY tab streams Binance's public feed live, no key. PAXGUSDT is a tokenised-gold proxy.</li>
          <li><b>XAU/FX polled:</b> a free TwelveData key allows delayed REST polling — honest for alerts, not for latency.</li>
          <li><b>TradingView:</b> has no public pull API; its alerts can only push to a webhook, which needs a relay server. Out of scope for the no-backend build, by design.</li>
        </ul>
      </Section>
    </>
  )
}

function ImportAllButton({ onReport }: { onReport: (msg: string) => void }): React.ReactElement {
  const ref = useRef<HTMLInputElement | null>(null)
  return (
    <>
      <input
        ref={ref} type="file" accept=".json" style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) {
            void readFileAsText(f).then(async (text) => {
              const r = await storage.importAll(text)
              onReport(r.message + (r.ok ? ' Reload the page to see everything.' : ''))
            })
          }
          e.target.value = ''
        }}
      />
      <button className="btn" onClick={() => ref.current?.click()}>import backup</button>
    </>
  )
}
