import Dexie, { type Table } from 'dexie'
import type { Dataset, StrategyConfig } from '../core/types'
import type { JournalEntry } from '../core/journal/types'
import type { StrategySpec } from '../core/spec/types'
import type { ProofResult } from '../core/prover/prover'

/** A spec stored in the Library, with its evidence when it has been proven. */
export interface LibraryEntry {
  id: string
  spec: StrategySpec
  evidence: ProofResult | null
  savedAt: number
}

/**
 * One row in the RUN HISTORY: the record of a backtest that was actually run.
 *
 * This is the honest audit trail of what was tried. It matters for the same
 * reason the trials counter matters — a strategy that looks good on its
 * fortieth variation is not the same discovery as one that looked good first
 * time, and only a durable record can tell the difference later.
 *
 * Deliberately small: headline metrics and provenance, never the full trade
 * ledger, so a long session of dragging sliders cannot fill the user's disk.
 */
export interface RunRecord {
  id: string
  ranAt: number
  strategyName: string
  strategyId: string
  /** Present when the run came from a compiled spec rather than a built-in. */
  specId: string | null
  datasetId: string
  datasetSymbol: string
  datasetTimeframe: string
  datasetHash: string
  /** Key metrics — the four the user asked to see, plus context. */
  expectancyR: number
  expectancyCiLow: number
  expectancyCiHigh: number
  netPnl: number
  returnPct: number
  winRate: number
  trades: number
  profitFactor: number
  maxDrawdownPct: number
  sampleAdequate: boolean
  ambiguousTrades: number
  intrabar: string
  durationMs: number
}

/**
 * StorageAdapter — everything persistent sits behind this interface (§3).
 * Today it is IndexedDB via Dexie; a cloud implementation would slot in here
 * without touching core or UI. Export/import as JSON means the user owns their
 * data and can move it between devices by hand.
 */

export interface StoredSettings {
  key: string
  value: unknown
}

export interface StorageAdapter {
  // datasets
  listDatasets(): Promise<Dataset[]>
  saveDataset(ds: Dataset): Promise<void>
  deleteDataset(id: string): Promise<void>

  // strategy configs
  listConfigs(): Promise<StrategyConfig[]>
  saveConfig(cfg: StrategyConfig): Promise<void>
  deleteConfig(id: string): Promise<void>

  // journal
  listJournal(): Promise<JournalEntry[]>
  saveJournalEntries(entries: JournalEntry[]): Promise<void>
  deleteJournalEntry(id: string): Promise<void>

  // spec library
  listLibrary(): Promise<LibraryEntry[]>
  saveLibraryEntry(entry: LibraryEntry): Promise<void>
  deleteLibraryEntry(id: string): Promise<void>

  // run history
  listRuns(limit?: number): Promise<RunRecord[]>
  saveRun(run: RunRecord): Promise<void>
  clearRuns(): Promise<void>

  // settings
  getSetting<T>(key: string, fallback: T): Promise<T>
  setSetting(key: string, value: unknown): Promise<void>

  // whole-app portability
  exportAll(): Promise<string>
  importAll(json: string): Promise<{ ok: boolean; message: string }>
}

class LabDb extends Dexie {
  datasets!: Table<Dataset, string>
  configs!: Table<StrategyConfig, string>
  journal!: Table<JournalEntry, string>
  settings!: Table<StoredSettings, string>
  library!: Table<LibraryEntry, string>
  runs!: Table<RunRecord, string>

  constructor() {
    super('strategy-lab')
    this.version(1).stores({
      datasets: 'id, symbol, timeframe',
      configs: 'id, strategyId',
      journal: 'id, entryTime, symbol',
      settings: 'key',
    })
    this.version(2).stores({
      datasets: 'id, symbol, timeframe',
      configs: 'id, strategyId',
      journal: 'id, entryTime, symbol',
      settings: 'key',
      library: 'id, savedAt',
    })
    this.version(3).stores({
      datasets: 'id, symbol, timeframe',
      configs: 'id, strategyId',
      journal: 'id, entryTime, symbol',
      settings: 'key',
      library: 'id, savedAt',
      runs: 'id, ranAt, strategyId',
    })
  }
}

/**
 * How many runs to keep. Every slider nudge is a run, so an unbounded table
 * would grow without limit; the oldest are trimmed once past this.
 */
const MAX_RUNS = 500

const EXPORT_VERSION = 1

export class IndexedDbAdapter implements StorageAdapter {
  private db = new LabDb()

