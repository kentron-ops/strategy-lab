import { create } from 'zustand'
import type {
  BacktestConfig,
  BacktestResult,
  CostConfig,
  Dataset,
  IndicatorConfig,
  Instrument,
  IntrabarPolicy,
  RiskConfig,
  StrategyConfig,
} from '../core/types'
import {
  DEFAULT_COSTS,
  DEFAULT_INDICATORS,
  DEFAULT_INSTRUMENT,
  DEFAULT_RISK,
} from '../core/types'
import { buildSampleDataset, SAMPLE_DATASET_ID } from '../core/data/sample'
import { makeConfig } from '../core/strategy/registry'
import { storage, type LibraryEntry, type RunRecord } from '../storage/storageAdapter'
import { compute } from './localCompute'
import type { JournalEntry } from '../core/journal/types'
import type { SplitResult } from '../core/optimization/walkForward'
import type { MonteCarloResult } from '../core/optimization/monteCarlo'
import type { SweepResult } from '../core/optimization/sweep'
import type { StrategySpec, AcceptIf } from '../core/spec/types'
import { DEFAULT_ACCEPT_IF } from '../core/spec/types'
import { makeSpecConfig } from '../core/spec/resolve'
import { PRESET_SPECS } from '../core/spec/presets'
import type { ProofResult } from '../core/prover/prover'
import { hashObject } from '../core/util/hash'

/**
 * The reactive computation graph (§8), implemented as a Zustand store plus a
 * debounced recompute pipeline running in a Web Worker.
 *
 * Inputs:  dataset, strategy config, risk config, cost config, intrabar policy.
 * Derived: the backtest result (and everything the UI reads off it).
 *
 * Change any input → `dirty` flips immediately (the UI shows every metric as
 * stale), the worker recomputes, and the result streams back. The UI never
 * blocks and never silently shows numbers computed from inputs that have since
 * changed — that is what the `staleSince` timestamp is for.
 */

export type ViewName =
  | 'LAB'
  | 'RESULTS'
  | 'TRADES'
  | 'REPLAY'
  | 'OPTIMIZE'
  | 'PROVER'
  | 'LIBRARY'
  | 'HISTORY'
  | 'JOURNAL'
  | 'DATA'

export interface RecomputeState {
  running: boolean
  progress: number
  /** Result currently displayed was computed from inputs older than this. */
  dirty: boolean
  staleSince: number | null
  lastDurationMs: number | null
  error: string | null
}

interface LabState {
  // ── inputs
  datasets: Dataset[]
  activeDatasetId: string | null
  strategyConfig: StrategyConfig
  savedConfigs: StrategyConfig[]
  risk: RiskConfig
  costs: CostConfig
  instrument: Instrument
  indicators: IndicatorConfig
  intrabar: IntrabarPolicy

  // ── derived
  result: BacktestResult | null
  split: SplitResult | null
  monteCarlo: MonteCarloResult | null
  sweep: SweepResult | null

  // ── V2: prover, library, trials
  acceptIf: AcceptIf
  proof: ProofResult | null
  proving: { running: boolean; stage: string; progress: number; error: string | null }
  library: LibraryEntry[]
  /** Configurations tried per strategy family — feeds the trials penalty. */
  trials: Record<string, number>
  /** Newest-first record of every backtest that has been run. */
  runs: RunRecord[]

  // ── machinery
  recompute: RecomputeState
  view: ViewName
  theme: 'dark' | 'light'
  hydrated: boolean

  // ── actions
  hydrate(): Promise<void>
  setView(v: ViewName): void
  setTheme(t: 'dark' | 'light'): void
  setActiveDataset(id: string): void
  addDataset(ds: Dataset): Promise<void>
  removeDataset(id: string): Promise<void>
  setStrategy(strategyId: string): void
  setParam(key: string, value: number | string | boolean): void
  setRisk(patch: Partial<RiskConfig>): void
  setCosts(patch: Partial<CostConfig>): void
  setIntrabar(policy: IntrabarPolicy): void
  saveCurrentConfig(name: string): Promise<void>
  loadConfig(id: string): void
  deleteConfig(id: string): Promise<void>
  runNow(): void
  runSplit(): Promise<void>
  runMonteCarlo(): Promise<void>
  setSweepResult(r: SweepResult | null): void

  // ── V2 actions
  useSpec(spec: StrategySpec): void
  setAcceptIf(patch: Partial<Pick<AcceptIf, 'minTrades' | 'minExpectancyR'>>): void
  runProver(): Promise<void>
  saveToLibrary(spec: StrategySpec, evidence: ProofResult | null): Promise<void>
  removeFromLibrary(id: string): Promise<void>
  addTrials(familyKey: string, n: number): void
  currentFamilyKey(): string
  currentTrials(): number
  clearRuns(): Promise<void>

