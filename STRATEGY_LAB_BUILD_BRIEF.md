# Strategy Lab — Personal Edition

## Master Build Brief for Claude Code

> Working title: **Strategy Lab** (gold-first, market-agnostic under the hood)
>
> Audience: one person, personal use, never published, no auth, no multi-user, no payments.
>
> Target: a single static build that installs and runs on any laptop or phone with nothing else required, works offline, and can grow into a live, market-connected research and decision assistant without a rewrite.
>
> This document is the single source of truth. Give it to Claude Code as the build spec. It also contains the things the requester did not think to ask for, each placed where it belongs in the architecture.

---

## 0. The one honest principle this whole app is built on

There is no such thing as a certain profitable signal. Markets do not allow certainty. What is real and achievable:

- **Measured edge**: does a rule make money after realistic costs, on data it has never seen.
- **Probability**: given a setup, how often the good outcome happened historically, with a confidence interval.
- **Risk control**: never lose more than a defined amount, size every position from that amount.
- **Discipline**: remove emotional and behavioral error by making the machine enforce the rules.

The app's core value is making uncertainty **visible and controllable**. If any screen ever displays "certainty" or a naked profit promise, it is a bug. Every probabilistic output must carry its sample size and a confidence range. This principle overrides every feature below.

### 0.1 Why uncertainty cannot be made certain, and how the app maximizes probability instead

Certainty on the reward side is impossible in principle, not just in practice, for four reasons:

- **Reflexivity**: a truly certain edge would be traded by everyone until it vanished. Any edge that survives does so because it stays uncertain. Certainty self-destructs through arbitrage.
- **Non-stationarity**: the market's behavior changes over time (policy, structure, regime), so a past probability is an estimate of a moving target, not a fixed constant.
- **Irreducible noise**: at short horizons price is mostly random; signal to noise is low.
- **Fat tails**: rare events dominate P&L and can never be fully sampled from history.

So the app never chases certainty of profit. It chases the highest honest probability-weighted reward, using the levers that actually raise it:

1. A bigger, cleaner sample tightens the confidence interval around the true edge.
2. **Conditioning** raises probability: an unconditional edge of 51% can become 62% once you condition on regime, session, and volatility. This is the single most powerful honest lever, and the expectancy book in section 12 is built on it.
3. **Asymmetric payoff** beats a high win rate: 40% at 3R crushes 60% at 1R. Optimize expectancy, never win rate.
4. **Confluence** of independent, separately validated filters raises the joint probability, as long as the filters are genuinely independent and not overfit.
5. **Fractional-Kelly sizing** converts a measured edge into the mathematically maximum long-run growth for a chosen risk tolerance. This is the real meaning of "maximize."
6. **Survival first**: the highest-probability path to compounding is never being ruined, because expected value is worthless if you are liquidated before it arrives.

The reframe that resolves the whole question: you can never make the reward certain, but you can make the loss certain, because you decide the loss and the market decides the reward. Certainty is available only on the downside. The app bounds the downside exactly and maximizes the probability-weighted upside, then keeps re-measuring, because every edge decays. An edge that suddenly looks certain is usually either overfit or already dying, so the app treats rising apparent certainty as a warning, not a trophy.

---

## 1. What the user can test and what they get

### With open-source historical data (available today)

Load OHLC candles for XAU/USD or any instrument and answer, quantitatively:

1. Does a rule have positive expectancy after spread, commission, and slippage.
2. Which parameters actually drive profit and which are noise (sensitivity analysis).
3. Does the edge survive on unseen data (out-of-sample and walk-forward).
4. What is the realistic worst case (max drawdown, worst losing streak, Monte Carlo tail).
5. Are exits too early or stops too tight (MFE / MAE distribution).
6. When does the edge work and when does it die (by session, volatility regime, day of week).
7. How does the original simultaneous long+short hedge idea compare to a clean OCO breakout (baseline vs candidate).

