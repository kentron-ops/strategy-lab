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
  }
}

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

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const row = await this.db.settings.get(key)
    return row === undefined ? fallback : (row.value as T)
  }
  setSetting(key: string, value: unknown): Promise<void> {
    return this.db.settings.put({ key, value }).then(() => undefined)
  }

  async exportAll(): Promise<string> {
    const [datasets, configs, journal, settings, library] = await Promise.all([
      this.db.datasets.toArray(),
      this.db.configs.toArray(),
      this.db.journal.toArray(),
      this.db.settings.toArray(),
      this.db.library.toArray(),
    ])
    return JSON.stringify(
      { version: EXPORT_VERSION, exportedAt: new Date().toISOString(), datasets, configs, journal, settings, library },
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
      [this.db.datasets, this.db.configs, this.db.journal, this.db.settings, this.db.library],
      async () => {
        if (parsed.datasets?.length) await this.db.datasets.bulkPut(parsed.datasets)
        if (parsed.configs?.length) await this.db.configs.bulkPut(parsed.configs)
        if (parsed.journal?.length) await this.db.journal.bulkPut(parsed.journal)
        if (parsed.settings?.length) await this.db.settings.bulkPut(parsed.settings)
        if (parsed.library?.length) await this.db.library.bulkPut(parsed.library)
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
