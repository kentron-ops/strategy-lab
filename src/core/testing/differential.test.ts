import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StrategySpec } from '../spec/types'
import { SPEC_VERSION } from '../spec/types'
import { makeSpecConfig } from '../spec/resolve'
import { runBacktest } from '../backtest/engine'
import { buildSampleDataset } from '../data/sample'
import { makeFrictionlessConfig } from './fixtures'
import { toCsv } from '../data/csvLoader'

/**
 * Differential-test EXPORT (V2 §6).
 *
 * Runs a deliberately simple, exactly-reproducible strategy (EMA 10/40 cross,
 * long only, fixed price stop/target anchored to the signal close, zero costs)
 * and writes the dataset + trade list to scripts/differential/out/. The Python
 * reference engine (backtesting.py) then runs THE SAME rules on THE SAME CSV
 * and `compare.py` diffs the two trade lists.
 *
 * This file is the TS half of the trust lock: it always runs with the suite, so
 * the export can never go stale relative to the engine.
 */

const OUT = join(process.cwd(), 'scripts', 'differential', 'out')

const DIFF_SPEC: StrategySpec = {
  id: 'diff_ema_cross',
  name: 'Differential: EMA 10/40 cross, long only',
  market: 'XAUUSD-SYNTHETIC',
  timeframe: '5m',
  direction: 'long',
  entryMode: { mode: 'MARKET' },
  entry: {
    kind: 'group',
    op: 'AND',
    rules: [
      {
        kind: 'condition',
        left: { type: 'ema', period: 10 },
        cmp: 'CROSS_ABOVE',
        right: { type: 'ema', period: 40 },
      },
    ],
  },
  entryShort: null,
  exit: {
    // PRICE units on purpose: reproducing Wilder ATR in a second engine would
    // test the ATR implementation, not the execution semantics.
    stop: { unit: 'PRICE', value: 15 },
    target: { unit: 'PRICE', value: 30 },
    timeoutBars: null,
  },
  filters: [],
  risk: {
    startingEquity: 1_000_000,
    riskPercent: 1,
    maxDailyLossPercent: null,
    maxConcurrentPositions: 1,
    sizingMethod: 'FIXED_FRACTIONAL',
  },
  costs: { spread: 0, commissionPerUnit: 0, slippage: 0 },
  meta: { createdFrom: 'differential harness', specVersion: SPEC_VERSION, createdAt: 0, notes: '' },
}

describe('differential export', () => {
  it('writes the dataset and TS trade list for the Python reference engine', () => {
    const full = buildSampleDataset()
    const dataset = { ...full, candles: full.candles.slice(0, 4000) }

    const config = makeFrictionlessConfig('oco_breakout', {
      risk: {
        startingEquity: 1_000_000,
        riskPercent: 1,
        sizingMethod: 'FIXED_FRACTIONAL',
        fixedCash: 2,
        volTargetAtrMultiple: 1.5,
        kellyFraction: 0.25,
        maxConcurrentPositions: 1,
        maxDailyLossPercent: null,
        maxConsecutiveLosses: null,
        equityFloorPercent: null,
      },
    })
    config.strategy = makeSpecConfig(DIFF_SPEC)

    const result = runBacktest(dataset, config)
    expect(result.trades.length).toBeGreaterThan(5)

    mkdirSync(OUT, { recursive: true })
    writeFileSync(join(OUT, 'data.csv'), toCsv(dataset.candles), 'utf8')

    const header = 'entry_time,exit_time,entry_bar,exit_bar,side,entry_price,exit_price,exit_reason,gross_per_unit,ambiguous'
    const rows = result.trades.map((t) =>
      [
        new Date(t.entryTime).toISOString(),
        new Date(t.exitTime).toISOString(),
        t.entryBar,
        t.exitBar,
        t.side,
        t.entryPrice,
        t.exitPrice,
        t.exitReason,
        ((t.exitPrice - t.entryPrice) * (t.side === 'LONG' ? 1 : -1)).toFixed(8),
        t.ambiguous ? 1 : 0,
      ].join(','),
    )
    writeFileSync(join(OUT, 'ts_trades.csv'), [header, ...rows].join('\n'), 'utf8')

    writeFileSync(
      join(OUT, 'meta.json'),
      JSON.stringify(
        {
          engineVersion: result.snapshot.engineVersion,
          datasetHash: dataset.hash,
          bars: dataset.candles.length,
          trades: result.trades.length,
          ambiguousTrades: result.ambiguity.ambiguousTrades,
          spec: {
            emaFast: 10,
            emaSlow: 40,
            stopDistance: 15,
            targetDistance: 30,
            anchor: 'signal bar close',
            fill: 'next bar open',
            intrabar: 'CONSERVATIVE (stop before target when both touched)',
            costs: 'zero',
          },
          tolerance: {
            price: 1e-6,
            maxMismatchedTradesPct: 1,
            note: 'Known divergence: bars that gap through stop AND target simultaneously may fill differently; each such trade is flagged ambiguous.',
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    // The export itself asserts the engine's books balance.
    const ledger = result.trades.reduce((a, t) => a + t.netPnl, 0)
    expect(result.metrics.endingEquity).toBeCloseTo(1_000_000 + ledger, 6)
  })
})