### With live data (later, via adapter, no rewrite)

8. Paper-trade the same rule on live candles with the exact same engine (shadow trading).
9. Get an alert when a pre-defined setup appears, with its historical expectancy and a plain-language reason.
10. Reconcile a manually kept trade journal against real market data to catch misremembered or mis-logged trades.

The deliverable of the app is never "gold will go up." It is always "this rule, on this data, produced this expectancy with this confidence and this risk."

---

## 2. Non-negotiable constraints

- Runs on any laptop or phone, no install of tooling by the user.
- No backend, no database server, no API key required to start, no login, no cloud dependency to boot.
- Fully offline after first load.
- Installable as a PWA (add to home screen on phone, standalone window on desktop).
- All state persisted locally (IndexedDB). Export and import everything as JSON files so the user owns their data and can move it between devices.
- Every external dependency sits behind an interface so a programmer can upgrade it later without touching core logic. This is the single most important architectural rule.
- Core logic (data, strategy, execution, risk, backtest, metrics, optimization) is pure TypeScript with zero React imports and zero DOM access. It must be runnable in a Web Worker and in a unit test with no browser.

### Why PWA and not a single HTML file

A single self-contained HTML file is the simplest "runs anywhere" story, but charts, Web Workers, and heavy compute make a bundled PWA the correct choice: it still installs from one URL, runs offline, and behaves like a native app on phone and desktop. Ship the PWA as primary. Optionally also produce a single-file build of the core calculators as a fallback the user can email to themselves.

---

## 3. Architecture (the spine)

```
UI (React)  ── thin, no business logic ──────────────┐
                                                      │
reactive store (signals) ── holds config + results ── │
                                                      │
┌───────────────────────── core (pure TS) ───────────┘
│  data/         csvLoader, validators, normalization, resample
│  marketdata/   MarketDataAdapter (interface)
│                  CSVAdapter, ReplayAdapter,
│                  WebSocketAdapter (crypto), RestPollAdapter (fx/xau w/ user key),
│                  TradingViewWebhookAdapter (future, needs relay)
│  strategy/     StrategyInterface, simultaneousHedge, ocoBreakout,
│                  breakoutContinuation, (user strategies)
│  indicators/   atr, ema, rsi, adx, rollingHighLow, session, regime
│  execution/    orderStateMachine, intrabarPolicy, costModel
│  risk/         riskEngine, positionSizing, portfolioEquity, limits
│  backtest/     backtestEngine, tradeLedger, metrics
│  optimization/ parameterSweep, walkForward, scoring, robustness, monteCarlo
│  journal/      journalStore, reconcile, behaviorTags, analytics
│  recommend/    setupScanner, expectancyBook, ranking, explain
│  replay/       replayEngine (drives paper + shadow trading)
└──────────────────────────────────────────────────────
workers/  backtest.worker, optimizer.worker  (via Comlink)
storage/  StorageAdapter (interface) -> IndexedDbAdapter (Dexie)
```

Adapter interfaces to define from day one, even if only one implementation exists:

- `MarketDataAdapter`: `getHistory(symbol, timeframe, range)`, `subscribe(symbol, timeframe, onCandle)`, `capabilities()`.
- `StorageAdapter`: get, set, list, delete, export, import.
- `ExecutionAdapter` (interface only for now): placeOrder, modify, cancel, positions. No implementation in this version.
- `NotifierAdapter`: browser notification now, webhook/telegram later.

Everything the user "did not see" plugs into one of these boxes. When a new need appears, it becomes either a new adapter implementation or a new module inside core, never a patch inside a React component.

---

## 4. Data layer

### Import (works today)

- CSV drag and drop plus file picker.
- Schema: `timestamp,open,high,low,close,volume` with volume optional.
- Robust timestamp parsing, explicit timezone interpretation, sorting.
- Validation with a visible data-quality report before any backtest:
  - `high >= max(open,close)`, `low <= min(open,close)`, `high >= low`
  - duplicate timestamps, missing candles (gaps), zero or negative prices, frozen candles.
