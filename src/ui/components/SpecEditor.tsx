import React, { useMemo, useState } from 'react'
import { useLab } from '../../state/store'
import { STR } from '../strings'
import { Badge, Callout, SliderNumber, downloadText, readFileAsText } from './bits'
import type {
  Comparator,
  Condition,
  FilterNode,
  Operand,
  StrategySpec,
  TargetSpec,
} from '../../core/spec/types'
import { SPEC_VERSION, operandLabel } from '../../core/spec/types'
import { validateSpec, specIsRunnable } from '../../core/spec/validate'
import type { Session } from '../../core/types'
import { SESSIONS } from '../../core/types'

/**
 * SpecEditor — the Strategy Compiler's UI (V2 §3). A rule builder, not a
 * visual programming language: typed rows in, StrategySpec JSON out. Every
 * edit re-validates; APPLY hands the spec to the reactive core.
 */

type OperandKind =
  | 'price'
  | 'ema'
  | 'sma'
  | 'rsi'
  | 'atr'
  | 'adx'
  | 'cci'
  | 'mfi'
  | 'rollingHigh'
  | 'rollingLow'
  | 'bbUpper'
  | 'bbMiddle'
  | 'bbLower'
  | 'atrPercentile'
  | 'rangeExpansion'
  | 'bodyRatio'
  | 'value'

const OPERAND_KINDS: { v: OperandKind; label: string; hasPeriod: boolean; hasValue: boolean }[] = [
  { v: 'price', label: 'close', hasPeriod: false, hasValue: false },
  { v: 'ema', label: 'EMA', hasPeriod: true, hasValue: false },
  { v: 'sma', label: 'SMA', hasPeriod: true, hasValue: false },
  { v: 'rsi', label: 'RSI', hasPeriod: true, hasValue: false },
  { v: 'atr', label: 'ATR', hasPeriod: true, hasValue: false },
  { v: 'adx', label: 'ADX', hasPeriod: true, hasValue: false },
  { v: 'cci', label: 'CCI', hasPeriod: true, hasValue: false },
  { v: 'mfi', label: 'MFI', hasPeriod: true, hasValue: false },
  { v: 'bbUpper', label: 'BB upper', hasPeriod: true, hasValue: false },
  { v: 'bbMiddle', label: 'BB middle', hasPeriod: true, hasValue: false },
  { v: 'bbLower', label: 'BB lower', hasPeriod: true, hasValue: false },
  { v: 'rollingHigh', label: 'Rolling high', hasPeriod: true, hasValue: false },
  { v: 'rollingLow', label: 'Rolling low', hasPeriod: true, hasValue: false },
  { v: 'atrPercentile', label: 'ATR percentile', hasPeriod: false, hasValue: false },
  { v: 'rangeExpansion', label: 'Range expansion', hasPeriod: false, hasValue: false },
  { v: 'bodyRatio', label: 'Body ratio', hasPeriod: false, hasValue: false },
  { v: 'value', label: 'number…', hasPeriod: false, hasValue: true },
]

const BB_BAND: Record<string, 'upper' | 'middle' | 'lower'> = {
  bbUpper: 'upper',
  bbMiddle: 'middle',
  bbLower: 'lower',
}

const COMPARATORS: { v: Comparator; label: string }[] = [
  { v: 'GT', label: '>' },
  { v: 'GTE', label: '≥' },
  { v: 'LT', label: '<' },
  { v: 'LTE', label: '≤' },
  { v: 'CROSS_ABOVE', label: 'crosses above' },
  { v: 'CROSS_BELOW', label: 'crosses below' },
]

function operandToUI(o: Operand): { kind: OperandKind; period: number; value: number } {
  if (o.type === 'price' || o.type === 'prevPrice') return { kind: 'price', period: 14, value: 0 }
  if (o.type === 'value') return { kind: 'value', period: 14, value: o.value }
  if (o.type === 'atrOffset') return { kind: 'atr', period: o.atrPeriod, value: 0 }
  if (o.type === 'bollinger') {
    const kind: OperandKind =
      o.band === 'upper' ? 'bbUpper' : o.band === 'lower' ? 'bbLower' : 'bbMiddle'
    return { kind, period: o.period, value: o.stdDevs }
  }
  if ('period' in o) return { kind: o.type as OperandKind, period: o.period, value: 0 }
  return { kind: o.type as OperandKind, period: 14, value: 0 }
}

