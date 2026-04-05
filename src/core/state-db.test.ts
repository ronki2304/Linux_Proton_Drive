import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StateDB, getDbPath } from "./state-db.js";
import type { SyncStateRecord } from "../types.js";

const SAMPLE_RECORD: SyncStateRecord = {
  syncPairId: "docs",
  localPath: "/home/user/Documents/notes.md",
  remotePath: "/Documents/notes.md",
  lastSyncMtime: "2026-04-01T10:00:00.000Z",
  lastSyncHash: "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
  state: "synced",
};

describe("getDbPath", () => {
  test("uses XDG_DATA_HOME when set", () => {
    const original = process.env["XDG_DATA_HOME"];
    process.env["XDG_DATA_HOME"] = "/custom/data";
    try {
      expect(getDbPath()).toBe("/custom/data/protondrive/state.db");
    } finally {
      if (original === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = original;
    }
  });

  test("falls back to ~/.local/share when XDG_DATA_HOME not set", () => {
    const original = process.env["XDG_DATA_HOME"];
    delete process.env["XDG_DATA_HOME"];
    try {
      const expected = path.join(
        os.homedir(),
        ".local",
        "share",
        "protondrive",
        "state.db",
      );
      expect(getDbPath()).toBe(expected);
    } finally {
      if (original !== undefined) process.env["XDG_DATA_HOME"] = original;
    }
  });
});

describe("StateDB", () => {
  let db: StateDB;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-db-test-"));
    dbPath = path.join(tmpDir, "test.db");
    db = await StateDB.init(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("init() creates the DB file at the specified path", () => {
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  test("init() creates parent directories if missing", async () => {
    const nestedPath = path.join(tmpDir, "a", "b", "c", "test.db");
    const nestedDb = await StateDB.init(nestedPath);
    try {
      expect(fs.existsSync(nestedPath)).toBe(true);
    } finally {
      nestedDb.close();
    }
  });

  test("upsert + get round-trip preserves all fields", () => {
    db.upsert(SAMPLE_RECORD);
    const retrieved = db.get(SAMPLE_RECORD.localPath);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.syncPairId).toBe(SAMPLE_RECORD.syncPairId);
    expect(retrieved?.localPath).toBe(SAMPLE_RECORD.localPath);
    expect(retrieved?.remotePath).toBe(SAMPLE_RECORD.remotePath);
    expect(retrieved?.lastSyncMtime).toBe(SAMPLE_RECORD.lastSyncMtime);
    expect(retrieved?.lastSyncHash).toBe(SAMPLE_RECORD.lastSyncHash);
    expect(retrieved?.state).toBe(SAMPLE_RECORD.state);
  });

  test("get returns null for unknown localPath", () => {
    expect(db.get("/nonexistent/path")).toBeNull();
  });

  test("upsert replaces existing record (INSERT OR REPLACE)", () => {
    db.upsert(SAMPLE_RECORD);
    const updated: SyncStateRecord = {
      ...SAMPLE_RECORD,
      state: "conflict",
      lastSyncMtime: "2026-04-02T10:00:00.000Z",
    };
    db.upsert(updated);
    const retrieved = db.get(SAMPLE_RECORD.localPath);
    expect(retrieved?.state).toBe("conflict");
    expect(retrieved?.lastSyncMtime).toBe("2026-04-02T10:00:00.000Z");
  });

  test("getLastSync returns null for never-synced pair", () => {
    expect(db.getLastSync("unknown-pair")).toBeNull();
  });

  test("getLastSync returns most recent mtime after multiple upserts", () => {
    const r1: SyncStateRecord = {
      ...SAMPLE_RECORD,
      localPath: "/a",
      lastSyncMtime: "2026-04-01T10:00:00.000Z",
    };
    const r2: SyncStateRecord = {
      ...SAMPLE_RECORD,
      localPath: "/b",
      lastSyncMtime: "2026-04-02T12:00:00.000Z",
    };
    const r3: SyncStateRecord = {
      ...SAMPLE_RECORD,
      localPath: "/c",
      lastSyncMtime: "2026-04-01T08:00:00.000Z",
    };
    db.upsert(r1);
    db.upsert(r2);
    db.upsert(r3);
    expect(db.getLastSync(SAMPLE_RECORD.syncPairId)).toBe(
      "2026-04-02T12:00:00.000Z",
    );
  });

  test("getAll returns all records for a sync pair", () => {
    db.upsert({ ...SAMPLE_RECORD, localPath: "/a" });
    db.upsert({ ...SAMPLE_RECORD, localPath: "/b" });
    db.upsert({
      ...SAMPLE_RECORD,
      localPath: "/c",
      syncPairId: "other-pair",
    });
    const all = db.getAll(SAMPLE_RECORD.syncPairId);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.localPath).sort()).toEqual(["/a", "/b"]);
  });

  test("XDG_DATA_HOME override resolves correct DB path", () => {
    const original = process.env["XDG_DATA_HOME"];
    process.env["XDG_DATA_HOME"] = tmpDir;
    try {
      expect(getDbPath()).toBe(
        path.join(tmpDir, "protondrive", "state.db"),
      );
    } finally {
      if (original === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = original;
    }
  });
});
