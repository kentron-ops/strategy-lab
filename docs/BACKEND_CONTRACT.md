# Backend contract (for the future backend developer)

The app is fully client-side today. Every heavy job already flows through one
interface — `ComputeAdapter` in `src/core/adapters/compute.ts` — implemented by
`src/state/localCompute.ts` over Web Workers. To move compute server-side,
implement the same interface over HTTP and swap it in. **No UI or core changes.**

Everything crossing the interface is plain JSON (`StrategySpec`,
`BacktestConfig`, `Dataset`, results). Strategy specs travel INSIDE the config
(`config.strategy.spec`), so the server needs no shared registry state.

## REST mapping

| Adapter method | Endpoint | Notes |
| --- | --- | --- |
| `backtest(dataset, config)` | `POST /backtest` | Body: `{datasetId, config}`. Server resolves datasets by id + hash; upload via `POST /datasets` first. |
| `split(dataset, config, ratio)` | `POST /split` | |
| `walkForward(dataset, config, spec)` | `POST /walkforward` | Long-running → `202 { jobId }`, progress via `GET /jobs/:id` or SSE. |
| `robustness(dataset, config, spec)` | `POST /robustness` | |
| `monteCarlo(trades, spec)` | `POST /montecarlo` | |
| `sweep(dataset, config, spec)` | `POST /sweep` | Long-running job. |
| `prove(dataset, config, opts)` | `POST /prove` | Long-running job. Returns a `ProofResult`. |
| `abort()` | `DELETE /jobs/:id` | Cooperative, same as the worker version. |
| Library | `GET/POST/DELETE /library` | Stored specs + their evidence (`ProofResult`). |

Progress callbacks in the adapter map to job polling or Server-Sent Events —
the adapter signature already tolerates "no progress until done."

## Other adapters

- `StorageAdapter` (`src/storage/storageAdapter.ts`): swap IndexedDB for a DB +
  per-user sync. The export/import JSON format is the migration path.
- `DataSource` (`src/core/marketdata/adapter.ts`): a server proxy solves CORS,
  hides API keys, and lifts rate limits. Same `getHistory`/`subscribe` shape.
- `AuthAdapter` (`src/core/adapters/interfaces.ts`): local build is a stub;
  real auth goes at the edge, core never sees credentials.
- `ExecutionAdapter`: interface only. **Deliberately unimplemented — the
  product is SIMULATION ONLY and ships no order-placement code.**
- A TradingView webhook relay, if ever built, lives in this backend and feeds
  the existing `NotifierAdapter`/`DataSource` shapes.

## Invariants the backend must preserve

1. Determinism: same `{datasetHash, config, seed}` → identical results.
2. Every result carries its snapshot (dataset hash, config, engine version).
3. The trials counter: the server must count configurations it evaluates per
   spec family and return the count with every sweep/prove response — the
   client's multiple-testing penalty depends on it.
4. No endpoint ever places, modifies, or cancels a real order.