- Resampling: build higher timeframes from a base timeframe so multi-timeframe features are possible.
- Ship a small clearly-labeled synthetic sample dataset so the app is usable on first open with zero external data.

### Where to get free open data (put this in README, not hardcoded)

- Crypto: exchange public REST and WebSocket (usable directly from browser, no key).
- FX and XAU historical: free tiers of providers that allow browser fetch with the user's own key (stored locally). Dukascopy historical exports and other free CSV sources for gold also work via the CSV path.

### Live data (the honest design)

`MarketDataAdapter.capabilities()` tells the UI what a source can do, so the interface adapts to reality instead of pretending.

- `WebSocketAdapter` for crypto: real live candles in-browser, no backend, no key. This is the cleanest live demo and should be the first live adapter built.
- `RestPollAdapter` for XAU and FX: polls a provider with the user's free API key from localStorage. Honest limitation: free tiers are rate-limited and delayed, so label the feed latency in the UI.
- `TradingViewWebhookAdapter`: future only. TradingView has no public pull API. It can only push on alerts via webhook, which requires a small relay to receive. Mark it clearly as "requires a relay service" so the no-backend promise stays true for the base app.

The UI must never assume live data exists. It degrades gracefully to CSV and replay.

---

## 5. Strategy engine

Strategies are serializable JSON, not hardcoded. Three shipped strategies:

- **A. Simultaneous hedge baseline** — proves and measures the original idea, used only as a comparison floor.
- **B. OCO breakout** — buy stop and sell stop around a reference, cancel the opposite on trigger, then manage stop, target, timeout.
- **C. Breakout continuation** — B plus deterministic qualifiers (ATR threshold, lookback range, range expansion, session filter, minimum candle body).

Strategy interface must expose: `evaluate(context) -> Decision`, where Decision carries an action and a machine-readable `reason[]` array for both taken and rejected signals. No black boxes.

Every strategy config is versioned and snapshotted into each backtest so results are reproducible.

---

## 6. Backtest engine (highest priority, build and test first)

- Processes candles strictly chronologically.
- Never inspects future candles. A dedicated automated test must prove candle N+1 cannot influence the decision at candle N.
- Explicit order and position state machine; every transition recorded.
- Models long and short, pending orders, OCO cancellation, stop, target, timeout.
- Cost model: spread, commission, slippage, optional financing.
- Produces a deterministic trade ledger.

### Intrabar ambiguity (the credibility feature)

When one candle touches both stop and target, OHLC alone cannot say which came first. Never silently pick the profitable path. Implement three policies: `CONSERVATIVE` (default, assume adverse first), `OPTIMISTIC`, `SKIP_AMBIGUOUS`. Report ambiguous candle and trade counts in every result. Optionally allow loading a finer timeframe to resolve ambiguity precisely.

---

## 7. Risk engine (independent of strategy)

- Inputs: starting equity (default 200), risk percent per trade (default 1), stop distance, instrument config.
- Outputs: max allowed loss, suggested position size, effective risk.
- Position sizing methods: fixed fractional (default), fixed cash, volatility-normalized, and a capped fractional-Kelly option shown with a loud warning about its variance.
- Limits: max daily loss, max concurrent positions, max consecutive losses, equity floor, refuse trade if required size is invalid.
- Liquidation is never a stop. Risk is always explicit.
- Broker economics (contract size, lot step, point value, margin) are optional. Default to normalized R-space so the app stays broker-agnostic. Never invent broker-specific numbers; make them configurable.

---

## 8. The live, connected result surface (this is what the user asked hardest for)

The requester wants: see every parameter that matters for a decision, see the relationships between parameters and results, control everything, and when they change one thing the whole result set and every related parameter updates instantly. This is a **reactive computation graph**, and it is a first-class feature, not a nice-to-have.

