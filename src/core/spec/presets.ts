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

// ─────────────────────────────────────────────────────────────────────────────
// Gold ideas — mean reversion and momentum, sized for M30
// ─────────────────────────────────────────────────────────────────────────────

/** Shared gold defaults: M30 bars, 1% risk, one position at a time. */
const gold = {
  market: 'XAUUSD',
  timeframe: '30m' as const,
  risk: {
    startingEquity: 200,
    riskPercent: 1,
    maxDailyLossPercent: null as number | null,
    maxConcurrentPositions: 1,
    sizingMethod: 'FIXED_FRACTIONAL' as const,
  },
  costs: { spread: 0.3, commissionPerUnit: 0, slippage: 0.05 },
}

/**
 * A. GOLD MEAN REVERSION (Bollinger + CCI).
 *
 * Buy when price closes below the lower band AND CCI confirms the stretch
 * (< −100); sell the mirror. The target is the Bollinger middle — the mean
 * being reverted TO — so it adapts to volatility instead of being a fixed
 * distance. Stop is 1.5 ATR, and a 16-bar timeout closes anything that has
 * simply stopped reverting.
 *
 * Two independent conditions is deliberate: a band touch alone fires
 * constantly in a trend, which is exactly when mean reversion is worst.
 */
export const PRESET_GOLD_MEANREV_BB_CCI: StrategySpec = {
  id: 'preset_gold_meanrev_bb_cci',
  name: 'Gold Mean Reversion (BB+CCI)',
  ...gold,
  direction: 'both',
  entryMode: { mode: 'MARKET' },
  entry: {
    kind: 'group',
    op: 'AND',
    rules: [
      {
        kind: 'condition',
        left: { type: 'price', field: 'close' },
        cmp: 'LT',
        right: { type: 'bollinger', period: 20, stdDevs: 2, band: 'lower' },
      },
      {
        kind: 'condition',
        left: { type: 'cci', period: 20 },
        cmp: 'LT',
        right: { type: 'value', value: -100 },
      },
    ],
  },
  entryShort: {
    kind: 'group',
    op: 'AND',
    rules: [
      {
        kind: 'condition',
        left: { type: 'price', field: 'close' },
        cmp: 'GT',
        right: { type: 'bollinger', period: 20, stdDevs: 2, band: 'upper' },
      },
      {
        kind: 'condition',
        left: { type: 'cci', period: 20 },
        cmp: 'GT',
        right: { type: 'value', value: 100 },
      },
    ],
  },
  exit: {
    stop: { unit: 'ATR', value: 1.5, atrPeriod: 14 },
    // The mean itself is the target: SMA(20), i.e. the Bollinger middle.
    target: { unit: 'INDICATOR', operand: { type: 'bollinger', period: 20, stdDevs: 2, band: 'middle' } },
    timeoutBars: 16,
  },
  filters: [],
  meta: {
    createdFrom: 'built-in preset',
    specVersion: SPEC_VERSION,
    createdAt: 0,
    notes:
      'Fade the stretch: price outside the band AND CCI beyond ±100, aiming back at the 20-bar mean. Stop 1.5 ATR, 16-bar timeout. Mean reversion pays for being early and punishes being wrong in a trend — the OOS gate matters more here than anywhere.',
  },
}

/**
 * B. GOLD MEAN REVERSION (Bollinger + CCI + MFI).
 *
 * Adds a money-flow condition: only fade the low band when MFI(14) is also
 * below 20 (genuine selling exhaustion), and the high band when MFI is above
 * 80. The third filter should raise expectancy — but it also cuts the sample,
 * so compare the two side by side in the Prover rather than assuming more
 * conditions is better.
 */
export const PRESET_GOLD_MEANREV_BB_CCI_MFI: StrategySpec = {
  id: 'preset_gold_meanrev_bb_cci_mfi',
  name: 'Gold Mean Reversion (BB+CCI+MFI)',
  ...gold,
  direction: 'both',
  entryMode: { mode: 'MARKET' },
  entry: {
    kind: 'group',
    op: 'AND',
    rules: [
      ...PRESET_GOLD_MEANREV_BB_CCI.entry.rules,
      {
        kind: 'condition',
        left: { type: 'mfi', period: 14 },
        cmp: 'LT',
        right: { type: 'value', value: 20 },
      },
    ],
  },
  entryShort: {
    kind: 'group',
    op: 'AND',
    rules: [
      ...(PRESET_GOLD_MEANREV_BB_CCI.entryShort?.rules ?? []),
      {
        kind: 'condition',
        left: { type: 'mfi', period: 14 },
        cmp: 'GT',
        right: { type: 'value', value: 80 },
      },
    ],
  },
  exit: {
    stop: { unit: 'ATR', value: 1.5, atrPeriod: 14 },
    target: { unit: 'INDICATOR', operand: { type: 'bollinger', period: 20, stdDevs: 2, band: 'middle' } },
    timeoutBars: 16,
  },
  filters: [],
  meta: {
    createdFrom: 'built-in preset',
    specVersion: SPEC_VERSION,
    createdAt: 0,
    notes:
      'The BB+CCI fade plus MFI(14) < 20 for longs and > 80 for shorts, so the stretch must also show volume exhaustion. Fewer trades by construction — check whether the expectancy gained is worth the sample lost.',
  },
}

/**
 * C. GOLD MOMENTUM (Breakout).
 *
 * The opposite bet to A and B on the same instrument: buy strength rather
 * than fade it. Range breakout with the continuation qualifiers, tuned for
 * M30 gold and restricted to the London and New York sessions where the
 * moves that follow a break actually happen.
 */
export const PRESET_GOLD_MOMENTUM: StrategySpec = {
  id: 'preset_gold_momentum',
  name: 'Gold Momentum (Breakout)',
  ...gold,
  direction: 'both',
  entryMode: { mode: 'BREAKOUT_OCO', lookback: 20, bufferAtrMultiple: 0.1, orderExpiryBars: 12 },
  entry: { kind: 'group', op: 'AND', rules: [] },
  entryShort: null,
  exit: {
    stop: { unit: 'ATR', value: 1.5, atrPeriod: 14 },
    target: { unit: 'R', value: 2.5 },
    timeoutBars: 48,
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
  ],
  meta: {
    createdFrom: 'built-in preset',
    specVersion: SPEC_VERSION,
    createdAt: 0,
    notes:
      'Breakout continuation on M30 gold: OCO stops around the 20-bar range, London and NY only, requiring live volatility and higher-timeframe agreement. The momentum counterpart to the mean-reversion presets — run both and let the evidence decide which gold actually rewards.',
  },
}

export const PRESET_SPECS: StrategySpec[] = [
  PRESET_HEDGE,
  PRESET_OCO,
  PRESET_CONTINUATION,
  PRESET_GOLD_MEANREV_BB_CCI,
  PRESET_GOLD_MEANREV_BB_CCI_MFI,
  PRESET_GOLD_MOMENTUM,
]