  activeDataset(): Dataset | null
  backtestConfig(): BacktestConfig
}

// ── compute ──────────────────────────────────────────────────────────────────
// All heavy work goes through the ComputeAdapter (V2 §2). The store and views
// never touch a Worker directly.
export { compute }

// ── debounced recompute ──────────────────────────────────────────────────────

let recomputeTimer: ReturnType<typeof setTimeout> | null = null
let runSeq = 0

function scheduleRecompute(): void {
  const s = useLab.getState()
  useLab.setState({
    recompute: { ...s.recompute, dirty: true, staleSince: Date.now() },
  })
  if (recomputeTimer) clearTimeout(recomputeTimer)
  recomputeTimer = setTimeout(() => void doRecompute(), 250)
}

async function doRecompute(): Promise<void> {
  const state = useLab.getState()
  const dataset = state.activeDataset()
  if (!dataset) return

  const mySeq = ++runSeq
  useLab.setState({
    recompute: { ...state.recompute, running: true, progress: 0, error: null },
  })

  try {
    const config = state.backtestConfig()
    // Every evaluated configuration counts toward the trials penalty — the
    // Prover cannot be honest about multiple testing if we do not count.
    const paramHash = hashObject({ f: state.currentFamilyKey(), p: config.strategy.params })
    if (!seenParamHashes.has(paramHash)) {
      seenParamHashes.add(paramHash)
      state.addTrials(state.currentFamilyKey(), 1)
    }
    const result = await compute.backtest(dataset, config, (f: number) => {
      if (runSeq !== mySeq) return
      const cur = useLab.getState()
      useLab.setState({ recompute: { ...cur.recompute, progress: f } })
    })
    if (runSeq !== mySeq) return // superseded by a newer edit

    // Record the run. This is the audit trail of everything tested — written
    // for completed runs only, so a superseded mid-drag recompute never
    // pollutes the history with a result the user never saw.
    void recordRun(dataset, config, result)

    useLab.setState({
      result,
      split: null,
      monteCarlo: null,
      recompute: {
        running: false,
        progress: 1,
        dirty: false,
        staleSince: null,
        lastDurationMs: result.durationMs,
        error: null,
      },
    })
  } catch (err) {
    if (runSeq !== mySeq) return
    const cur = useLab.getState()
    useLab.setState({
      recompute: {
        ...cur.recompute,
        running: false,
        error: err instanceof Error ? err.message : String(err),
      },
    })
  }
}

/**
 * Append one completed backtest to the run history.
 *
 * Identical consecutive runs are collapsed: the reactive graph recomputes on
 * dataset switches and view changes as well as on real edits, and logging the
 * same numbers twice in a row would make the history harder to read without
 * telling anyone anything new.
 */
let lastRunFingerprint = ''

async function recordRun(
  dataset: Dataset,
  config: BacktestConfig,
  result: BacktestResult,
): Promise<void> {
  const m = result.metrics
  const spec = config.strategy.spec as StrategySpec | undefined
  const fingerprint = hashObject({
    d: dataset.hash,
    s: config.strategy.strategyId,
    p: config.strategy.params,
    r: config.risk,
    c: config.costs,
    i: config.intrabar,
  })
  if (fingerprint === lastRunFingerprint) return
  lastRunFingerprint = fingerprint

  const record: RunRecord = {
    id: `run_${Date.now().toString(36)}_${fingerprint.slice(0, 6)}`,
    ranAt: Date.now(),
    strategyName: config.strategy.name,
    strategyId: config.strategy.strategyId,
    specId: spec?.id ?? null,
    datasetId: dataset.id,
    datasetSymbol: dataset.symbol,
    datasetTimeframe: dataset.timeframe,
    datasetHash: dataset.hash,
    expectancyR: m.expectancyR.point,
    expectancyCiLow: m.expectancyR.low,
    expectancyCiHigh: m.expectancyR.high,
    netPnl: m.netPnl,
    returnPct: m.returnPct,
    winRate: m.winRate.point,
    trades: m.trades,
    profitFactor: Number.isFinite(m.profitFactor) ? m.profitFactor : 0,
    maxDrawdownPct: m.maxDrawdownPct,
    sampleAdequate: m.sampleAdequate,
    ambiguousTrades: result.ambiguity.ambiguousTrades,
    intrabar: config.intrabar,
    durationMs: result.durationMs,
  }

  try {
    await storage.saveRun(record)
    useLab.setState({ runs: [record, ...useLab.getState().runs].slice(0, 200) })
  } catch {
    // History is a convenience, not the product. A storage failure must never
    // take down the backtest the user is actually looking at.
  }
}

