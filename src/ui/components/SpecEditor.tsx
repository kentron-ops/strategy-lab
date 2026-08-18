import React, { useMemo, useState } from 'react'
import { useLab } from '../../state/store'
import { STR } from '../strings'
import { Badge, Callout, downloadText, readFileAsText } from './bits'
import type {
  Comparator,
  Condition,
  FilterNode,
  Operand,
  StrategySpec,
} from '../../core/spec/types'
import { SPEC_VERSION } from '../../core/spec/types'
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
  | 'rollingHigh'
  | 'rollingLow'
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
  { v: 'rollingHigh', label: 'Rolling high', hasPeriod: true, hasValue: false },
  { v: 'rollingLow', label: 'Rolling low', hasPeriod: true, hasValue: false },
  { v: 'atrPercentile', label: 'ATR percentile', hasPeriod: false, hasValue: false },
  { v: 'rangeExpansion', label: 'Range expansion', hasPeriod: false, hasValue: false },
  { v: 'bodyRatio', label: 'Body ratio', hasPeriod: false, hasValue: false },
  { v: 'value', label: 'number…', hasPeriod: false, hasValue: true },
]

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
  if ('period' in o) return { kind: o.type, period: o.period, value: 0 }
  return { kind: o.type, period: 14, value: 0 }
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
  const [targetValue, setTargetValue] = useState(spec.exit.target?.value ?? 0)
  const [targetUnit, setTargetUnit] = useState(spec.exit.target?.unit ?? 'R')
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
        target: targetValue > 0 ? { unit: targetUnit, value: targetValue } : null,
        timeoutBars: timeoutBars > 0 ? Math.round(timeoutBars) : null,
      },
      filters,
      meta: { ...spec.meta, specVersion: SPEC_VERSION },
    }
  }, [spec, name, direction, mode, lookback, buffer, expiry, interval, stopUnit, stopValue, targetUnit, targetValue, timeoutBars, entryRows, filterRows, sessions, htf])

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

  return (
    <div className="spec-editor">
      <div className="row wrap" style={{ gap: 8 }}>
        <label className="field grow">
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

      {mode === 'BREAKOUT_OCO' && (
        <div className="row wrap" style={{ gap: 8 }}>
          <NumField label="Lookback" value={lookback} onChange={setLookback} min={2} step={1} />
          <NumField label="Buffer (ATR×)" value={buffer} onChange={setBuffer} min={0} step={0.05} />
          <NumField label="Order expiry" value={expiry} onChange={setExpiry} min={1} step={1} />
        </div>
      )}
      {mode === 'CADENCE' && (
        <NumField label="Interval (bars)" value={interval} onChange={setInterval_} min={1} step={1} />
      )}

      <div className="row wrap" style={{ gap: 8 }}>
        <label className="field">
          <span>{STR.specStop}</span>
          <div className="row" style={{ gap: 4 }}>
            <input
              type="number"
              step={0.1}
              min={0.05}
              value={stopValue}
              onChange={(e) => setStopValue(Number(e.target.value))}
              style={{ width: 80 }}
            />
            <select value={stopUnit} onChange={(e) => setStopUnit(e.target.value as 'ATR' | 'PRICE')}>
              <option value="ATR">ATR ×</option>
              <option value="PRICE">price</option>
            </select>
          </div>
        </label>
        <label className="field">
          <span>{STR.specTarget}</span>
          <div className="row" style={{ gap: 4 }}>
            <input
              type="number"
              step={0.1}
              min={0}
              value={targetValue}
              onChange={(e) => setTargetValue(Number(e.target.value))}
              style={{ width: 80 }}
            />
            <select value={targetUnit} onChange={(e) => setTargetUnit(e.target.value as 'R' | 'ATR' | 'PRICE')}>
              <option value="R">R</option>
              <option value="ATR">ATR ×</option>
              <option value="PRICE">price</option>
            </select>
          </div>
          <span className="hint">0 = no target</span>
        </label>
        <NumField label={STR.specTimeout} value={timeoutBars} onChange={setTimeoutBars} min={0} step={1} hint="0 = none" />
      </div>

      <RuleList title={STR.specRules} rows={entryRows} onChange={setEntryRows} />
      <RuleList title={`${STR.specFilters} (numeric)`} rows={filterRows} onChange={setFilterRows} />

      <div className="row wrap" style={{ gap: 12 }}>
        <div className="field">
          <span>{STR.specSessionFilter}</span>
          <div className="row" style={{ gap: 8 }}>
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
                {sess}
              </label>
            ))}
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={htf} onChange={(e) => setHtf(e.target.checked)} />
          {STR.specHtfFilter}
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
    <div className="field">
      <span>{title}</span>
      {rows.map((r, i) => (
        <div className="row rule-row" key={i} style={{ gap: 6 }}>
          <OperandPicker value={r.left} onChange={(left) => update(i, { left })} />
          <select value={r.cmp} onChange={(e) => update(i, { cmp: e.target.value as Comparator })}>
            {COMPARATORS.map((c) => (
              <option key={c.v} value={c.v}>
                {c.label}
              </option>
            ))}
          </select>
          <OperandPicker value={r.right} onChange={(right) => update(i, { right })} />
          <button className="btn small danger" onClick={() => onChange(rows.filter((_, k) => k !== i))}>
            {STR.specRemove}
          </button>
        </div>
      ))}
      <button
        className="btn small"
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
    <span className="row" style={{ gap: 4 }}>
      <select value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value as OperandKind })}>
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
          style={{ width: 64 }}
          title="period"
        />
      )}
      {def.hasValue && (
        <input
          type="number"
          step={0.05}
          value={value.value}
          onChange={(e) => onChange({ ...value, value: Number(e.target.value) })}
          style={{ width: 80 }}
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
        style={{ width: 100 }}
      />
      {hint && <span className="hint">{hint}</span>}
    </label>
  )
}
