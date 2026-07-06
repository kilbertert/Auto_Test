/**
 * SQLite-backed implementation of the {@link MemoryStore} interface from
 * `@open-multi-agent/core`, persisted to the `oma_memory` table.
 *
 * The backing `sqlite` Database (better-sqlite3, synchronous) is exported by
 * `./client.js`; this module wraps it behind the async `MemoryStore` surface so
 * it can be swapped in for the default in-memory store without changing callers.
 *
 * Assumed `oma_memory` schema (owned by db/client.ts):
 *   key             TEXT PRIMARY KEY
 *   value           TEXT NOT NULL
 *   metadata        TEXT          -- JSON.stringify'd metadata; NULL when absent
 *   created_at      TEXT NOT NULL  -- ISO 8601 timestamp
 *   expires_at_turn INTEGER        -- NULL when no turn-count expiry
 *
 * Expiry is stored but never filtered here — the framework (SharedMemory) owns
 * the turn counter and decides when an entry has expired. Reads always return
 * the row as-is, mirroring the InMemoryStore contract.
 */
import type { MemoryEntry, MemoryStore } from '@open-multi-agent/core'
import { sqlite } from './client.js'

/** Row shape returned by better-sqlite3 for the `oma_memory` table. */
interface OmaMemoryRow {
  readonly key: string
  readonly value: string
  readonly metadata: string | null
  readonly created_at: string
  readonly expires_at_turn: number | null
}

const UPSERT_SQL = `
  INSERT OR REPLACE INTO oma_memory (key, value, metadata, created_at, expires_at_turn)
  VALUES (?, ?, ?, ?, ?)
`
const GET_SQL = `SELECT key, value, metadata, created_at, expires_at_turn FROM oma_memory WHERE key = ?`
const LIST_SQL = `SELECT key, value, metadata, created_at, expires_at_turn FROM oma_memory`
const DELETE_SQL = `DELETE FROM oma_memory WHERE key = ?`
const CLEAR_SQL = `DELETE FROM oma_memory`

/** Map a raw DB row into the immutable {@link MemoryEntry} shape. */
function rowToEntry(row: OmaMemoryRow): MemoryEntry {
  return {
    key: row.key,
    value: row.value,
    createdAt: new Date(row.created_at),
    ...(row.metadata != null ? { metadata: JSON.parse(row.metadata) as Record<string, unknown> } : {}),
    ...(row.expires_at_turn != null ? { expiresAtTurn: row.expires_at_turn } : {}),
  }
}

/**
 * Persistent key/value store backed by the `oma_memory` SQLite table.
 *
 * All methods are `async` to satisfy the {@link MemoryStore} interface; the
 * underlying better-sqlite3 calls are synchronous and wrapped directly.
 */
export class DbMemoryStore implements MemoryStore {
  /** Returns the entry for `key`, or `null` if absent. */
  async get(key: string): Promise<MemoryEntry | null> {
    const row = sqlite.prepare<unknown[], OmaMemoryRow>(GET_SQL).get(key)
    return row ? rowToEntry(row) : null
  }

  /**
   * Upserts `key` with `value` and optional `metadata`.
   *
   * Uses `INSERT OR REPLACE`: a re-write of an existing key resets
   * `created_at` to the current time (unlike InMemoryStore, which preserves
   * the original creation timestamp). `expires_at_turn` is cleared on a plain
   * `set` — use {@link setWithExpiry} to record a turn-count expiry.
   */
  async set(key: string, value: string, metadata?: Record<string, unknown>): Promise<void> {
    const metadataJson = metadata != null ? JSON.stringify(metadata) : null
    sqlite.prepare(UPSERT_SQL).run(key, value, metadataJson, new Date().toISOString(), null)
  }

  /**
   * Like {@link set}, but also records a turn-count expiry. The entry is stored
   * as-is; expiry filtering is the caller's responsibility (SharedMemory owns
   * the turn counter).
   */
  async setWithExpiry(
    key: string,
    value: string,
    expiresAtTurn: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const metadataJson = metadata != null ? JSON.stringify(metadata) : null
    sqlite
      .prepare(UPSERT_SQL)
      .run(key, value, metadataJson, new Date().toISOString(), expiresAtTurn)
  }

  /** Returns a snapshot of all entries. Expired entries are included. */
  async list(): Promise<MemoryEntry[]> {
    const rows = sqlite.prepare<unknown[], OmaMemoryRow>(LIST_SQL).all()
    return rows.map(rowToEntry)
  }

  /** Removes the entry for `key`. Deleting a non-existent key is a no-op. */
  async delete(key: string): Promise<void> {
    sqlite.prepare(DELETE_SQL).run(key)
  }

  /** Removes all entries from the store. */
  async clear(): Promise<void> {
    sqlite.prepare(CLEAR_SQL).run()
  }
}

/** Convenience singleton ready to hand to `SharedMemory` / agent configs. */
export const dbMemoryStore = new DbMemoryStore()