Design it like this:

- The strategy config, risk config, and cost config are the **inputs**. Every metric is a **derived value** in a dependency graph.
- Changing any input recomputes only the affected downstream values, incrementally, in a Web Worker, and streams updates back to the UI so the screen never freezes.
- Every result shows **what drives it**. Example: hovering expectancy reveals its formula and the three inputs with the largest marginal effect. Clicking a parameter highlights every metric it influences.
- A **sensitivity panel**: for the current config, show the local gradient of each key output (expectancy, profit factor, max drawdown, return over drawdown) with respect to each parameter, so the user sees which knob moves profit and which is noise. This is the honest antidote to random fiddling.
- A **relationships view**: a small graph or matrix showing parameter to result links and parameter to parameter coupling (for example stop distance couples to position size couples to risk per trade).
- Live status everywhere: recompute progress, dataset in use, cost assumptions in force, intrabar policy in force, sample-size adequacy, and an "out of date" shimmer on any metric still recomputing.

Metrics to compute and display (each with sample size where probabilistic):

```
Starting Equity, Ending Equity, Net P&L, Return %
Trades, Wins, Losses, Win Rate (with confidence interval)
Average Win, Average Loss, Average R, Expectancy (per trade and per R)
Profit Factor, Max Drawdown, Max Drawdown %
Best Trade, Worst Trade
Max Consecutive Wins, Max Consecutive Losses
Average Holding Time, Exposure %
Gross P&L, Total Costs, Cost as % of Gross Profit
Sharpe, Sortino (labeled with sampling assumptions, never as headline)
```

Guardrails that must be visible, not buried:

- **Sample-size warning**: below a threshold of trades, stamp results "not statistically meaningful" and grey the headline. A gorgeous equity curve on 22 trades is a mirage and the app must say so.
- **Cost sensitivity**: show net vs gross so the impact of costs is always visible; let the user push spread and slippage up and watch the edge survive or die.

---

## 9. Optimization done responsibly

- Parameter sweep over ranges (breakout, stop, target, lookback, filters) in a Web Worker, UI stays responsive.
- Ranking never by net profit alone. Offer expectancy, profit factor, return over drawdown, max drawdown, trade count, and a stability score.
- Heatmap for any two chosen dimensions.
- **Overfitting protection is mandatory**, not optional:
  - chronological in-sample / out-of-sample, default 70/30, never shuffle time series.
  - **walk-forward** analysis (rolling train then test windows) as the honest upgrade over a single split.
  - flag strong train and weak test as `POSSIBLE OVERFIT`.
- **Robustness**: for a top parameter set, test the neighborhood. If neighbors fail, mark `FRAGILE`; if a broad region holds, mark `MORE ROBUST`. Never present either as a guarantee.
- **Monte Carlo** on the trade sequence: distribution of ending equity, drawdown distribution, probability of hitting an equity floor, consecutive-loss distribution. Explicitly labeled as "not a prediction of the future."

---

## 10. Replay, paper, and shadow trading

- Candle-by-candle replay driven by the **same** core engine (no separate fake logic). Controls: play, pause, step, speed, reset.
- Event Path Explorer: click any trade to see its lifecycle candle by candle with entry, stop, target, MFE, MAE, exit, and the reason array, highlighted on the chart.
- Shadow trading: point the ReplayAdapter or a live adapter at current data and let the engine emit WAIT / LONG / SHORT / HOLD / CLOSE in real time without sending any order. This is how the user validates a strategy forward before risking anything, and it is the bridge to any future live use.

---

## 11. The Journal (first-class module, and a standalone product in its own right)

The requester asked to be convinced the journal actually meets what real traders need, how it can be trustworthy, whether it checks data live, and how it gives more feedback than asked. Here is the case and the spec.

### What serious traders actually need from a journal (and this covers)

