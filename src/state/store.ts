import { create } from 'zustand'
import * as Comlink from 'comlink'
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
import { storage } from '../storage/storageAdapter'
import type { BacktestWorkerApi } from '../workers/backtest.worker'
import type { OptimizerWorkerApi } from '../workers/optimizer.worker'
import type { JournalEntry } from '../core/journal/types'
import type { SplitResult } from '../core/optimization/walkForward'
import type { MonteCarloResult } from '../core/optimization/monteCarlo'
import type { SweepResult } from '../core/optimization/sweep'

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

export type ViewName = 'LAB' | 'RESULTS' | 'TRADES' | 'REPLAY' | 'OPTIMIZE' | 'JOURNAL' | 'DATA'

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

  activeDataset(): Dataset | null
  backtestConfig(): BacktestConfig
}

// ── workers ──────────────────────────────────────────────────────────────────

let backtestWorker: Comlink.Remote<BacktestWorkerApi> | null = null
let optimizerWorker: Comlink.Remote<OptimizerWorkerApi> | null = null

export function getBacktestWorker(): Comlink.Remote<BacktestWorkerApi> {
  if (!backtestWorker) {
    const w = new Worker(new URL('../workers/backtest.worker.ts', import.meta.url), {
      type: 'module',
    })
    backtestWorker = Comlink.wrap<BacktestWorkerApi>(w)
  }
  return backtestWorker
}

export function getOptimizerWorker(): Comlink.Remote<OptimizerWorkerApi> {
  if (!optimizerWorker) {
    const w = new Worker(new URL('../workers/optimizer.worker.ts', import.meta.url), {
      type: 'module',
    })
    optimizerWorker = Comlink.wrap<OptimizerWorkerApi>(w)
  }
  return optimizerWorker
}

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
    const worker = getBacktestWorker()
    const config = state.backtestConfig()
    const result = await worker.run(
      dataset,
      config,
      Comlink.proxy((f: number) => {
        if (runSeq !== mySeq) return
        const cur = useLab.getState()
        useLab.setState({ recompute: { ...cur.recompute, progress: f } })
      }),
    )
    if (runSeq !== mySeq) return // superseded by a newer edit
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

// ── the store ────────────────────────────────────────────────────────────────

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
    const [storedDatasets, configs, theme, activeId] = await Promise.all([
      storage.listDatasets(),
      storage.listConfigs(),
      storage.getSetting<'dark' | 'light'>('theme', 'dark'),
      storage.getSetting<string | null>('activeDatasetId', null),
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
    const split = await getBacktestWorker().split(dataset, get().backtestConfig(), 0.7)
    set({ split })
  },

  async runMonteCarlo() {
    const result = get().result
    if (!result || !result.trades.length) return
    const mc = await getBacktestWorker().monteCarlo(result.trades, {
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