// ── the store ────────────────────────────────────────────────────────────────

const seenParamHashes = new Set<string>()

export const useLab = create<LabState>((set, get) => ({
  datasets: [],
  activeDatasetId: null,
  strategyConfig: makeConfig('oco_breakout'),
  savedConfigs: [],
  risk: { ...DEFAULT_RISK },
  costs: { ...DEFAULT_COSTS },
  instrument: { ...DEFAULT_INSTRUMENT },
  indicators: { ...DEFAULT_INDICATORS },
  intrabar: 'CONSERVATIVE',

  result: null,
  split: null,
  monteCarlo: null,
  sweep: null,

  acceptIf: { ...DEFAULT_ACCEPT_IF, registeredAt: Date.now() },
  proof: null,
  proving: { running: false, stage: '', progress: 0, error: null },
  library: [],
  trials: {},
  runs: [],

  recompute: {
    running: false,
    progress: 0,
    dirty: false,
    staleSince: null,
    lastDurationMs: null,
    error: null,
  },
  view: 'LAB',
  theme: 'dark',
  hydrated: false,

  async hydrate() {
    const [storedDatasets, configs, theme, activeId, library, trials, acceptIfStored, runs] =
      await Promise.all([
        storage.listDatasets(),
        storage.listConfigs(),
        storage.getSetting<'dark' | 'light'>('theme', 'dark'),
        storage.getSetting<string | null>('activeDatasetId', null),
        storage.listLibrary(),
        storage.getSetting<Record<string, number>>('trials', {}),
        storage.getSetting<AcceptIf | null>('acceptIf', null),
        storage.listRuns(200),
      ])

    let datasets = storedDatasets
    if (!datasets.some((d) => d.id === SAMPLE_DATASET_ID)) {
      const sample = buildSampleDataset()
      datasets = [sample, ...datasets]
      void storage.saveDataset(sample)
    }

    set({
      datasets,
      savedConfigs: configs,
      theme,
      library,
      trials,
      runs,
      acceptIf: acceptIfStored ?? { ...DEFAULT_ACCEPT_IF, registeredAt: Date.now() },
      activeDatasetId:
        activeId && datasets.some((d) => d.id === activeId)
          ? activeId
          : datasets[0]?.id ?? null,
      hydrated: true,
    })
    scheduleRecompute()
  },

  setView(v) {
    set({ view: v })
  },
  setTheme(t) {
    set({ theme: t })
    void storage.setSetting('theme', t)
  },

  setActiveDataset(id) {
    set({ activeDatasetId: id })
    void storage.setSetting('activeDatasetId', id)
    scheduleRecompute()
  },

  async addDataset(ds) {
    await storage.saveDataset(ds)
    set({ datasets: [...get().datasets.filter((d) => d.id !== ds.id), ds], activeDatasetId: ds.id })
    scheduleRecompute()
  },

  async removeDataset(id) {
    if (id === SAMPLE_DATASET_ID) return
    await storage.deleteDataset(id)
    const rest = get().datasets.filter((d) => d.id !== id)
    set({
      datasets: rest,
      activeDatasetId:
        get().activeDatasetId === id ? rest[0]?.id ?? null : get().activeDatasetId,
    })
    scheduleRecompute()
  },

  setStrategy(strategyId) {
    set({ strategyConfig: makeConfig(strategyId), sweep: null })
    scheduleRecompute()
  },

  setParam(key, value) {
    const cfg = get().strategyConfig
    set({
      strategyConfig: {
        ...cfg,
        params: { ...cfg.params, [key]: value },
        version: cfg.version + 1,
      },
    })
    scheduleRecompute()
  },

  setRisk(patch) {
    set({ risk: { ...get().risk, ...patch } })
    scheduleRecompute()
  },

  setCosts(patch) {
    set({ costs: { ...get().costs, ...patch } })
    scheduleRecompute()
  },

  setIntrabar(policy) {
    set({ intrabar: policy })
    scheduleRecompute()
  },

  async saveCurrentConfig(name) {
    const cfg = { ...get().strategyConfig, name, id: `cfg_${Date.now().toString(36)}` }
    await storage.saveConfig(cfg)
    set({ savedConfigs: [...get().savedConfigs, cfg] })
  },

  loadConfig(id) {
    const cfg = get().savedConfigs.find((c) => c.id === id)
    if (cfg) {
      set({ strategyConfig: { ...cfg } })
      scheduleRecompute()
    }
  },

  async deleteConfig(id) {
    await storage.deleteConfig(id)
    set({ savedConfigs: get().savedConfigs.filter((c) => c.id !== id) })
  },

  runNow() {
    scheduleRecompute()
  },

  async runSplit() {
    const dataset = get().activeDataset()
    if (!dataset) return
    const split = await compute.split(dataset, get().backtestConfig(), 0.7)
    set({ split })
  },

  async runMonteCarlo() {
    const result = get().result
    if (!result || !result.trades.length) return
    const mc = await compute.monteCarlo(result.trades, {
      runs: 2000,
      mode: 'BOOTSTRAP',
      pathLength: null,
      startingEquity: get().risk.startingEquity,
      seed: 42,
      ruinThresholdPct: get().risk.equityFloorPercent ?? 50,
    })
    set({ monteCarlo: mc })
  },

  setSweepResult(r) {
    set({ sweep: r })
  },

  // ── V2 actions ──────────────────────────────────────────────────────────

  useSpec(spec) {
    set({ strategyConfig: makeSpecConfig(spec), sweep: null, proof: null })
    scheduleRecompute()
  },

  setAcceptIf(patch) {
    const prev = get().acceptIf
    const changed =
      (patch.minTrades !== undefined && patch.minTrades !== prev.minTrades) ||
      (patch.minExpectancyR !== undefined && patch.minExpectancyR !== prev.minExpectancyR)
    const next: AcceptIf = {
      ...prev,
      ...patch,
      // Changing thresholds after registration is recorded, not hidden.
      revisions: changed ? prev.revisions + 1 : prev.revisions,
      registeredAt: prev.registeredAt || Date.now(),
    }
    set({ acceptIf: next })
    void storage.setSetting('acceptIf', next)
  },

  async runProver() {
    const dataset = get().activeDataset()
    if (!dataset) return
    set({ proving: { running: true, stage: 'starting', progress: 0, error: null } })
    try {
      const proof = await compute.prove(
        dataset,
        get().backtestConfig(),
        {
          trials: get().currentTrials(),
          acceptIf: get().acceptIf,
        },
        (stage, fraction) => {
          set({ proving: { running: true, stage, progress: fraction, error: null } })
        },
      )
      set({ proof, proving: { running: false, stage: 'done', progress: 1, error: null } })
    } catch (err) {
      set({
        proving: {
          running: false,
          stage: 'error',
          progress: 0,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  },

  async saveToLibrary(spec, evidence) {
    const entry: LibraryEntry = { id: spec.id, spec, evidence, savedAt: Date.now() }
    await storage.saveLibraryEntry(entry)
    set({ library: [entry, ...get().library.filter((e) => e.id !== entry.id)] })
  },

  async removeFromLibrary(id) {
    await storage.deleteLibraryEntry(id)
    set({ library: get().library.filter((e) => e.id !== id) })
  },

  addTrials(familyKey, n) {
    const trials = { ...get().trials, [familyKey]: (get().trials[familyKey] ?? 0) + n }
    set({ trials })
    void storage.setSetting('trials', trials)
  },

  currentFamilyKey() {
    const cfg = get().strategyConfig
    return cfg.spec ? `spec:${(cfg.spec as StrategySpec).id}` : `builtin:${cfg.strategyId}`
  },

  currentTrials() {
    return Math.max(1, get().trials[get().currentFamilyKey()] ?? 1)
  },

  async clearRuns() {
    await storage.clearRuns()
    set({ runs: [] })
  },

  activeDataset() {
    const s = get()
    return s.datasets.find((d) => d.id === s.activeDatasetId) ?? null
  },

  backtestConfig(): BacktestConfig {
    const s = get()
    return {
      strategy: s.strategyConfig,
      risk: s.risk,
      costs: s.costs,
      instrument: s.instrument,
      indicators: s.indicators,
      intrabar: s.intrabar,
      seed: 1,
      fromIndex: null,
      toIndex: null,
    }
  },
}))

// ── journal store (separate concern, same pattern) ───────────────────────────

interface JournalState {
  entries: JournalEntry[]
  hydrated: boolean
  hydrate(): Promise<void>
  add(entries: JournalEntry[]): Promise<void>
  remove(id: string): Promise<void>
}

export const useJournal = create<JournalState>((set, get) => ({
  entries: [],
  hydrated: false,
  async hydrate() {
    const entries = await storage.listJournal()
    set({ entries, hydrated: true })
  },
  async add(entries) {
    await storage.saveJournalEntries(entries)
    const merged = [...get().entries]
    for (const e of entries) {
      const idx = merged.findIndex((x) => x.id === e.id)
      if (idx >= 0) merged[idx] = e
      else merged.push(e)
    }
    merged.sort((a, b) => a.entryTime - b.entryTime)
    set({ entries: merged })
  },
  async remove(id) {
    await storage.deleteJournalEntry(id)
    set({ entries: get().entries.filter((e) => e.id !== id) })
  },
}))
