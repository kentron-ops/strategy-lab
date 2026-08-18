# Strategy Lab — Personal Edition

A personal, offline-first research instrument for measuring trading edge honestly.
**Simulation only. No real orders. No profit promises.**

## V2: Strategy Compiler + Edge Prover

- **Strategy Compiler** — assemble strategies from typed rule blocks
  (indicators, comparators, sessions, AND/OR) into serializable `StrategySpec`
  JSON. The 3 built-in strategies ship as specs too; the compiled preset
  reproduces the reference implementation **trade for trade** (tested).
- **Edge Prover** — 7 gates (out-of-sample CI, purged/embargoed walk-forward,
  neighbourhood robustness, Monte Carlo, sample adequacy + outlier dependence,
  cost stress, forward test) plus statistical guards: **trials-adjusted
  p-value** (Šidák over every configuration you tried), bootstrap expectancy
  CI, random-entry benchmark with the candidate's own exits, buy-and-hold
  benchmark, and pre-registered AcceptIf thresholds whose revisions are
  recorded, not hidden. Verdicts: `PROVEN` / `INSUFFICIENT_EVIDENCE` /
  `NOT_PROVEN` with a confidence grade. The word "certain" never appears
  (tested).
- **Library** — proven specs stored with their evidence cards; scatter of
  expectancy vs max drawdown.
- **Three trust locks** (all green):
  1. 238 tests: golden fixtures, property-based (fast-check), no-look-ahead
     proof, runtime invariant self-checks in every run.
  2. **Independent second engine**: `scripts/differential/compare.py` reruns
     the exported strategy with Python `backtesting.py` on the same CSV —
     trade lists match exactly (0 mismatches, tolerance documented).
  3. Every metric has `show the math` (formula + exact inputs) and the ledger
     exports to CSV for hand recomputation.
- **Backend-ready** — all heavy jobs route through `ComputeAdapter`
  (local Web Workers today; see `docs/BACKEND_CONTRACT.md` for the drop-in
  REST mapping a backend developer implements later).

> There is no certain profitable signal. What this app gives you instead:
> measured edge, probability with confidence intervals, exact risk control, and
> machine-enforced discipline. If a screen ever shows "certainty", it is a bug.

## What it does

- **Backtest** rules over OHLC data with realistic costs (spread, commission,
  slippage, financing), an explicit order state machine, and honest intrabar
  ambiguity handling (`CONSERVATIVE` / `OPTIMISTIC` / `SKIP_AMBIGUOUS`).
- **Prove no look-ahead**: a dedicated test corrupts the future and asserts the
  past does not move.
- **Risk engine** independent of any strategy: fixed-fractional, fixed-cash,
  volatility-normalized and capped fractional-Kelly sizing, daily loss limits,
  consecutive-loss limits, equity-floor kill switch.
- **Optimize responsibly**: parameter sweeps in a Web Worker, chronological
  in-sample/out-of-sample splits, walk-forward analysis, neighbourhood
  robustness (`FRAGILE` / `MORE_ROBUST`), Monte Carlo on the trade sequence —
  all with `POSSIBLE_OVERFIT` flags and sample-size guardrails.
- **Journal** with reconciliation against real market data, behavioural leak
  tags (revenge trades, moved stops, overtrading…), and the
  strategy-vs-mechanical gap.
- **Recommend**: a setup scanner over a book of measured expectancies — ranked
  by risk-adjusted expected value, never by hope. Setups below the evidence
  floor say "insufficient evidence" instead of hiding.
- **Replay & shadow trading** driven by the exact same engine as the backtester.
- **PWA**: installs on phone/desktop from one URL, fully offline after first load.

## Shipped strategies

| Strategy | Role |
| --- | --- |
| Simultaneous hedge | The baseline. Directionally neutral by construction; pays entry costs twice. Exists to be measured, not believed. |
| OCO breakout | The honest version of the same idea — cost paid once. |
| Breakout continuation | OCO + deterministic qualifiers (ATR percentile, range expansion, body, session, HTF alignment), each measured separately. |

## Run it

```bash
npm install
npm run dev        # local dev server
npm test           # 204 tests: accounting, orders, intrabar, risk, no-look-ahead…
npm run build      # static PWA build in dist/
```

Opens with a clearly-labelled **synthetic** sample dataset so it works with zero
downloads. Any edge found on synthetic data is an artefact of the generator.

## Getting real data (free)

- **Crypto**: exchange public REST/WebSocket endpoints work directly from the
  browser, no key (the built-in WebSocket adapter uses this).
- **XAU/FX history**: Dukascopy historical exports and similar free CSV sources
  → import via drag-and-drop (`timestamp,open,high,low,close,volume`, volume
  optional). Set the timezone offset at import; it is recorded on the dataset.
- **Live XAU/FX**: free-tier REST providers with your own key (stored locally,
  never shipped). Feeds are rate-limited and delayed; the UI labels latency.

## Architecture

```
UI (React, thin) → zustand store (dependency graph) → workers → core (pure TS)
core/  data · marketdata (adapters) · strategy · indicators · execution
       risk · backtest · optimization · journal · recommend · replay
```

Core has zero React imports and zero DOM access — it runs in a Web Worker and
in Node tests. Every external dependency sits behind an interface
(`MarketDataAdapter`, `StorageAdapter`, `NotifierAdapter`, `ExecutionAdapter` —
interface only, deliberately no implementation).

## Deploy (Vercel)

Import the repo in Vercel; `vercel.json` is already configured
(`vite` framework, `dist` output, SPA rewrites, immutable asset caching).
Netlify or GitHub Pages work the same way — the build is fully static.

## Honesty rules baked in

- Every probabilistic number carries its sample size and confidence interval.
- Below 30 trades, headlines are stamped *not statistically meaningful*.
- Ambiguous intrabar outcomes are counted and reported, never silently resolved.
- Rankings demote inadequate samples regardless of raw score.
- Monte Carlo output is labelled "not a prediction of the future."
- `SIMULATION ONLY` wherever equity is shown. No real-order code exists.