function uiToOperand(u: { kind: OperandKind; period: number; value: number }): Operand {
  switch (u.kind) {
    case 'price':
      return { type: 'price', field: 'close' }
    case 'value':
      return { type: 'value', value: u.value }
    case 'atrPercentile':
    case 'rangeExpansion':
    case 'bodyRatio':
      return { type: u.kind }
    case 'bbUpper':
    case 'bbMiddle':
    case 'bbLower':
      return {
        type: 'bollinger',
        period: Math.max(2, Math.round(u.period)),
        // `value` carries the band width for Bollinger operands; default to the
        // conventional 2σ when the row was created from another operand type.
        stdDevs: u.value > 0 ? u.value : 2,
        band: BB_BAND[u.kind],
      }
    default:
      return { type: u.kind, period: Math.max(1, Math.round(u.period)) } as Operand
  }
}

interface RuleRow {
  left: { kind: OperandKind; period: number; value: number }
  cmp: Comparator
  right: { kind: OperandKind; period: number; value: number }
}

const conditionToRow = (c: Condition): RuleRow => ({
  left: operandToUI(c.left),
  cmp: c.cmp === 'WITHIN' ? 'GTE' : c.cmp,
  right: operandToUI(c.right),
})

const rowToCondition = (r: RuleRow): Condition => ({
  kind: 'condition',
  left: uiToOperand(r.left),
  cmp: r.cmp,
  right: uiToOperand(r.right),
})

