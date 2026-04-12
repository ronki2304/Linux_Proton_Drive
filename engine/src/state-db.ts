import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { ConfigError } from "./errors.js";

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface SyncPair {
  pair_id: string;
  local_path: string;
  remote_path: string;
  remote_id: string;
  created_at: string; // ISO 8601
  last_synced_at: string | null; // ISO 8601, null if never synced
}

export interface SyncState {
  pair_id: string;
  relative_path: string;
  local_mtime: string; // ISO 8601
  remote_mtime: string; // ISO 8601
  content_hash: string | null;
}

export interface ChangeQueueEntry {
  id: number;
  pair_id: string;
  relative_path: string;
  change_type: string;
  queued_at: string; // ISO 8601
}

// ── Migration definitions ────────────────────────────────────────────────────

type Migration = { version: number; up: string };

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS sync_pair (
        pair_id     TEXT PRIMARY KEY,
        local_path  TEXT NOT NULL,
        remote_path TEXT NOT NULL,
        remote_id   TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        pair_id       TEXT NOT NULL REFERENCES sync_pair(pair_id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        local_mtime   TEXT NOT NULL,
        remote_mtime  TEXT NOT NULL,
        content_hash  TEXT,
        PRIMARY KEY (pair_id, relative_path)
      );

      CREATE TABLE IF NOT EXISTS change_queue (
        id            INTEGER PRIMARY KEY,
        pair_id       TEXT NOT NULL REFERENCES sync_pair(pair_id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        change_type   TEXT NOT NULL,
        queued_at     TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    up: `ALTER TABLE sync_pair ADD COLUMN last_synced_at TEXT;`,
  },
];

const CURRENT_VERSION = 2;

// ── StateDb ──────────────────────────────────────────────────────────────────

export class StateDb {
  /** Pragmas allowed via the public pragma() diagnostic method. */
  private static readonly SAFE_PRAGMAS = new Set([
    "journal_mode",
    "user_version",
    "foreign_keys",
    "synchronous",
  ]);

  private readonly db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? StateDb.defaultDbPath();

    if (resolvedPath !== ":memory:") {
      try {
        mkdirSync(dirname(resolvedPath), { recursive: true });
      } catch (err) {
        throw new ConfigError(
          `Failed to create state DB directory: ${dirname(resolvedPath)}`,
          { cause: err }
        );
      }
    }

    this.db = new Database(resolvedPath);
    try {
      this.init();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  private static defaultDbPath(): string {
    const xdgData =
      process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
    return join(xdgData, "protondrive", "state.db");
  }

  private init(): void {
    this.db.pragma("journal_mode = DELETE");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;

    for (const migration of MIGRATIONS) {
      if (migration.version > current) {
        this.db.transaction(() => {
          this.db.exec(migration.up);
          this.db.exec(`PRAGMA user_version = ${Number(migration.version)}`);
        })();
      }
    }
  }

  // ── sync_pair CRUD ────────────────────────────────────────────────────────

  insertPair(pair: SyncPair): void {
    this.db
      .prepare(
        `INSERT INTO sync_pair (pair_id, local_path, remote_path, remote_id, created_at)
         VALUES (@pair_id, @local_path, @remote_path, @remote_id, @created_at)`
      )
      .run(pair);
  }

  getPair(pairId: string): SyncPair | undefined {
    return this.db
      .prepare(`SELECT * FROM sync_pair WHERE pair_id = ?`)
      .get(pairId) as SyncPair | undefined;
  }

  listPairs(): SyncPair[] {
    return this.db
      .prepare(`SELECT * FROM sync_pair ORDER BY created_at ASC`)
      .all() as SyncPair[];
  }

  updateLastSynced(pairId: string, timestamp: string): void {
    this.db
      .prepare(`UPDATE sync_pair SET last_synced_at = ? WHERE pair_id = ?`)
      .run(timestamp, pairId);
  }

  deletePair(pairId: string): void {
    this.db
      .prepare(`DELETE FROM sync_pair WHERE pair_id = ?`)
      .run(pairId);
  }

  // ── sync_state CRUD ──────────────────────────────────────────────────────

  getSyncState(pairId: string, relativePath: string): SyncState | undefined {
    return this.db
      .prepare(
        `SELECT * FROM sync_state WHERE pair_id = ? AND relative_path = ?`
      )
      .get(pairId, relativePath) as SyncState | undefined;
  }

  upsertSyncState(state: SyncState): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sync_state (pair_id, relative_path, local_mtime, remote_mtime, content_hash)
         VALUES (@pair_id, @relative_path, @local_mtime, @remote_mtime, @content_hash)`
      )
      .run(state);
  }

  listSyncStates(pairId: string): SyncState[] {
    return this.db
      .prepare(
        `SELECT * FROM sync_state WHERE pair_id = ? ORDER BY relative_path ASC`
      )
      .all(pairId) as SyncState[];
  }

  deleteSyncState(pairId: string, relativePath: string): void {
    this.db
      .prepare(
        `DELETE FROM sync_state WHERE pair_id = ? AND relative_path = ?`
      )
      .run(pairId, relativePath);
  }

  updatePairRemoteId(pairId: string, remoteId: string): void {
    this.db
      .prepare(`UPDATE sync_pair SET remote_id = ? WHERE pair_id = ?`)
      .run(remoteId, pairId);
  }

  // ── change_queue CRUD ─────────────────────────────────────────────────────

  enqueue(entry: Omit<ChangeQueueEntry, "id">): void {
    this.db
      .prepare(
        `INSERT INTO change_queue (pair_id, relative_path, change_type, queued_at)
         VALUES (@pair_id, @relative_path, @change_type, @queued_at)`
      )
      .run(entry);
  }

  dequeue(id: number): void {
    this.db
      .prepare(`DELETE FROM change_queue WHERE id = ?`)
      .run(id);
  }

  listQueue(pairId: string): ChangeQueueEntry[] {
    return this.db
      .prepare(
        `SELECT * FROM change_queue WHERE pair_id = ? ORDER BY id ASC`
      )
      .all(pairId) as ChangeQueueEntry[];
  }

  queueSize(pairId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM change_queue WHERE pair_id = ?`)
      .get(pairId) as { cnt: number };
    return row.cnt;
  }

  // ── diagnostics (used in tests and health checks) ─────────────────────────

  /** Read a SQLite pragma value. Restricted to known-safe, read-only pragmas. */
  pragma(name: string): unknown {
    if (!StateDb.SAFE_PRAGMAS.has(name)) {
      throw new Error(`Disallowed pragma: ${name}`);
    }
    return this.db.pragma(name, { simple: true });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
