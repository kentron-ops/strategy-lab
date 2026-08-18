import type {
  Condition,
  FilterNode,
  Operand,
  RuleGroup,
  RuleNode,
  SpecIssue,
  StrategySpec,
} from './types'
import { TIMEFRAMES } from '../types'

/**
 * Spec validation — run before compiling, before saving, before proving.
 * A spec with ERROR issues never reaches the engine; the UI shows the list.
 */

export function validateSpec(spec: StrategySpec): SpecIssue[] {
  const issues: SpecIssue[] = []
  const err = (path: string, message: string): void => {
    issues.push({ path, severity: 'ERROR', message })
  }
  const warn = (path: string, message: string): void => {
    issues.push({ path, severity: 'WARNING', message })
  }

  if (!spec.id) err('id', 'Spec has no id.')
  if (!spec.name?.trim()) err('name', 'Spec has no name.')
  if (!TIMEFRAMES.includes(spec.timeframe)) {
    err('timeframe', `Unknown timeframe "${spec.timeframe}".`)
  }
  if (!['long', 'short', 'both'].includes(spec.direction)) {
    err('direction', `Direction must be long, short or both.`)
  }

  // ── entry mode
  const m = spec.entryMode
  if (m.mode === 'BREAKOUT_OCO') {
    if (!(m.lookback >= 2)) err('entryMode.lookback', 'Breakout lookback must be at least 2 bars.')
    if (m.bufferAtrMultiple < 0) err('entryMode.buffer', 'Buffer cannot be negative.')
    if (!(m.orderExpiryBars >= 1)) err('entryMode.orderExpiryBars', 'Order expiry must be at least 1 bar.')
  } else if (m.mode === 'CADENCE') {
    if (!(m.intervalBars >= 1)) err('entryMode.intervalBars', 'Cadence interval must be at least 1 bar.')
    if (m.simultaneousBothSides && spec.direction !== 'both') {
      err('entryMode', 'Simultaneous both-sides entry requires direction "both".')
    }
  } else if (m.mode === 'MARKET') {
    if (countConditions(spec.entry) === 0) {
      err('entry', 'MARKET entry mode needs at least one entry rule — otherwise it would enter on every bar.')
    }
    if (spec.direction === 'both' && !spec.entryShort) {
      err(
        'entryShort',
        'MARKET mode with direction "both" needs explicit short-entry rules; a boolean rule set does not mirror itself.',
      )
    }
  }

  // ── exit geometry: the stop is the one non-negotiable block
  if (!spec.exit?.stop) {
    err('exit.stop', 'Every spec must define a stop. Without one the trade has no defined risk and cannot be sized.')
  } else {
    if (!(spec.exit.stop.value > 0)) err('exit.stop.value', 'Stop distance must be positive.')
    if (spec.exit.stop.unit === 'ATR' && spec.exit.stop.atrPeriod !== undefined && spec.exit.stop.atrPeriod < 1) {
      err('exit.stop.atrPeriod', 'ATR period must be at least 1.')
    }
  }
  if (spec.exit?.target) {
    if (spec.exit.target.unit === 'INDICATOR') {
      checkOperand(spec.exit.target.operand, 'exit.target.operand', issues)
    } else if (!(spec.exit.target.value > 0)) {
      err('exit.target.value', 'Target must be positive, or null for no target.')
    }
  }
  if (!spec.exit?.target && !spec.exit?.timeoutBars) {
    warn(
      'exit',
      'No target and no timeout: positions only ever exit at the stop or at the end of data. Deliberate for trend-following; a mistake otherwise.',
    )
  }
  if (spec.exit?.timeoutBars !== null && spec.exit?.timeoutBars !== undefined && spec.exit.timeoutBars < 1) {
    err('exit.timeoutBars', 'Timeout must be at least 1 bar, or null.')
  }

  // ── rules
  walkGroup(spec.entry, 'entry', issues)
  if (spec.entryShort) walkGroup(spec.entryShort, 'entryShort', issues)
  spec.filters.forEach((f, i) => walkFilter(f, `filters[${i}]`, issues))

  // ── risk & costs
  if (!(spec.risk.startingEquity > 0)) err('risk.startingEquity', 'Starting equity must be positive.')
  if (!(spec.risk.riskPercent > 0)) err('risk.riskPercent', 'Risk percent must be positive.')
  if (spec.risk.riskPercent > 5) {
    warn('risk.riskPercent', `Risking ${spec.risk.riskPercent}% per trade: a normal losing streak will be brutal. This is a choice, not an error.`)
  }
  if (spec.costs.spread < 0 || spec.costs.slippage < 0 || spec.costs.commissionPerUnit < 0) {
    err('costs', 'Costs cannot be negative.')
  }
  if (spec.costs.spread === 0 && spec.costs.slippage === 0) {
    warn('costs', 'Zero spread and zero slippage: fine for engine verification, meaningless for judging an edge.')
  }

  return issues
}

