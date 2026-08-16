import React, { useMemo, useRef, useState } from 'react'
import { useJournal, useLab } from '../../state/store'
import { Badge, Callout, Metric, Section, Tip, fmtMoney, fmtNum, fmtPct, toneOf, downloadText, readFileAsText } from '../components/bits'
import { importJournalCsv, journalToCsv, makeEntry } from '../../core/journal/import'
import { enrichEntries, analyseJournal, suggestImprovements, compareToMechanical, DEFAULT_ENRICH } from '../../core/journal/analytics'
import { BEHAVIOR_TAG_INFO } from '../../core/journal/types'
import { formatDate } from '../../core/util/time'

/** JOURNAL — import, reconcile against market data, diagnose, and compare to the machine. */

export function JournalView(): React.ReactElement {
  const j = useJournal()
  const lab = useLab()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [importReport, setImportReport] = useState<string[]>([])
  const [showForm, setShowForm] = useState(false)

  const reference = lab.activeDataset()

  const enriched = useMemo(
    () =>
      enrichEntries(j.entries, {
        ...DEFAULT_ENRICH,
        reference,
        startingEquity: lab.risk.startingEquity,
      }),
    [j.entries, reference, lab.risk.startingEquity],
  )

  const analytics = useMemo(
    () => analyseJournal(enriched, lab.risk.startingEquity),
    [enriched, lab.risk.startingEquity],
  )

  const suggestions = useMemo(
    () => suggestImprovements(analytics, enriched),
    [analytics, enriched],
  )

  const gap = useMemo(() => {
    if (!lab.result || !analytics.metrics.trades) return null
    return compareToMechanical(analytics.metrics, lab.result.metrics)
  }, [lab.result, analytics])

  const onImport = async (file: File): Promise<void> => {
    const text = await readFileAsText(file)
    const r = importJournalCsv(text)
    if (r.entries.length) await j.add(r.entries)
    setImportReport([
      `${r.entries.length} trade(s) imported.`,
      ...r.errors,
      ...r.skipped.slice(0, 5).map((s) => `line ${s.line}: ${s.reason}`),
    ])
  }

  const m = analytics.metrics

  return (
    <>
      <Section
        title="Journal"
        right={
          <>
            <button className="btn small" onClick={() => fileRef.current?.click()}>import CSV</button>
            <button className="btn small" onClick={() => setShowForm(!showForm)}>
              {showForm ? 'close' : 'log a trade'}
            </button>
            {j.entries.length > 0 && (
              <button className="btn small" onClick={() => downloadText('journal.csv', journalToCsv(j.entries), 'text/csv')}>
                export
              </button>
            )}
          </>
        }
      >
        <input
          ref={fileRef} type="file" accept=".csv,.txt" style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onImport(f)
            e.target.value = ''
          }}
        />
        {importReport.map((line, i) => <Callout key={i}>{line}</Callout>)}
        {showForm && <QuickCapture onDone={() => setShowForm(false)} />}
        {!j.entries.length && !showForm && (
          <span className="hint" style={{ color: 'var(--ghost)', fontSize: 12 }}>
            Import a broker CSV (columns like: side, qty, entry time, entry price, exit time, exit
            price, stop loss, fees) or log trades by hand. Each one is checked against the loaded
            market data — a journal that only stores what you type is a diary, not a record.
          </span>
        )}
      </Section>

      {j.entries.length > 0 && (
        <>
          {analytics.warnings.map((w, i) => <Callout key={i}>{w}</Callout>)}

          <Section title="Your numbers" right={<span className="badge">measured like the backtester — same code</span>}>
            <div className="metric-grid">
              <Metric label="Net P&L" value={fmtMoney(m.netPnl)} tone={toneOf(m.netPnl)}
                sub={`${m.trades} trades`} inadequate={!m.sampleAdequate}
                help="Sum of every logged trade's net result." />
              <Metric label="Expectancy" value={`${fmtNum(m.expectancyR.point, 3)}R`}
                tone={toneOf(m.expectancyR.point)} inadequate={!m.sampleAdequate}
                sub={`n=${m.expectancyR.n}`}
                help="Average R per trade across trades that have a stop (and therefore a defined R)." />
              <Metric label="Win rate" value={fmtPct(m.winRate.point * 100, 0)}
                inadequate={!m.sampleAdequate}
                help="With its Wilson interval in the tooltip of the results view. Do not optimise this number." />
              <Metric label="Left on table" value={analytics.excursions.leftOnTableR !== null ? `${fmtNum(analytics.excursions.leftOnTableR)}R` : '—'}
                tone={analytics.excursions.leftOnTableR !== null && analytics.excursions.leftOnTableR > 0.4 ? 'warn' : 'plain'}
                help="Average R between where your winners were closed and the best price they actually reached (from market data). The cost of fear, measured." />
              <Metric
                label="Verified"
                value={`${analytics.reconciliation.verified}/${j.entries.length}`}
                tone={analytics.reconciliation.implausible > 0 ? 'neg' : 'pos'}
                sub={analytics.reconciliation.implausible > 0 ? `${analytics.reconciliation.implausible} implausible` : undefined}
                help="Trades whose logged prices were confirmed possible against the market's own OHLC record. This is what separates this journal from a diary."
              />
            </div>
          </Section>

          {gap && (
            <Section title="You vs the machine">
              <div className="metric-grid">
                <Metric label="You" value={`${fmtNum(gap.human.expectancyR, 3)}R`}
                  tone={toneOf(gap.human.expectancyR)}
                  sub={`${gap.human.trades} trades`}
                  help="Your realised expectancy from the journal." />
                <Metric label="The rules, run mechanically" value={`${fmtNum(gap.mechanical.expectancyR, 3)}R`}
                  tone={toneOf(gap.mechanical.expectancyR)}
                  sub={`${gap.mechanical.trades} trades`}
                  help="The current LAB strategy run by the backtester over the loaded dataset — same metrics code, no fear, no hope." />
                <Metric label="The gap" value={`${gap.gapR >= 0 ? '+' : ''}${fmtNum(gap.gapR, 3)}R / trade`}
                  tone={gap.gapR > 0.15 ? 'neg' : gap.gapR < -0.15 ? 'pos' : 'plain'}
                  help="Mechanical minus human. Positive means the rules beat the person — the most common finding, and the most useful one." />
              </div>
              <Callout>{gap.verdict}</Callout>
            </Section>
          )}

          {suggestions.length > 0 && (
            <Section title="What your own numbers suggest">
              {suggestions.map((sg, i) => (
                <div key={i} className="callout" style={{ borderLeftColor: sg.confidence === 'HIGH' ? 'var(--accent)' : 'var(--warn)' }}>
                  <b style={{ color: 'var(--text)' }}>{sg.title}</b>{' '}
                  <Badge kind={sg.confidence === 'HIGH' ? 'good' : 'warn'}>{sg.confidence} · n={sg.sampleSize}</Badge>
                  <div style={{ marginTop: 4 }}>{sg.detail}</div>
                  <div style={{ marginTop: 4, fontFamily: 'var(--mono)', fontSize: 11 }}>{sg.expectedEffect}</div>
                </div>
              ))}
            </Section>
          )}

          {analytics.behaviorCosts.length > 0 && (
            <Section title="Behavioural leaks, priced">
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>behaviour</th><th>trades</th><th>avg R</th><th>baseline R</th><th>cost (ΔR)</th></tr>
                  </thead>
                  <tbody>
                    {analytics.behaviorCosts.map((b) => (
                      <tr key={b.tag}>
                        <td>
                          <Tip text={BEHAVIOR_TAG_INFO[b.tag].why}>{BEHAVIOR_TAG_INFO[b.tag].label}</Tip>
                        </td>
                        <td>{b.trades}</td>
                        <td className={b.avgR > 0 ? 'pos' : 'neg'}>{b.avgR.toFixed(2)}</td>
                        <td>{b.baselineAvgR.toFixed(2)}</td>
                        <td className={b.deltaR < 0 ? 'neg' : 'pos'}>{b.deltaR >= 0 ? '+' : ''}{b.deltaR.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          <Section title="Entries">
            <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>date</th><th>side</th><th>entry</th><th>exit</th><th>R</th><th>net</th>
                    <th>verified</th><th>tags</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {enriched.map((e) => (
                    <tr key={e.id}>
                      <td>{formatDate(e.entryTime)}</td>
                      <td>{e.side === 'LONG' ? '▲' : '▼'} {e.symbol}</td>
                      <td>{fmtNum(e.entryPrice, 2)}</td>
                      <td>{fmtNum(e.exitPrice, 2)}</td>
                      <td className={e.r !== null ? (e.r > 0 ? 'pos' : 'neg') : ''}>
                        {e.r !== null ? e.r.toFixed(2) : '—'}
                      </td>
                      <td className={e.netPnl > 0 ? 'pos' : e.netPnl < 0 ? 'neg' : ''}>{fmtMoney(e.netPnl)}</td>
                      <td>
                        {e.reconciliation ? (
                          <Badge kind={
                            e.reconciliation.verdict === 'VERIFIED' ? 'good'
                              : e.reconciliation.verdict === 'IMPLAUSIBLE' ? 'bad'
                              : 'warn'
                          }>
                            {e.reconciliation.verdict}
                          </Badge>
                        ) : <Badge>no data</Badge>}
                      </td>
                      <td>
                        {e.tags.slice(0, 3).map((t) => (
                          <Tip key={t} text={BEHAVIOR_TAG_INFO[t].why}>
                            <Badge kind="warn">{t.split('_')[0].toLowerCase()}</Badge>
                          </Tip>
                        ))}
                      </td>
                      <td>
                        <button className="btn small" onClick={() => void j.remove(e.id)}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
    </>
  )
}

function QuickCapture({ onDone }: { onDone: () => void }): React.ReactElement {
  const j = useJournal()
  const [form, setForm] = useState({
    symbol: 'XAUUSD', side: 'LONG' as 'LONG' | 'SHORT', qty: '1',
    entryTime: '', entryPrice: '', exitTime: '', exitPrice: '',
    stopLoss: '', fees: '0', setupTag: '',
  })

  const set = (k: string, v: string): void => setForm({ ...form, [k]: v })

  const submit = async (): Promise<void> => {
    const entryTime = Date.parse(form.entryTime)
    const exitTime = Date.parse(form.exitTime || form.entryTime)
    const entryPrice = Number(form.entryPrice)
    const exitPrice = Number(form.exitPrice)
    if (!Number.isFinite(entryTime) || !Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) return
    await j.add([
      makeEntry({
        symbol: form.symbol, side: form.side, qty: Number(form.qty) || 1,
        entryTime, entryPrice,
        exitTime: Number.isFinite(exitTime) ? exitTime : entryTime, exitPrice,
        stopLoss: form.stopLoss ? Number(form.stopLoss) : null,
        fees: Number(form.fees) || 0,
        setupTag: form.setupTag,
      }),
    ])
    onDone()
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div className="row">
        <div className="field"><label>Symbol</label>
          <input type="text" value={form.symbol} onChange={(e) => set('symbol', e.target.value)} /></div>
        <div className="field"><label>Side</label>
          <select value={form.side} onChange={(e) => set('side', e.target.value)}>
            <option value="LONG">long</option><option value="SHORT">short</option>
          </select></div>
        <div className="field"><label>Qty</label>
          <input type="number" value={form.qty} onChange={(e) => set('qty', e.target.value)} /></div>
        <div className="field"><label>Setup tag</label>
          <input type="text" value={form.setupTag} onChange={(e) => set('setupTag', e.target.value)} /></div>
      </div>
      <div className="row">
        <div className="field"><label>Entry time (UTC)</label>
          <input type="datetime-local" value={form.entryTime} onChange={(e) => set('entryTime', e.target.value)} /></div>
        <div className="field"><label>Entry price</label>
          <input type="number" step="0.01" value={form.entryPrice} onChange={(e) => set('entryPrice', e.target.value)} /></div>
        <div className="field"><label>Exit time (UTC)</label>
          <input type="datetime-local" value={form.exitTime} onChange={(e) => set('exitTime', e.target.value)} /></div>
        <div className="field"><label>Exit price</label>
          <input type="number" step="0.01" value={form.exitPrice} onChange={(e) => set('exitPrice', e.target.value)} /></div>
      </div>
      <div className="row">
        <div className="field"><label>Stop loss (needed for R)</label>
          <input type="number" step="0.01" value={form.stopLoss} onChange={(e) => set('stopLoss', e.target.value)} /></div>
        <div className="field"><label>Fees</label>
          <input type="number" step="0.01" value={form.fees} onChange={(e) => set('fees', e.target.value)} /></div>
        <button className="btn primary" onClick={() => void submit()}>log it</button>
      </div>
    </div>
  )
}
