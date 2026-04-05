import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SyncStateRecord } from "../types.js";

export function getDbPath(): string {
  const xdgDataHome =
    process.env["XDG_DATA_HOME"] ??
    path.join(os.homedir(), ".local", "share");
  return path.join(xdgDataHome, "protondrive", "state.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_state (
  sync_pair_id    TEXT NOT NULL,
  local_path      TEXT NOT NULL PRIMARY KEY,
  remote_path     TEXT NOT NULL,
  last_sync_mtime TEXT NOT NULL,
  last_sync_hash  TEXT NOT NULL,
  state           TEXT NOT NULL CHECK(state IN ('synced','conflict','error','pending'))
)
`;

interface DbRow {
  sync_pair_id: string;
  local_path: string;
  remote_path: string;
  last_sync_mtime: string;
  last_sync_hash: string;
  state: string;
}

function rowToRecord(row: DbRow): SyncStateRecord {
  return {
    syncPairId: row.sync_pair_id,
    localPath: row.local_path,
    remotePath: row.remote_path,
    lastSyncMtime: row.last_sync_mtime,
    lastSyncHash: row.last_sync_hash,
    state: row.state as SyncStateRecord["state"],
  };
}

export class StateDB {
  private constructor(private readonly db: Database) {}

  static async init(dbPath?: string): Promise<StateDB> {
    const resolvedPath = dbPath ?? getDbPath();
    try {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot create state directory for ${resolvedPath}: ${detail}`);
    }
    let db: Database;
    try {
      db = new Database(resolvedPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot open state database at ${resolvedPath}: ${detail}`);
    }
    try {
      db.run(SCHEMA);
    } catch (err) {
      db.close();
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot initialize state database schema at ${resolvedPath}: ${detail}`);
    }
    return new StateDB(db);
  }

  upsert(record: SyncStateRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sync_state
           (sync_pair_id, local_path, remote_path, last_sync_mtime, last_sync_hash, state)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.syncPairId,
        record.localPath,
        record.remotePath,
        record.lastSyncMtime,
        record.lastSyncHash,
        record.state,
      );
  }

  get(localPath: string): SyncStateRecord | null {
    const row = this.db
      .prepare("SELECT * FROM sync_state WHERE local_path = ?")
      .get(localPath) as DbRow | null;
    return row ? rowToRecord(row) : null;
  }

  getLastSync(syncPairId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT MAX(last_sync_mtime) AS last FROM sync_state WHERE sync_pair_id = ?",
      )
      .get(syncPairId) as { last: string | null } | null;
    return row?.last ?? null;
  }

  getAll(syncPairId: string): SyncStateRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM sync_state WHERE sync_pair_id = ?")
      .all(syncPairId) as DbRow[];
    return rows.map(rowToRecord);
  }

  close(): void {
    this.db.close();
  }
}
