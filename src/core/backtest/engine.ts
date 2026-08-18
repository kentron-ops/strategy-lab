import type {
  AmbiguityReport,
  BacktestConfig,
  BacktestResult,
  Candle,
  Dataset,
  EquityPoint,
  Indicators,
  Order,
  Position,
  Reason,
  Trade,
  ExitReason,
} from '../types'
import { ENGINE_VERSION } from '../types'
import { computeIndicators } from '../indicators'
import { getStrategy } from '../strategy/registry'
import { resolveStrategyConfig } from '../spec/resolve'
import {
  cancelGroup,
  cancelOcoSiblings,
  expireOrders,
  selectEntry,
  validateOrder,
} from '../execution/orderStateMachine'
import {
  commission,
  financing,
  fillPrice,
  grossPnl,
  type FillContext,
} from '../execution/costModel'
import { resolveBar, updateExcursions } from '../execution/intrabar'
import {
  applyTradeResult,
  checkLimits,
  initialRiskState,
  rollDay,
  sizePosition,
  type RiskState,
} from '../risk/riskEngine'
import { computeMetrics } from './metrics'
import { utcDayKey } from '../util/time'

/**
 * The backtest engine.
 *
 * ── The one invariant that makes any of this worth trusting ──────────────────
 * The strategy is evaluated ONCE per bar, at that bar's close, and every order
 * it places carries `createdBar = i` and is only eligible to fill from bar i+1.
 * Nothing in this loop ever reads candles[j] for j > i on behalf of a decision.
 * `noLookAhead.test.ts` proves it by mutating the future and asserting the past
 * is byte-identical.
 *
 * Bar processing order is fixed and deliberate:
 *   1. roll the risk day
 *   2. accrue financing on open positions
 *   3. resolve exits for positions already open
 *   4. fill at most one pending entry (OCO ambiguity resolved explicitly)
 *   5. resolve an exit for a position opened on THIS bar
 *   6. update MFE/MAE
 *   7. expire stale orders
 *   8. evaluate the strategy at the close → new orders for bar i+1
 *
 * Steps 3-before-4 mean a position can close and the strategy can re-arm on the
 * same bar, but the re-armed order cannot fill until the next bar. There is no
 * same-bar round trip.
 */

export interface RunOptions {
  /** Finer-timeframe bars keyed by base bar index, to resolve ambiguity exactly. */
  fineByBar?: Map<number, Candle[]>
  /** Called roughly every `progressEvery` bars with a 0..1 fraction. */
  onProgress?: (fraction: number, barsDone: number) => void
  progressEvery?: number
  /** Reuse precomputed indicators across a sweep (they do not depend on params). */
  indicators?: Indicators
  /** Abort cooperatively — checked on the progress cadence. */
  shouldAbort?: () => boolean
}

interface OpenPosition extends Position {
  /** Bar index at which the timeout fires, or null. */
  timeoutAtBar: number | null
  rawEntryPrice: number
}