  listDatasets(): Promise<Dataset[]> {
    return this.db.datasets.toArray()
  }
  saveDataset(ds: Dataset): Promise<void> {
    return this.db.datasets.put(ds).then(() => undefined)
  }
  deleteDataset(id: string): Promise<void> {
    return this.db.datasets.delete(id)
  }

  listConfigs(): Promise<StrategyConfig[]> {
    return this.db.configs.toArray()
  }
  saveConfig(cfg: StrategyConfig): Promise<void> {
    return this.db.configs.put(cfg).then(() => undefined)
  }
  deleteConfig(id: string): Promise<void> {
    return this.db.configs.delete(id)
  }

  listJournal(): Promise<JournalEntry[]> {
    return this.db.journal.orderBy('entryTime').toArray()
  }
  saveJournalEntries(entries: JournalEntry[]): Promise<void> {
    return this.db.journal.bulkPut(entries).then(() => undefined)
  }
  deleteJournalEntry(id: string): Promise<void> {
    return this.db.journal.delete(id)
  }

  listLibrary(): Promise<LibraryEntry[]> {
    return this.db.library.orderBy('savedAt').reverse().toArray()
  }
  saveLibraryEntry(entry: LibraryEntry): Promise<void> {
    return this.db.library.put(entry).then(() => undefined)
  }
  deleteLibraryEntry(id: string): Promise<void> {
    return this.db.library.delete(id)
  }

  listRuns(limit = 200): Promise<RunRecord[]> {
    return this.db.runs.orderBy('ranAt').reverse().limit(limit).toArray()
  }

  async saveRun(run: RunRecord): Promise<void> {
    await this.db.runs.put(run)
    // Trim the tail so a long slider session cannot grow the table forever.
    const count = await this.db.runs.count()
    if (count > MAX_RUNS) {
      const oldest = await this.db.runs
        .orderBy('ranAt')
        .limit(count - MAX_RUNS)
        .primaryKeys()
      await this.db.runs.bulkDelete(oldest)
    }
  }

  clearRuns(): Promise<void> {
    return this.db.runs.clear()
  }

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const row = await this.db.settings.get(key)
    return row === undefined ? fallback : (row.value as T)
  }
  setSetting(key: string, value: unknown): Promise<void> {
    return this.db.settings.put({ key, value }).then(() => undefined)
  }

  async exportAll(): Promise<string> {
    const [datasets, configs, journal, settings, library, runs] = await Promise.all([
      this.db.datasets.toArray(),
      this.db.configs.toArray(),
      this.db.journal.toArray(),
      this.db.settings.toArray(),
      this.db.library.toArray(),
      this.db.runs.toArray(),
    ])
    return JSON.stringify(
      { version: EXPORT_VERSION, exportedAt: new Date().toISOString(), datasets, configs, journal, settings, library, runs },
      null,
      0,
    )
  }

  async importAll(json: string): Promise<{ ok: boolean; message: string }> {
    let parsed: {
      version?: number
      datasets?: Dataset[]
      configs?: StrategyConfig[]
      journal?: JournalEntry[]
      settings?: StoredSettings[]
      library?: LibraryEntry[]
      runs?: RunRecord[]
    }
    try {
      parsed = JSON.parse(json)
    } catch {
      return { ok: false, message: 'Not valid JSON.' }
    }
    if (parsed.version !== EXPORT_VERSION) {
      return {
        ok: false,
        message: `Export version ${parsed.version ?? 'unknown'} does not match this build (${EXPORT_VERSION}).`,
      }
    }
    await this.db.transaction(
      'rw',
      [this.db.datasets, this.db.configs, this.db.journal, this.db.settings, this.db.library, this.db.runs],
      async () => {
        if (parsed.datasets?.length) await this.db.datasets.bulkPut(parsed.datasets)
        if (parsed.configs?.length) await this.db.configs.bulkPut(parsed.configs)
        if (parsed.journal?.length) await this.db.journal.bulkPut(parsed.journal)
        if (parsed.settings?.length) await this.db.settings.bulkPut(parsed.settings)
        if (parsed.library?.length) await this.db.library.bulkPut(parsed.library)
        if (parsed.runs?.length) await this.db.runs.bulkPut(parsed.runs)
      },
    )
    const counts = [
      parsed.datasets?.length ? `${parsed.datasets.length} dataset(s)` : null,
      parsed.configs?.length ? `${parsed.configs.length} config(s)` : null,
      parsed.journal?.length ? `${parsed.journal.length} journal entrie(s)` : null,
    ].filter(Boolean)
    return { ok: true, message: `Imported ${counts.join(', ') || 'nothing new'}.` }
  }
}

export const storage: StorageAdapter = new IndexedDbAdapter()