- Frictionless capture: import broker statement or CSV, or log a trade in seconds. Manual-only journals die from friction, so import is the default path.
- Truthful accounting: R multiple per trade, fees included, equity curve, drawdown, expectancy, all the metrics from section 8, computed the same way as the backtester so backtest and reality are directly comparable.
- Diagnosis, not just recording: MFE / MAE so the trader sees "you leave 1.2R on the table on average" or "your stops are too tight." Breakdown by session, day of week, instrument, setup tag, hold time, and by whether they followed their own rules.
- Behavioral tags: overtrading, revenge trade, moved stop, entered on high spread, traded outside plan hours. This is where most retail money actually leaks, and surfacing it is the highest-value thing a journal does.

### How it can be trustworthy (the live data check)

- **Reconciliation**: for each logged trade, the journal fetches the market's real OHLC for that window via `MarketDataAdapter` and verifies the entry, exit, high, and low are plausible. It flags trades whose logged prices could not have occurred, catching both honest misremembering and self-deception. This is the "check the data live" feature and it is what makes the journal honest rather than a diary.
- Everything is reproducible and exportable, so the user can audit their own numbers.

### Feedback beyond what was asked (the "tell me a better way" part)

Two layers, both rules-and-stats based, no oracle:

- **On the strategy the user is running**: quantify it. "Your win rate is 41% but your average win is only 0.9R, so expectancy is negative. Two honest fixes: widen the target toward the MFE your winners actually reach, or cut the trades in the lowest-expectancy session." Every suggestion is tied to the user's own numbers and shown with its expected effect and sample size.
- **Toward a safer, more optimal approach**: compare the user's realized behavior to the same rules run mechanically in the backtester. The most common finding for retail traders is that the mechanical version beats the human version because the human overtrades and moves stops. Showing that gap, in the user's own money, is the strongest and most defensible feedback the app can give.

### Why the journal can be a standalone product later

It needs only: data import, the metrics engine, the reconciliation adapter, and the analytics UI. It reuses the exact same core as the lab. So the same codebase yields both the personal lab and, if ever wanted, a shareable journal, by exposing a different set of screens over the same core. No fork required.

### Turning the journal into a sold product (recommended path)

The journal is the strongest commercial idea in this project, because it is analytics rather than signals: real demand, low legal risk, no profit promise, and it reuses this exact core. If it is ever sold, the honest form is a hosted web app, not a bot.

- **Web app, yes.** Ship the personal version first and prove it on real trading. To sell it, add three things that already have a home behind existing interfaces: auth and cloud storage (swap the StorageAdapter for a cloud one) and payments (a thin hosted auth-plus-billing layer). Nothing in core changes.
- **Bot, only as a companion.** A journal's value lives on a screen, so a standalone journal bot is weaker than a web app. A bot is good for two narrow jobs: fast trade capture ("log XAUUSD long 2341 sl 2337") and alerts, both behind the NotifierAdapter. Build it later as a companion, never as the product.
- **What makes it sellable and trustworthy.** The two features that separate it from every dead journal on the market are already specced: reconciliation against real market data so the numbers cannot be fudged, and the strategy-versus-mechanical gap so it tells the user something they could not see themselves. Lead the product on those.
- **Positioning and safety.** Sell it as analytics and discipline. Never attach a profit claim or a signal, which is what invites liability and app-store or ad rejection.

Sequence: personal lab and journal now, prove it, then spin the journal out as a hosted web product, then add a capture-and-alert bot as a companion. Do not start with the bot.

---

## 12. The recommendation "brain" (honest design of the thing the user is really chasing)

The user wants a machine that gives the highest-probability profitable action. The honest, buildable version of that is not an oracle. It is a **setup scanner over a book of measured expectancies**:

1. The user defines setups as rules (via strategy configs), same as the lab.
2. The backtester builds an **expectancy book**: for each setup, in each regime and session, the historical P(target before stop), expectancy in R, sample size, and confidence interval.
3. Live or on replay, the `setupScanner` watches for those setups. When one appears, it emits a ranked recommendation:
   - action, entry, stop, target, size (from the risk engine)
   - historical expectancy and confidence, with sample size
   - the regime and session it is in, and whether that context historically helped or hurt
   - a plain-language `reason[]` and the single biggest risk to this specific setup
4. Ranking is by risk-adjusted expected value, never by raw hope. Setups below a confidence or sample-size floor are shown as "insufficient evidence," not hidden and not dressed up.

The machine's explicit outputs, exactly as the user defined them:

- **Measure edge**: for every setup, expectancy in R with a confidence interval and sample size.
- **Rank and sort**: order all live and candidate setups by risk-adjusted expected value, so the best opportunity is always on top.
- **Which is better and how certain**: a side-by-side comparator that states, with reasons, why setup X beats setup Y, and attaches a confidence grade built from sample size plus out-of-sample stability plus neighborhood robustness. Higher certainty is shown as a grade, never claimed as absolute.
- **Reasoned risk control**: for the chosen setup, a concrete size and stop from the risk engine with the reason stated. Example: "size 0.10 because a 1R stop at this ATR risks exactly 1% of equity; skip if spread exceeds X because it historically halved this setup's expectancy."
- **Best scenarios under uncertainty**: for the current setup, a ranked bull / base / bear scenario set with probability weights, a value per scenario, and the probability-weighted expected value, so the most profitable honest outcomes and their odds sit side by side.
- **Edge-decay monitor**: every setup carries a live status of whether its recent expectancy is holding, drifting, or dying versus its historical baseline. Rising apparent certainty is flagged for possible overfit or crowding, not celebrated.

Optional AI assist, clearly fenced:

- An LLM may be used to **turn a fuzzy human idea into candidate rules** ("gold pops after London opens once the Asian low is swept") and to **explain results in plain language**. It is never in the buy/sell path. The numeric engine always judges. This separation is a hard rule.

What this gives the user honestly: a disciplined, always-on assistant that spots their own validated setups, sizes them correctly, refuses low-evidence trades, and explains itself. That is the real version of "a brain for profitable decisions." The word "certain" never appears.

---

## 13. Everything the user did not mention, mapped to where it lives

Each item below is a real gap in the original thinking. The point of listing them is that the architecture already has a home for each, so they can be added when needed without redesign.

- **Spread realism and variable spread** (costModel): gold spread widens at news and session open; allow time-varying spread, not a constant.
- **Slippage as a function of volatility** (costModel): fixed slippage flatters fast markets.
- **Session and regime tagging** (indicators + regime): Asian/London/NY, and low-vol/high-vol/trending/ranging. Most edges are regime-specific; without this you average a real edge into nothing.
- **News and event blackout** (strategy filter + NotifierAdapter): block or shrink trades around scheduled high-impact events.
- **Multi-timeframe context** (data resample): higher-timeframe trend as a filter for a lower-timeframe entry.
- **Correlation and portfolio equity** (risk/portfolioEquity): if you ever run more than one instrument or strategy, risk is not additive; track combined equity and correlated exposure.
- **Benchmark comparison** (metrics): compare strategy equity to simple buy-and-hold and to a random-entry baseline with the same risk, so you know the edge is real and not just market drift.
- **Data provenance and reproducibility** (data + backtest snapshot): store the dataset hash, timezone, and a seed with every result so a number can always be reproduced.
- **Survivorship and gap handling** (validators): weekends, holidays, and feed gaps distort results; detect and report them.
- **Execution-quality logging** (future ExecutionAdapter + journal): signal time vs fill time vs fill price, so you learn whether a paper edge dies in real execution. This is where latency actually matters, and not before.
- **Latency reality check** (docs): for 1m to 15m strategies, 20ms vs 100ms is irrelevant. Do not spend a day on colocation until an edge is proven latency-sensitive. Write this down so nobody wastes weeks on it.
- **Strategy versioning and a forward-test lock** (strategy store): once a strategy passes out-of-sample, lock it and only judge it on data after the lock date, so you cannot secretly re-fit.
- **Kill switch and equity floor** (risk): a hard stop on cumulative loss, always on.
- **Behavioral leak detection** (journal/behaviorTags): the biggest retail money leak is psychological, not analytical.
- **Alerting** (NotifierAdapter): browser notification now; webhook, email, telegram later, each behind the same interface.
- **Accessibility and phone ergonomics** (UI): this must be usable on a phone with one thumb, since that is a stated target.