export function runBacktest(
  dataset: Dataset,
  configIn: BacktestConfig,
  opts: RunOptions = {},
): BacktestResult {
  const startedAt = Date.now()
  const config: BacktestConfig = {
    ...configIn,
    strategy: resolveStrategyConfig(configIn.strategy),
  }

  const strategy = getStrategy(config.strategy.strategyId)
  const params = config.strategy.params
  const candles = dataset.candles
  const n = candles.length

  const ind =
    opts.indicators ?? computeIndicators(candles, config.indicators, dataset.timeframe)

  const from = Math.max(0, config.fromIndex ?? 0)
  const to = Math.min(n - 1, config.toIndex ?? n - 1)

  const warnings: string[] = []
  const trades: Trade[] = []
  const orders: Order[] = []
  const equityCurve: EquityPoint[] = []
  const rejections: Record<string, number> = {}
  const limitStops: { bar: number; time: number; reason: string }[] = []

  let ambiguousBars = 0
  let ambiguousTrades = 0
  let skippedTrades = 0

  let pending: Order[] = []
  let positions: OpenPosition[] = []

  let orderSeq = 0
  let tradeSeq = 0
  let posSeq = 0

  let risk: RiskState = initialRiskState(
    config.risk,
    n ? utcDayKey(candles[from]?.t ?? 0) : '',
  )
  let peak = risk.equity
  let barsInPosition = 0

  const progressEvery = opts.progressEvery ?? 2000
  const totalBars = Math.max(1, to - from + 1)

  if (to < from) {
    warnings.push('Empty bar range — nothing to run.')
  }
  if (dataset.quality && !dataset.quality.usable) {
    warnings.push(
      'Dataset has ERROR-level quality issues. Results computed anyway, but they are not trustworthy.',
    )
  }

  const recordReasons = (reasons: Reason[]): void => {
    for (const r of reasons) {
      if (r.passed) continue
      rejections[r.code] = (rejections[r.code] ?? 0) + 1
    }
  }

  const fillCtx = (i: number): FillContext => ({
    atr: ind.atr[i],
    session: ind.session[i],
  })

  /** Close a position and append the finished trade. */
  const closePosition = (
    p: OpenPosition,
    i: number,
    rawExitPrice: number,
    exitReason: ExitReason,
    ambiguous: boolean,
    excluded: boolean,
  ): void => {
    const bar = candles[i]
    const ctx = fillCtx(i)
    const exitKind = exitReason === 'TARGET' ? 'LIMIT_EXIT' : 'STOP_EXIT'
    const exitFill = fillPrice(rawExitPrice, p.side, exitKind, config.costs, ctx)

    const barsHeld = i - p.entryBar
    const rawPnl = grossPnl(
      p.side,
      p.rawEntryPrice,
      rawExitPrice,
      p.qty,
      config.instrument.pointValue,
    )
    const filledPnl = grossPnl(
      p.side,
      p.entryPrice,
      exitFill,
      p.qty,
      config.instrument.pointValue,
    )
    const spreadAndSlippage = rawPnl - filledPnl
    const commissions = commission(p.qty, config.costs) * 2
    const fin = financing(p.qty, barsHeld, config.costs)
    const costs = spreadAndSlippage + commissions + fin
    const netPnl = rawPnl - costs

    // Excluded trades are recorded for auditability but must not move equity —
    // SKIP_AMBIGUOUS means "this outcome is unknown", not "this outcome is zero".
    if (!excluded) {
      risk = applyTradeResult(risk, netPnl, config.risk, utcDayKey(bar.t))
      if (risk.killed && !limitStops.some((l) => l.bar === i)) {
        limitStops.push({ bar: i, time: bar.t, reason: risk.killReason ?? 'kill switch' })
      }
    }

    tradeSeq += 1
    trades.push({
      id: `tr_${tradeSeq}`,
      strategyId: config.strategy.strategyId,
      side: p.side,
      qty: p.qty,
      tag: p.tag,
      entryBar: p.entryBar,
      entryTime: p.entryTime,
      entryPrice: p.entryPrice,
      exitBar: i,
      exitTime: bar.t,
      exitPrice: exitFill,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      rDistance: p.rDistance,
      riskAmount: p.riskAmount,
      exitReason,
      grossPnl: rawPnl,
      costs,
      netPnl,
      r: p.riskAmount > 0 ? netPnl / p.riskAmount : 0,
      mfeR: p.mfeR,
      maeR: p.maeR,
      barsHeld,
      holdingMs: bar.t - p.entryTime,
      ambiguous,
      excluded,
      session: p.session,
      regime: p.regime,
      equityAfter: risk.equity,
      reasons: p.reasons,
    })

    if (ambiguous) ambiguousTrades += 1
    if (excluded) skippedTrades += 1
  }

  // ───────────────────────────────────────────────────────────── main bar loop
  for (let i = from; i <= to; i++) {
    const bar = candles[i]

    // 1. day roll (daily-loss limit needs a boundary even on days with no trades)
    risk = rollDay(risk, utcDayKey(bar.t))

    // 2. exits for positions already open before this bar
    if (positions.length) {
      const still: OpenPosition[] = []
      for (const p of positions) {
        if (p.entryBar === i) {
          still.push(p)
          continue
        }
        const outcome = resolveBar(
          bar,
          { side: p.side, stopLoss: p.stopLoss, takeProfit: p.takeProfit },
          config.intrabar,
          opts.fineByBar?.get(i),
        )
        if (outcome.kind === 'AMBIGUOUS_SKIP') {
          ambiguousBars += 1
          closePosition(p, i, p.stopLoss, 'AMBIGUOUS_SKIPPED', true, true)
          continue
        }
        if (outcome.kind === 'EXIT') {
          if (outcome.ambiguous) ambiguousBars += 1
          closePosition(p, i, outcome.price, outcome.reason, outcome.ambiguous, false)
          continue
        }
        // timeout
        if (p.timeoutAtBar !== null && i >= p.timeoutAtBar) {
          closePosition(p, i, bar.c, 'TIMEOUT', false, false)
          continue
        }
        still.push(p)
      }
      positions = still
      risk.openPositions = positions.length
    }

    // 3. entry fills — several can happen on one bar.
    //    The hedge baseline depends on this: both of its legs must open
    //    together, or it is not the strategy the user asked to have measured.
    //    Each pass marks one order non-PENDING, so the loop always terminates;
    //    the counter is a backstop, not the mechanism.
    let fillPasses = 0
    while (fillPasses++ < 64 && pending.some((o) => o.status === 'PENDING')) {
      const limit = checkLimits(risk, config.risk)
      if (!limit.allowed) {
        // A concurrency cap simply means "no more this bar" — the orders stay
        // working. Any other limit is a halt, and the book is pulled.
        if (limit.code !== 'MAX_POSITIONS') {
          const cancelled = cancelGroup(pending, null)
          if (cancelled.length) {
            limitStops.push({ bar: i, time: bar.t, reason: limit.reason })
          }
          rejections[limit.code] = (rejections[limit.code] ?? 0) + 1
        }
        break
      }

      const sel = selectEntry(pending, bar, config.intrabar, i)
      if (sel.skipped) {
        ambiguousBars += 1
        rejections['AMBIGUOUS_ENTRY_SKIPPED'] =
          (rejections['AMBIGUOUS_ENTRY_SKIPPED'] ?? 0) + 1
        cancelGroup(pending, null)
        break
      }
      if (!sel.order || !sel.trigger) break

      const o = sel.order
      const ctx = fillCtx(i)
      const entryFill = fillPrice(
        sel.trigger.rawPrice,
        o.side,
        o.type === 'MARKET' ? 'MARKET' : 'STOP_ENTRY',
        config.costs,
        ctx,
      )

      // Size from the PLANNED geometry — that is what could be known when the
      // order was placed. The realised risk after slippage is recorded below.
      const sizing = sizePosition({
        equity: risk.equity,
        entryPrice: o.type === 'MARKET' ? sel.trigger.rawPrice : o.price,
        stopLoss: o.stopLoss,
        side: o.side,
        instrument: config.instrument,
        risk: config.risk,
        atr: ind.atr[i],
      })

      if (!sizing.ok || sizing.qty <= 0) {
        o.status = 'REJECTED'
        o.reasons.push({ code: 'SIZING_REFUSED', message: sizing.reason, passed: false })
        rejections['SIZING_REFUSED'] = (rejections['SIZING_REFUSED'] ?? 0) + 1
        cancelOcoSiblings(pending, o)
        continue
      }

      const actualR = Math.abs(entryFill - o.stopLoss)
      if (actualR <= 0) {
        // Slippage carried the fill past its own stop. There is no trade here,
        // only an instant loss with no defined risk — refuse it.
        o.status = 'REJECTED'
        rejections['SLIPPED_THROUGH_STOP'] = (rejections['SLIPPED_THROUGH_STOP'] ?? 0) + 1
        cancelOcoSiblings(pending, o)
        continue
      }

      o.status = 'FILLED'
      o.filledBar = i
      o.filledPrice = entryFill
      o.qty = sizing.qty
      cancelOcoSiblings(pending, o)

      posSeq += 1
      positions.push({
        id: `pos_${posSeq}`,
        orderId: o.id,
        side: o.side,
        qty: sizing.qty,
        entryBar: i,
        entryTime: bar.t,
        entryPrice: entryFill,
        rawEntryPrice: sel.trigger.rawPrice,
        stopLoss: o.stopLoss,
        takeProfit: o.takeProfit,
        timeoutBars: o.timeoutBars,
        timeoutAtBar: o.timeoutBars !== null ? i + o.timeoutBars : null,
        rDistance: actualR,
        riskAmount: sizing.qty * actualR * config.instrument.pointValue,
        mfeR: 0,
        maeR: 0,
        entryCosts: commission(sizing.qty, config.costs),
        financingAccrued: 0,
        session: ind.session[i],
        regime: ind.regime[i] ?? { vol: 'MID_VOL', trend: 'RANGING' },
        tag: o.tag,
        reasons: [...o.reasons],
      })
      risk.openPositions = positions.length
    }

    // 4. a position opened on THIS bar can still be resolved by the same bar
    if (positions.some((p) => p.entryBar === i)) {
      const survivors: OpenPosition[] = []
      for (const p of positions) {
        if (p.entryBar !== i) {
          survivors.push(p)
          continue
        }
        const outcome = resolveBar(
          bar,
          { side: p.side, stopLoss: p.stopLoss, takeProfit: p.takeProfit },
          config.intrabar,
          opts.fineByBar?.get(i),
        )
        if (outcome.kind === 'AMBIGUOUS_SKIP') {
          ambiguousBars += 1
          closePosition(p, i, p.stopLoss, 'AMBIGUOUS_SKIPPED', true, true)
          continue
        }
        if (outcome.kind === 'EXIT') {
          if (outcome.ambiguous) ambiguousBars += 1
          closePosition(p, i, outcome.price, outcome.reason, outcome.ambiguous, false)
          continue
        }
        survivors.push(p)
      }
      positions = survivors
      risk.openPositions = positions.length
    }

    // 5. excursions + financing for whatever is still open
    if (positions.length) barsInPosition += 1
    for (const p of positions) {
      const ex = updateExcursions(bar, p.side, p.entryPrice, p.rDistance, p.mfeR, p.maeR)
      p.mfeR = ex.mfeR
      p.maeR = ex.maeR
      p.financingAccrued += financing(p.qty, 1, config.costs)
    }

    // 6. expire stale orders, then drop everything no longer working
    expireOrders(pending, i)
    for (const o of pending) if (o.status !== 'PENDING' && !orders.includes(o)) orders.push(o)
    pending = pending.filter((o) => o.status === 'PENDING')

    // 7. equity point — realised plus open-position mark-to-market, because a
    //    drawdown you are currently sitting in is still a drawdown.
    let unrealised = 0
    for (const p of positions) {
      unrealised += grossPnl(
        p.side,
        p.entryPrice,
        bar.c,
        p.qty,
        config.instrument.pointValue,
      )
    }
    const markEquity = risk.equity + unrealised
    peak = Math.max(peak, markEquity)
    equityCurve.push({
      t: bar.t,
      bar: i,
      equity: markEquity,
      drawdown: peak - markEquity,
      drawdownPct: peak > 0 ? ((peak - markEquity) / peak) * 100 : 0,
      peak,
    })

    // 8. evaluate the strategy at the close of bar i
    if (!risk.killed) {
      const decision = strategy.evaluate({
        i,
        candle: bar,
        candles,
        ind,
        positions,
        position: positions[0] ?? null,
        pendingOrders: pending,
        equity: risk.equity,
        params,
        instrument: config.instrument,
      })
      recordReasons(decision.reasons)

      for (const intent of decision.intents) {
        if (intent.kind === 'CANCEL') {
          cancelGroup(pending, intent.ocoGroup)
          continue
        }
        if (intent.kind === 'CLOSE') {
          const targets = intent.positionId
            ? positions.filter((p) => p.id === intent.positionId)
            : [...positions]
          for (const p of targets) {
            closePosition(p, i, bar.c, 'SIGNAL_CLOSE', false, false)
          }
          positions = positions.filter((p) => !targets.includes(p))
          risk.openPositions = positions.length
          continue
        }
        if (intent.kind === 'MOVE_STOP') {
          for (const p of positions) {
            if (intent.positionId && p.id !== intent.positionId) continue
            p.stopLoss = intent.stopLoss
          }
          continue
        }

        // PLACE
        const invalid = validateOrder(
          intent.side,
          intent.type,
          intent.price,
          intent.stopLoss,
          intent.takeProfit,
        )
        if (invalid) {
          rejections['INVALID_ORDER'] = (rejections['INVALID_ORDER'] ?? 0) + 1
          warnings.push(`Bar ${i}: ${invalid}`)
          continue
        }
        orderSeq += 1
        pending.push({
          id: `ord_${orderSeq}`,
          side: intent.side,
          type: intent.type,
          price: intent.price,
          stopLoss: intent.stopLoss,
          takeProfit: intent.takeProfit,
          timeoutBars: intent.timeoutBars,
          ocoGroup: intent.ocoGroup,
          createdBar: i,
          expiresAfterBars: intent.expiresAfterBars,
          status: 'PENDING',
          filledBar: null,
          filledPrice: null,
          qty: 0,
          tag: intent.tag,
          reasons: decision.reasons.filter((r) => r.passed),
        })
      }
    }

    if (opts.onProgress && (i - from) % progressEvery === 0) {
      opts.onProgress((i - from) / totalBars, i - from)
      if (opts.shouldAbort?.()) {
        warnings.push(`Aborted at bar ${i} of ${to}.`)
        break
      }
    }
  }

  // ── close anything still open at the end of the data, honestly labelled
  if (positions.length && to >= from) {
    for (const p of positions) {
      closePosition(p, to, candles[to].c, 'END_OF_DATA', false, false)
    }
    positions = []
  }
  for (const o of pending) {
    o.status = 'CANCELLED'
    orders.push(o)
  }

  const included = trades.filter((t) => !t.excluded)
  const metrics = computeMetrics(included, equityCurve, config.risk.startingEquity, {
    barsInPosition,
    totalBars,
  })

  // ── runtime invariants (V2 §6) — the engine checks its own books every run
  // and says so out loud if they do not balance. Never silent.
  {
    const ledgerSum = included.reduce((a, t) => a + t.netPnl, 0)
    const equityDelta = risk.equity - config.risk.startingEquity
    const tol = Math.max(1e-6, Math.abs(equityDelta) * 1e-9)
    if (Math.abs(ledgerSum - equityDelta) > tol) {
      warnings.push(
        `INVARIANT VIOLATION: trade ledger sums to ${ledgerSum.toFixed(8)} but equity moved ${equityDelta.toFixed(8)}. Do not trust this result — report this as a bug.`,
      )
    }
    for (const t of included) {
      if (t.costs < -1e-9) {
        warnings.push(
          `INVARIANT VIOLATION: trade ${t.id} has negative costs (${t.costs}). A cost model that pays you is a bug.`,
        )
        break
      }
      if (Math.abs(t.netPnl - (t.grossPnl - t.costs)) > 1e-6) {
        warnings.push(
          `INVARIANT VIOLATION: trade ${t.id} net ≠ gross − costs. Do not trust this result.`,
        )
        break
      }
    }
  }

  const ambiguity: AmbiguityReport = {
    ambiguousBars,
    ambiguousTrades,
    skippedTrades,
    policy: config.intrabar,
  }

  if (ambiguousTrades > 0) {
    const pct = (ambiguousTrades / Math.max(1, trades.length)) * 100
    warnings.push(
      `${ambiguousTrades} of ${trades.length} trades (${pct.toFixed(1)}%) hit stop and target inside the same bar. Their outcome was decided by the ${config.intrabar} policy, not by the data.`,
    )
    if (pct > 25) {
      warnings.push(
        'More than a quarter of trades are intrabar-ambiguous. The stop and target are too close together for this timeframe — load finer data or widen the levels before believing any of these numbers.',
      )
    }
  }
  if (metrics.trades > 0 && !metrics.sampleAdequate) {
    warnings.push(
      `Only ${metrics.trades} trades. Below ${metrics.sampleThreshold} the metrics are not statistically meaningful — treat every number here as a rough hint, not a measurement.`,
    )
  }
  if (metrics.trades === 0) {
    warnings.push(
      'No trades were taken. The rejection breakdown shows which filter blocked every setup.',
    )
  }

  return {
    snapshot: {
      config,
      datasetId: dataset.id,
      datasetHash: dataset.hash,
      symbol: dataset.symbol,
      timeframe: dataset.timeframe,
      bars: totalBars,
      from: candles[from]?.t ?? 0,
      to: candles[to]?.t ?? 0,
      engineVersion: ENGINE_VERSION,
      computedAt: Date.now(),
    },
    trades,
    equityCurve,
    orders,
    metrics,
    ambiguity,
    rejections,
    limitStops,
    warnings,
    durationMs: Date.now() - startedAt,
  }
}