export function SpecEditor({ spec }: { spec: StrategySpec }): React.ReactElement {
  const s = useLab()

  // ── editable state, seeded from the incoming spec
  const [name, setName] = useState(spec.name)
  const [direction, setDirection] = useState(spec.direction)
  const [mode, setMode] = useState(spec.entryMode.mode)
  const [lookback, setLookback] = useState(
    spec.entryMode.mode === 'BREAKOUT_OCO' ? spec.entryMode.lookback : 20,
  )
  const [buffer, setBuffer] = useState(
    spec.entryMode.mode === 'BREAKOUT_OCO' ? spec.entryMode.bufferAtrMultiple : 0.1,
  )
  const [expiry, setExpiry] = useState(
    spec.entryMode.mode === 'BREAKOUT_OCO' ? spec.entryMode.orderExpiryBars : 12,
  )
  const [interval, setInterval_] = useState(
    spec.entryMode.mode === 'CADENCE' ? spec.entryMode.intervalBars : 48,
  )
  const [stopUnit, setStopUnit] = useState(spec.exit.stop.unit)
  const [stopValue, setStopValue] = useState(spec.exit.stop.value)
  // A spec may target an indicator LEVEL (e.g. the Bollinger middle) rather
  // than a distance. That has no numeric knob, so it is held aside and
  // rendered read-only; the numeric controls only appear once the user
  // explicitly switches to a distance-based target.
  const [indicatorTarget, setIndicatorTarget] = useState<TargetSpec | null>(
    spec.exit.target?.unit === 'INDICATOR' ? spec.exit.target : null,
  )
  const [targetValue, setTargetValue] = useState(
    spec.exit.target && spec.exit.target.unit !== 'INDICATOR' ? spec.exit.target.value : 0,
  )
  const [targetUnit, setTargetUnit] = useState<'R' | 'ATR' | 'PRICE'>(
    spec.exit.target && spec.exit.target.unit !== 'INDICATOR' ? spec.exit.target.unit : 'R',
  )
  const [timeoutBars, setTimeoutBars] = useState(spec.exit.timeoutBars ?? 0)
  const [entryRows, setEntryRows] = useState<RuleRow[]>(
    spec.entry.rules.filter((r): r is Condition => r.kind === 'condition').map(conditionToRow),
  )
  const [filterRows, setFilterRows] = useState<RuleRow[]>(
    spec.filters
      .filter((f): f is Condition => 'kind' in f && f.kind === 'condition')
      .map(conditionToRow),
  )
  const [sessions, setSessions] = useState<Session[]>(() => {
    const sf = spec.filters.find((f) => 'kind' in f && f.kind === 'session') as
      | { kind: 'session'; sessions: Session[] }
      | undefined
    return sf?.sessions ?? [...SESSIONS]
  })
  const [htf, setHtf] = useState(
    spec.filters.some((f) => 'kind' in f && f.kind === 'htfAlignment' && (f as { enabled: boolean }).enabled),
  )
  const [importError, setImportError] = useState<string | null>(null)

  const built: StrategySpec = useMemo(() => {
    const filters: FilterNode[] = []
    if (sessions.length && sessions.length < SESSIONS.length) {
      filters.push({ kind: 'session', sessions })
    }
    if (htf) filters.push({ kind: 'htfAlignment', enabled: true })
    for (const r of filterRows) filters.push(rowToCondition(r))

    return {
      ...spec,
      name,
      direction,
      entryMode:
        mode === 'BREAKOUT_OCO'
          ? { mode, lookback, bufferAtrMultiple: buffer, orderExpiryBars: expiry }
          : mode === 'CADENCE'
            ? { mode, intervalBars: interval, simultaneousBothSides: direction === 'both' }
            : { mode: 'MARKET' },
      entry: { kind: 'group', op: 'AND', rules: entryRows.map(rowToCondition) },
      entryShort: direction === 'both' && mode === 'MARKET' ? spec.entryShort : spec.entryShort,
      exit: {
        stop: { unit: stopUnit, value: stopValue, atrPeriod: spec.exit.stop.atrPeriod ?? 14 },
        target: indicatorTarget ?? (targetValue > 0 ? { unit: targetUnit, value: targetValue } : null),
        timeoutBars: timeoutBars > 0 ? Math.round(timeoutBars) : null,
      },
      filters,
      meta: { ...spec.meta, specVersion: SPEC_VERSION },
    }
  }, [spec, name, direction, mode, lookback, buffer, expiry, interval, stopUnit, stopValue, targetUnit, targetValue, indicatorTarget, timeoutBars, entryRows, filterRows, sessions, htf])

  const issues = useMemo(() => validateSpec(built), [built])
  const runnable = specIsRunnable(issues)

  const apply = (): void => {
    s.useSpec({ ...built, id: spec.id, meta: { ...built.meta, createdAt: Date.now() } })
  }

  const importJson = async (file: File): Promise<void> => {
    setImportError(null)
    try {
      const parsed = JSON.parse(await readFileAsText(file)) as { spec?: StrategySpec } | StrategySpec
      const incoming = 'spec' in parsed && parsed.spec ? parsed.spec : (parsed as StrategySpec)
      const problems = validateSpec(incoming)
      if (!specIsRunnable(problems)) {
        const first = problems.find((i) => i.severity === 'ERROR')
        setImportError(`${first?.path}: ${first?.message}`)
        return
      }
      s.useSpec(incoming)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    }
  }

  // Entry rules only make sense for MARKET / BREAKOUT_OCO modes. The hedge
  // baseline (CADENCE) enters on a fixed schedule and has no rule input; the
  // UI must not present a widget that does nothing.
  const rulesApply = mode === 'MARKET' || mode === 'BREAKOUT_OCO'

  return (
    <div className="spec-editor">
      {/* ── Identity + entry mode ───────────────────────────────── */}
      <div className="spec-block">
        <div className="spec-block-title">Identity</div>
        <div className="spec-grid">
          <label className="field field-wide">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>{STR.specDirection}</span>
            <select value={direction} onChange={(e) => setDirection(e.target.value as StrategySpec['direction'])}>
              <option value="both">both</option>
              <option value="long">long</option>
              <option value="short">short</option>
            </select>
          </label>
          <label className="field">
            <span>{STR.specEntryMode}</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="BREAKOUT_OCO">breakout (OCO stops)</option>
              <option value="MARKET">market on rules</option>
              <option value="CADENCE">cadence (baseline)</option>
            </select>
          </label>
        </div>
      </div>

      {/* ── Entry-mode parameters ───────────────────────────────── */}
      {(mode === 'BREAKOUT_OCO' || mode === 'CADENCE') && (
        <div className="spec-block">
          <div className="spec-block-title">Entry mode parameters</div>
          <div className="spec-grid">
            {mode === 'BREAKOUT_OCO' && (
              <>
                <SliderNumber label="Lookback (bars)" value={lookback} onChange={setLookback}
                  min={2} max={200} step={1}
                  help="Completed bars defining the breakout range. The forming bar is always excluded." />
                <SliderNumber label="Buffer (ATR ×)" value={buffer} onChange={setBuffer}
                  min={0} max={3} step={0.05}
                  help="Distance beyond the range edge for the entry stop orders." />
                <SliderNumber label="Order expiry (bars)" value={expiry} onChange={setExpiry}
                  min={1} max={100} step={1}
                  help="Cancel untriggered entries after this many bars." />
              </>
            )}
            {mode === 'CADENCE' && (
              <SliderNumber label="Interval (bars)" value={interval} onChange={setInterval_}
                min={1} max={500} step={1}
                help="Bars between cadence entries — the hedge baseline's only knob." />
            )}
          </div>
        </div>
      )}

      {/* ── Exit geometry: stop + target aligned, unit dropdowns inline ── */}
      <div className="spec-block">
        <div className="spec-block-title">Exit</div>
        <div className="spec-grid">
          <div className="field">
            <span>{STR.specStop}</span>
            <div className="field-inline">
              <input
                type="number"
                step={0.1}
                min={0.05}
                value={stopValue}
                onChange={(e) => setStopValue(Number(e.target.value))}
              />
              <select value={stopUnit} onChange={(e) => setStopUnit(e.target.value as 'ATR' | 'PRICE')}>
                <option value="ATR">ATR ×</option>
                <option value="PRICE">price</option>
              </select>
            </div>
          </div>
          {indicatorTarget && indicatorTarget.unit === 'INDICATOR' ? (
            <div className="field">
              <span>{STR.specTarget}</span>
              <div className="field-inline">
                <input
                  type="text"
                  readOnly
                  value={operandLabel(indicatorTarget.operand)}
                  title="This target is a level read from an indicator at the signal bar, not a fixed distance."
                />
                <button
                  className="btn small"
                  onClick={() => setIndicatorTarget(null)}
                  title="Replace the indicator level with a fixed distance target"
                >
                  use R…
                </button>
              </div>
              <span className="hint">level, fixed at entry — not a distance</span>
            </div>
          ) : (
            <div className="field">
              <span>{STR.specTarget}</span>
              <div className="field-inline">
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  value={targetValue}
                  onChange={(e) => setTargetValue(Number(e.target.value))}
                />
                <select value={targetUnit} onChange={(e) => setTargetUnit(e.target.value as 'R' | 'ATR' | 'PRICE')}>
                  <option value="R">R</option>
                  <option value="ATR">ATR ×</option>
                  <option value="PRICE">price</option>
                </select>
              </div>
              <span className="hint">0 = no target</span>
            </div>
          )}
          <SliderNumber label={STR.specTimeout} value={timeoutBars} onChange={setTimeoutBars}
            min={0} max={500} step={1}
            help="Close the position after this many bars regardless of price. 0 disables the timeout." />
        </div>
      </div>

      {/* ── Rules: only when the entry mode actually uses them ─── */}
      {rulesApply ? (
        <>
          <RuleList title={STR.specRules} rows={entryRows} onChange={setEntryRows} />
          <RuleList title={`${STR.specFilters} (numeric)`} rows={filterRows} onChange={setFilterRows} />
        </>
      ) : (
        <div className="spec-block muted-block">
          <div className="spec-block-title">Entry rules</div>
          <p className="hint" style={{ margin: 0 }}>
            The <b>cadence</b> entry mode fires on a fixed schedule (the hedge baseline). Rules and
            numeric filters do not apply here — switch entry mode to <em>market on rules</em> or
            <em> breakout</em> to compose them.
          </p>
        </div>
      )}

      {/* ── Session + higher-timeframe filters ─────────────────── */}
      <div className="spec-block">
        <div className="spec-block-title">Filters</div>
        <div className="field">
          <span>{STR.specSessionFilter}</span>
          <div className="check-group">
            {SESSIONS.map((sess) => (
              <label key={sess} className="check">
                <input
                  type="checkbox"
                  checked={sessions.includes(sess)}
                  onChange={(e) =>
                    setSessions(
                      e.target.checked ? [...sessions, sess] : sessions.filter((x) => x !== sess),
                    )
                  }
                />
                <span>{sess}</span>
              </label>
            ))}
          </div>
        </div>
        <label className="check" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={htf} onChange={(e) => setHtf(e.target.checked)} />
          <span>{STR.specHtfFilter}</span>
        </label>
      </div>

      {issues.length > 0 && (
        <Callout kind={runnable ? 'warn' : 'error'}>
          {!runnable && <b>{STR.specValidationErrors}</b>}
          {issues.map((i, k) => (
            <div key={k} className="small">
              <Badge kind={i.severity === 'ERROR' ? 'bad' : 'warn'}>{i.severity}</Badge> {i.path}: {i.message}
            </div>
          ))}
        </Callout>
      )}

      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={!runnable} onClick={apply}>
          APPLY & RUN
        </button>
        <button
          className="btn"
          onClick={() => downloadText(`${built.id}.json`, JSON.stringify(built, null, 2))}
        >
          {STR.specExport}
        </button>
        <label className="btn file-btn">
          {STR.specImport}
          <input
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importJson(f)
              e.currentTarget.value = ''
            }}
          />
        </label>
        <button className="btn" onClick={() => void s.saveToLibrary(built, null)}>
          {STR.saveToLibrary}
        </button>
      </div>
      {importError && <Callout kind="error">{STR.specImportBad(importError)}</Callout>}
    </div>
  )
}