export const specIsRunnable = (issues: SpecIssue[]): boolean =>
  !issues.some((i) => i.severity === 'ERROR')

function walkGroup(g: RuleGroup, path: string, issues: SpecIssue[]): void {
  if (g.op !== 'AND' && g.op !== 'OR') {
    issues.push({ path, severity: 'ERROR', message: `Group op must be AND or OR.` })
  }
  g.rules.forEach((r, i) => walkRule(r, `${path}.rules[${i}]`, issues))
}

function walkRule(r: RuleNode, path: string, issues: SpecIssue[]): void {
  if (r.kind === 'group') return walkGroup(r, path, issues)
  walkCondition(r, path, issues)
}

function walkCondition(c: Condition, path: string, issues: SpecIssue[]): void {
  checkOperand(c.left, `${path}.left`, issues)
  checkOperand(c.right, `${path}.right`, issues)
  if (c.cmp === 'WITHIN' && !(c.tolerance !== undefined && c.tolerance >= 0)) {
    issues.push({ path, severity: 'ERROR', message: 'WITHIN needs a non-negative tolerance.' })
  }
  if (
    (c.cmp === 'CROSS_ABOVE' || c.cmp === 'CROSS_BELOW') &&
    c.left.type === 'value' &&
    c.right.type === 'value'
  ) {
    issues.push({ path, severity: 'ERROR', message: 'Two constants cannot cross.' })
  }
}

function checkOperand(o: Operand, path: string, issues: SpecIssue[]): void {
  switch (o.type) {
    case 'ema':
    case 'sma':
    case 'rsi':
    case 'atr':
    case 'adx':
    case 'rollingHigh':
    case 'rollingLow':
      if (!(Number.isFinite(o.period) && o.period >= 1 && o.period <= 5000)) {
        issues.push({ path, severity: 'ERROR', message: `Period must be 1–5000, got ${o.period}.` })
      }
      break
    case 'value':
      if (!Number.isFinite(o.value)) {
        issues.push({ path, severity: 'ERROR', message: 'Constant is not a finite number.' })
      }
      break
    case 'cci':
    case 'mfi':
      if (!(Number.isFinite(o.period) && o.period >= 2 && o.period <= 5000)) {
        issues.push({ path, severity: 'ERROR', message: `Period must be 2–5000, got ${o.period}.` })
      }
      break
    case 'bollinger':
      if (!(Number.isFinite(o.period) && o.period >= 2 && o.period <= 5000)) {
        issues.push({ path, severity: 'ERROR', message: `Bollinger period must be 2–5000, got ${o.period}.` })
      }
      if (!(Number.isFinite(o.stdDevs) && o.stdDevs > 0 && o.stdDevs <= 10)) {
        issues.push({ path, severity: 'ERROR', message: `Bollinger stdDevs must be between 0 and 10, got ${o.stdDevs}.` })
      }
      if (!['upper', 'middle', 'lower'].includes(o.band)) {
        issues.push({ path, severity: 'ERROR', message: `Unknown Bollinger band "${o.band}".` })
      }
      break
    case 'atrOffset':
      if (!(o.atrPeriod >= 1)) {
        issues.push({ path, severity: 'ERROR', message: 'ATR offset period must be at least 1.' })
      }
      checkOperand(o.base, `${path}.base`, issues)
      break
    default:
      break
  }
}

function walkFilter(f: FilterNode, path: string, issues: SpecIssue[]): void {
  if ('kind' in f && f.kind === 'session') {
    if (!f.sessions.length) {
      issues.push({ path, severity: 'ERROR', message: 'Session filter with no sessions blocks every trade.' })
    }
    return
  }
  if ('kind' in f && f.kind === 'htfAlignment') return
  walkRule(f as RuleNode, path, issues)
}

function countConditions(g: RuleGroup): number {
  let n = 0
  for (const r of g.rules) n += r.kind === 'group' ? countConditions(r) : 1
  return n
}