---

## 14. Design system and UX (advanced capability, extreme simplicity)

Direction: a research instrument, not a casino. Restrained, modern, quiet typography, strong hierarchy, dense but readable quantitative information, explicit uncertainty. No decoration for its own sake.

- **Motion (GSAP)**: micro-interactions only, in service of comprehension. Value transitions animate so a changed number is noticed. Recompute states shimmer. Trade path draws along the chart during replay. Nothing bounces, nothing celebrates profit.
- **WebGL, minimal, only where dataviz genuinely benefits**: the equity-and-drawdown surface, the parameter heatmap, MFE/MAE density clouds, and the Monte Carlo fan. These are cases where thousands of points must render smoothly and Canvas or SVG would choke. Everywhere else use plain DOM and a proper financial chart library for candles. WebGL is never used for background eye-candy.
- **Every element gets design feedback and explicit state**: every label has a tooltip that defines it and its formula; every metric has loading, empty, error, stale, and "insufficient sample" states; live statuses (feed latency, recompute progress, data quality, risk-limit proximity) are always visible and never silent.
- **Uncertainty is a visual primitive**: confidence intervals, sample-size badges, and "possible overfit" flags are part of the design language, not footnotes.
- **The recommendation surface has its own visual grammar**: a ranked setup list sorted by risk-adjusted expected value, a better-versus-worse comparator with a visible confidence grade, a bull/base/bear scenario fan with probability weights, and an edge-decay status chip (holding, drifting, dying) on every setup. These are core screens, designed with the same restraint as the rest, never dramatized.
- Light and dark, both first-class. `SIMULATION ONLY` persistent label whenever equity or P&L is shown.
- Views: LAB, RESULTS, TRADES, REPLAY, OPTIMIZE, JOURNAL, DATA. Minimal routing.

The bar: a newcomer can run a backtest in three clicks, and an advanced user can reach every parameter and every relationship without a manual.

---

## 15. Everything Claude Code needs to build this (the ask list)

Give Claude Code these, and it can build end to end.

### Tech stack (recommended, minimal)

- React + TypeScript + Vite
- PWA via `vite-plugin-pwa` (offline, installable)
- Charts: `lightweight-charts` for candles
- Reactive state: a signals library or Zustand, wired as the dependency graph in section 8
- Workers: `comlink` for backtest and optimizer workers
- Storage: IndexedDB via `dexie`
- Motion: `gsap`
- WebGL: `regl` or raw WebGL2, only for the four dataviz cases above
- Tests: `vitest`
- Optional AI assist: a pluggable LLM call behind an interface, off by default, key stored locally

### Decisions to hand Claude Code (defaults are fine, document them)

- Base timeframe and instrument for the sample dataset (default XAU/USD 5m synthetic).
- Default costs (spread, commission, slippage) as configurable, not invented.
- Intrabar default CONSERVATIVE, in-sample/out-of-sample default 70/30.

### Inputs the user should provide for it to be genuinely useful

- One or more real XAU/USD (or chosen instrument) historical CSVs.
- The trader friend's actual strategy written as explicit rules (entry, exit, stop, filters). Without this, the app is a correct engine with nothing meaningful to test.
- If live is wanted early: a free market-data provider API key, or start with a crypto WebSocket where no key is needed.

