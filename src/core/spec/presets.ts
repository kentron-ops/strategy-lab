import type { StrategySpec } from './types'
import { SPEC_VERSION } from './types'

/**
 * The three built-in strategies, expressed as specs (V2 §3: "the 3 old
 * strategies become saved specs, not special code"). The original registry
 * strategies remain as the reference implementations the differential tests
 * compare against.
 */

const base = {
  market: 'XAUUSD',
  timeframe: '5m' as const,
  risk: {
    startingEquity: 200,
    riskPercent: 1,
    maxDailyLossPercent: null as number | null,
    maxConcurrentPositions: 1,
    sizingMethod: 'FIXED_FRACTIONAL' as const,
  },
  costs: { spread: 0.3, commissionPerUnit: 0, slippage: 0.05 },
}

export const PRESET_HEDGE: StrategySpec = {
  id: 'preset_hedge',
  name: 'Simultaneous hedge (baseline)',
  ...base,
  risk: { ...base.risk, maxConcurrentPositions: 2 },
  direction: 'both',
  entryMode: { mode: 'CADENCE', intervalBars: 48, simultaneousBothSides: true },
  entry: { kind: 'group', op: 'AND', rules: [] },
  entryShort: null,
  exit: {
    stop: { unit: 'ATR', value: 1.5, atrPeriod: 14 },
    target: { unit: 'R', value: 2 },
    timeoutBars: 96,
  },
  filters: [],
  meta: {
    createdFrom: 'built-in preset',
    specVersion: SPEC_VERSION,
    createdAt: 0,
    notes:
      'The baseline. Long and short together: directionally neutral by construction, pays entry costs twice. Exists to be measured, not believed.',
  },
}

export const PRESET_OCO: StrategySpec = {
  id: 'preset_oco_breakout',
  name: 'OCO breakout',
  ...base,
  direction: 'both',
  entryMode: { mode: 'BREAKOUT_OCO', lookback: 20, bufferAtrMultiple: 0.1, orderExpiryBars: 12 },
  entry: { kind: 'group', op: 'AND', rules: [] },
  entryShort: null,
  exit: {
    stop: { unit: 'ATR', value: 1.5, atrPeriod: 14 },
    target: { unit: 'R', value: 2 },
    timeoutBars: 96,
  },
  filters: [],
  meta: {
    createdFrom: 'built-in preset',
    specVersion: SPEC_VERSION,
    createdAt: 0,
    notes: 'The hedge idea with the entry cost paid once: stops around the range, first fill cancels the other.',
  },
}

export const PRESET_CONTINUATION: StrategySpec = {
  id: 'preset_breakout_continuation',
  name: 'Breakout continuation',
  ...base,
  direction: 'both',
  entryMode: { mode: 'BREAKOUT_OCO', lookback: 20, bufferAtrMultiple: 0.1, orderExpiryBars: 12 },
  entry: { kind: 'group', op: 'AND', rules: [] },
  entryShort: null,
  exit: {
    stop: { unit: 'ATR', value: 1.5, atrPeriod: 14 },
    target: { unit: 'R', value: 2.5 },
    timeoutBars: 96,
  },
  filters: [
    { kind: 'session', sessions: ['LONDON', 'NY'] },
    { kind: 'htfAlignment', enabled: true },
    {
      kind: 'condition',
      left: { type: 'atrPercentile' },
      cmp: 'GTE',
      right: { type: 'value', value: 0.4 },
    },
    {
      kind: 'condition',
      left: { type: 'rangeExpansion' },
      cmp: 'GTE',
      right: { type: 'value', value: 1.1 },
    },
    {
      kind: 'condition',
      left: { type: 'bodyRatio' },
      cmp: 'GTE',
      right: { type: 'value', value: 0.35 },
    },
  ],
  meta: {
    createdFrom: 'built-in preset',
    specVersion: SPEC_VERSION,
    createdAt: 0,
    notes:
      'OCO breakout plus deterministic qualifiers, each one visible in the rejection histogram so its cost in sample size can be judged.',
  },
}

export const PRESET_SPECS: StrategySpec[] = [PRESET_HEDGE, PRESET_OCO, PRESET_CONTINUATION]