function RuleList({
  title,
  rows,
  onChange,
}: {
  title: string
  rows: RuleRow[]
  onChange: (rows: RuleRow[]) => void
}): React.ReactElement {
  const update = (i: number, patch: Partial<RuleRow>): void => {
    onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  }
  return (
    <div className="spec-block">
      <div className="spec-block-title">{title}</div>
      {rows.length === 0 && (
        <p className="hint" style={{ margin: '4px 0 8px' }}>None yet — add one below.</p>
      )}
      <div className="rule-list">
        {rows.map((r, i) => (
          <div className="rule-row" key={i}>
            <OperandPicker value={r.left} onChange={(left) => update(i, { left })} />
            <select
              className="rule-cmp"
              value={r.cmp}
              onChange={(e) => update(i, { cmp: e.target.value as Comparator })}
            >
              {COMPARATORS.map((c) => (
                <option key={c.v} value={c.v}>
                  {c.label}
                </option>
              ))}
            </select>
            <OperandPicker value={r.right} onChange={(right) => update(i, { right })} />
            <button
              className="btn small danger rule-remove"
              onClick={() => onChange(rows.filter((_, k) => k !== i))}
              aria-label={`Remove rule ${i + 1}`}
              title="Remove"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        className="btn small"
        style={{ marginTop: 8 }}
        onClick={() =>
          onChange([
            ...rows,
            {
              left: { kind: 'ema', period: 10, value: 0 },
              cmp: 'CROSS_ABOVE',
              right: { kind: 'ema', period: 40, value: 0 },
            },
          ])
        }
      >
        {STR.specAddRule}
      </button>
    </div>
  )
}

function OperandPicker({
  value,
  onChange,
}: {
  value: { kind: OperandKind; period: number; value: number }
  onChange: (v: { kind: OperandKind; period: number; value: number }) => void
}): React.ReactElement {
  const def = OPERAND_KINDS.find((k) => k.v === value.kind)!
  return (
    <span className="operand-picker">
      <select
        className="operand-kind"
        value={value.kind}
        onChange={(e) => onChange({ ...value, kind: e.target.value as OperandKind })}
      >
        {OPERAND_KINDS.map((k) => (
          <option key={k.v} value={k.v}>
            {k.label}
          </option>
        ))}
      </select>
      {def.hasPeriod && (
        <input
          type="number"
          min={1}
          step={1}
          value={value.period}
          onChange={(e) => onChange({ ...value, period: Number(e.target.value) })}
          className="operand-period"
          title="period"
        />
      )}
      {def.hasValue && (
        <input
          type="number"
          step={0.05}
          value={value.value}
          onChange={(e) => onChange({ ...value, value: Number(e.target.value) })}
          className="operand-value"
          title="value"
        />
      )}
    </span>
  )
}

function NumField({
  label,
  value,
  onChange,
  min,
  step,
  hint,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  step: number
  hint?: string
}): React.ReactElement {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <span className="hint">{hint}</span>}
    </label>
  )
}