### The prompt to give Claude Code

Hand over this whole file and say: build V1 in the phase order in section 16, core and tests before any UI polish, keep all core logic pure and worker-runnable, define every adapter interface up front even with one implementation, and stop and ask only if genuinely blocked; otherwise pick sensible defaults and document them.

---

## 16. Build order

1. **Core and tests**: types, data model, CSV loader and validators, indicators, strategy interface, order state machine, cost model, risk engine, backtest engine, trade ledger, metrics, and the full test suite (accounting, orders, intrabar, risk, look-ahead). No UI yet.
2. **Reactive result surface**: the dependency graph, live recompute in a worker, metrics UI, equity and drawdown, sample-size and cost guardrails.
3. **Chart, strategy builder, trade explorer, replay, event path.**
4. **Optimize**: sweep, walk-forward, heatmap, robustness, Monte Carlo.
5. **Journal**: import, reconciliation via market data, analytics, behavioral tags, strategy-vs-mechanical gap.
6. **Live adapters**: crypto WebSocket first (no key), then REST poll with user key, then shadow-trading and the setup scanner and expectancy book.
7. **Design pass**: GSAP micro-interactions, the four WebGL dataviz surfaces, full state coverage, PWA polish, phone ergonomics.

Do not optimize any strategy until the engine and accounting tests pass. If the original hedge idea performs poorly, show it truthfully.

---

## 17. Acceptance criteria

- Installs and runs offline on desktop and phone from one URL, no keys required to boot.
- CSV import, dataset validation, and the sample dataset all work.
- All three strategies run; trade ledger, equity curve, drawdown, expectancy, profit factor, win rate, max drawdown, average R computed.
- Change any input and every dependent result and parameter updates live, with visible recompute status.
- Sensitivity and relationships views work; sample-size and cost guardrails are visible.
- Intrabar policy explicit and reported; no look-ahead (proven by test).
- Walk-forward and out-of-sample comparison work; overfit and fragility flags appear.
- Replay and event path work off the same engine as the backtest.
- Journal imports trades, reconciles them against market data, and produces the strategy-vs-mechanical gap.
- At least one live adapter (crypto WebSocket) streams live candles with no backend.
- Strategy JSON export/import and full local persistence work.
- `SIMULATION ONLY` visible wherever equity is shown. No real-order execution code exists.
- Production build is static and PWA-installable.

---

## 18. If you wanted an AI to analyze markets live and tell you the best profitable moves — what to actually ask for, and how it differs

The instinct is to ask an AI: "watch the market and tell me when to buy gold." That request cannot be satisfied honestly, because a correct answer would require certainty that does not exist, and because a single opaque call teaches you nothing and cannot be audited.

What to ask for instead, in order of value:

1. **Turn my idea into a testable rule.** "I think gold continues after a London-open sweep" becomes explicit, falsifiable conditions.
2. **Measure it.** Run it over years of data with realistic costs and tell me its expectancy, confidence, and how it behaves out-of-sample and across regimes.
3. **Watch for my validated setups and alert me with evidence.** Not "buy now," but "your setup S03 just triggered; historically 2.4R before 1R happened 58% of the time in this session over 180 samples; the biggest risk here is the news print in 40 minutes."
4. **Enforce my risk.** Refuse or resize anything that breaks my rules. Never let me risk more than I decided when calm.
5. **Show me my own leaks.** Compare what I did to what my rules said, in my own money, and name the behavior that cost me.

How this differs from an oracle: the oracle is asked for the answer; this assistant is asked to quantify edge, surface probability, control risk, and remove my error. The oracle would have to be right about the future; the assistant only has to be honest about the past and disciplined in the present, and that is enough to compound. The correct thing to want from an AI in markets is not prediction. It is discipline, measurement, and explanation at a speed and consistency a human cannot match. Build that, and if a real edge exists this app will find it; if it does not, this app will save you from paying to discover that with live money.
