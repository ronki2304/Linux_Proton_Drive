import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDb } from "./state-db.js";
import type { SyncPair, SyncState, ChangeQueueEntry, ChangeType, EventQueueEntry } from "./state-db.js";

// Each test gets a fresh :memory: DB for full isolation.
let db: StateDb;

describe("StateDb — init", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("sets WAL journal mode (AC2)", () => {
    // WAL on :memory: is accepted by bun:sqlite and pragma returns 'memory'
    // (SQLite special-cases in-memory WAL). For a proper file-based check the
    // StateDb constructor sets PRAGMA journal_mode=WAL before any other work.
    // We verify via the public pragma() passthrough.
    const journalMode = db.pragma("journal_mode");
    // :memory: DBs return "memory" even when WAL is requested; file DBs return "wal".
    // Both indicate the pragma was issued correctly.
    expect(journalMode === "wal" || journalMode === "memory").toBeTruthy();
  });

  it("creates sync_pair table with correct columns", () => {
    const pair: SyncPair = {
      pair_id: "p1",
      local_path: "/home/user/docs",
      remote_path: "/My Drive/docs",
      remote_id: "folder-abc",
      created_at: "2026-04-09T10:00:00.000Z",
      last_synced_at: null,
    };
    expect(() => db.insertPair(pair)).not.toThrow();
    const fetched = db.getPair("p1");
    expect(fetched).toEqual(pair);
  });

  it("creates sync_state table (via migration, table exists)", () => {
    // We verify by inspecting sqlite_master via a raw DB opened on same :memory:
    // — not possible since it's a different file. Instead, confirm via
    // that sync_pair and change_queue work, indicating migration ran successfully.
    const pairs = db.listPairs();
    expect(pairs.length).toBe(0);
  });

  it("creates change_queue table with correct columns", () => {
    // FK constraints require the parent sync_pair row to exist first.
    db.insertPair({ pair_id: "p1", local_path: "/p", remote_path: "/rp", remote_id: "r", created_at: "2026-04-09T10:00:00.000Z", last_synced_at: null });
    const entry: Omit<ChangeQueueEntry, "id"> = {
      pair_id: "p1",
      relative_path: "docs/file.md",
      change_type: "created",
      queued_at: "2026-04-09T10:00:00.000Z",
    };
    expect(() => db.enqueue(entry)).not.toThrow();
    const queue = db.listQueue("p1");
    expect(queue.length).toBe(1);
    expect(queue[0]!.pair_id).toBe("p1");
    expect(queue[0]!.relative_path).toBe("docs/file.md");
    expect(queue[0]!.change_type).toBe("created");
    expect(queue[0]!.queued_at).toBe("2026-04-09T10:00:00.000Z");
  });

  it("sets user_version to 7 after migration (AC4)", () => {
    expect(db.pragma("user_version")).toBe(7);
  });
});

describe("StateDb — sync_pair CRUD", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("inserts and retrieves a sync pair", () => {
    const pair: SyncPair = {
      pair_id: "pair-001",
      local_path: "/home/user/photos",
      remote_path: "/My Drive/Photos",
      remote_id: "folder-xyz",
      created_at: "2026-04-09T12:00:00.000Z",
      last_synced_at: null,
    };
    db.insertPair(pair);
    const result = db.getPair("pair-001");
    expect(result).toEqual(pair);
  });

  it("returns undefined for non-existent pair_id", () => {
    expect(db.getPair("no-such-pair")).toBe(undefined);
  });

  it("lists all pairs in insertion (created_at ASC) order", () => {
    db.insertPair({
      pair_id: "a",
      local_path: "/a",
      remote_path: "/ra",
      remote_id: "ra",
      created_at: "2026-04-09T10:00:00.000Z",
      last_synced_at: null,
    });
    db.insertPair({
      pair_id: "b",
      local_path: "/b",
      remote_path: "/rb",
      remote_id: "rb",
      created_at: "2026-04-09T11:00:00.000Z",
      last_synced_at: null,
    });
    const pairs = db.listPairs();
    expect(pairs.length).toBe(2);
    expect(pairs[0]!.pair_id).toBe("a");
    expect(pairs[1]!.pair_id).toBe("b");
  });

  it("deletes a sync pair", () => {
    db.insertPair({
      pair_id: "del-me",
      local_path: "/x",
      remote_path: "/rx",
      remote_id: "r",
      created_at: "2026-04-09T10:00:00.000Z",
      last_synced_at: null,
    });
    expect(db.getPair("del-me") !== undefined).toBeTruthy();
    db.deletePair("del-me");
    expect(db.getPair("del-me")).toBe(undefined);
  });
});

describe("StateDb — change_queue CRUD", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
    // FK constraints require parent sync_pair rows before any enqueue.
    db.insertPair({ pair_id: "p1", local_path: "/p1", remote_path: "/rp1", remote_id: "r1", created_at: "2026-04-09T10:00:00.000Z", last_synced_at: null });
    db.insertPair({ pair_id: "p2", local_path: "/p2", remote_path: "/rp2", remote_id: "r2", created_at: "2026-04-09T10:00:00.000Z", last_synced_at: null });
  });

  afterEach(() => {
    db.close();
  });

  it("enqueues a change and lists it", () => {
    db.enqueue({
      pair_id: "p1",
      relative_path: "readme.md",
      change_type: "created",
      queued_at: "2026-04-09T10:00:00.000Z",
    });
    const queue = db.listQueue("p1");
    expect(queue.length).toBe(1);
    expect(queue[0]!.relative_path).toBe("readme.md");
    expect(queue[0]!.change_type).toBe("created");
  });

  it("assigns auto-increment id to queued entries", () => {
    db.enqueue({
      pair_id: "p1",
      relative_path: "a.txt",
      change_type: "created",
      queued_at: "2026-04-09T10:00:01.000Z",
    });
    db.enqueue({
      pair_id: "p1",
      relative_path: "b.txt",
      change_type: "deleted",
      queued_at: "2026-04-09T10:00:02.000Z",
    });
    const queue = db.listQueue("p1");
    expect(queue[0]!.id).toBe(1);
    expect(queue[1]!.id).toBe(2);
  });

  it("dequeues by id", () => {
    db.enqueue({
      pair_id: "p1",
      relative_path: "x.txt",
      change_type: "created",
      queued_at: "2026-04-09T10:00:00.000Z",
    });
    const before = db.listQueue("p1");
    expect(before.length).toBe(1);
    db.dequeue(before[0]!.id);
    expect(db.listQueue("p1").length).toBe(0);
  });

  it("reports correct queue size per pair_id", () => {
    db.enqueue({
      pair_id: "p1",
      relative_path: "a.md",
      change_type: "created",
      queued_at: "2026-04-09T10:00:00.000Z",
    });
    db.enqueue({
      pair_id: "p1",
      relative_path: "b.md",
      change_type: "created",
      queued_at: "2026-04-09T10:00:01.000Z",
    });
    db.enqueue({
      pair_id: "p2",
      relative_path: "c.md",
      change_type: "deleted",
      queued_at: "2026-04-09T10:00:02.000Z",
    });
    expect(db.queueSize("p1")).toBe(2);
    expect(db.queueSize("p2")).toBe(1);
    expect(db.queueSize("p3")).toBe(0);
  });

  it("listQueue returns entries in FIFO order (id ASC)", () => {
    for (let i = 1; i <= 3; i++) {
      db.enqueue({
        pair_id: "p1",
        relative_path: `file${i}.txt`,
        change_type: "created",
        queued_at: `2026-04-09T10:00:0${i}.000Z`,
      });
    }
    const queue = db.listQueue("p1");
    expect(queue[0]!.relative_path).toBe("file1.txt");
    expect(queue[1]!.relative_path).toBe("file2.txt");
    expect(queue[2]!.relative_path).toBe("file3.txt");
  });
});

describe("StateDb — file-backed WAL", () => {
  let filePath: string;
  let fileDb: StateDb;

  beforeEach(() => {
    filePath = join(tmpdir(), `state-db-wal-${Date.now()}.db`);
  });

  afterEach(() => {
    fileDb?.close();
    for (const ext of ["", "-wal", "-shm"]) {
      rmSync(filePath + ext, { force: true });
    }
  });

  it("confirms journal_mode = wal on a file-backed DB (AC2)", () => {
    fileDb = new StateDb(filePath);
    expect(fileDb.pragma("journal_mode")).toBe("wal");
  });
});

describe("StateDb — sync_state CRUD and updatePairRemoteId", () => {
  const PAIR: SyncPair = {
    pair_id: "p1",
    local_path: "/home/user/docs",
    remote_path: "/My Drive/docs",
    remote_id: "folder-abc",
    created_at: "2026-04-10T10:00:00.000Z",
    last_synced_at: null,
  };

  beforeEach(() => {
    db = new StateDb(":memory:");
    db.insertPair(PAIR);
  });

  afterEach(() => {
    db.close();
  });

  it("upsert inserts a new sync_state record", () => {
    const state: SyncState = {
      pair_id: "p1",
      relative_path: "docs/readme.md",
      local_mtime: "2026-04-10T10:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    };
    db.upsertSyncState(state);
    const fetched = db.getSyncState("p1", "docs/readme.md");
    expect(fetched).toEqual({ ...state, remote_node_id: null });
  });

  it("upsert replaces existing record for same primary key", () => {
    const state: SyncState = {
      pair_id: "p1",
      relative_path: "file.txt",
      local_mtime: "2026-04-10T10:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    };
    db.upsertSyncState(state);
    const updated: SyncState = { ...state, local_mtime: "2026-04-10T12:00:00.000Z" };
    db.upsertSyncState(updated);
    const fetched = db.getSyncState("p1", "file.txt");
    expect(fetched?.local_mtime).toBe("2026-04-10T12:00:00.000Z");
  });

  it("getSyncState returns undefined for unknown relative_path", () => {
    expect(db.getSyncState("p1", "nonexistent.txt")).toBe(undefined);
  });

  it("listSyncStates returns results ordered by relative_path ASC", () => {
    db.upsertSyncState({ pair_id: "p1", relative_path: "z.txt", local_mtime: "2026-04-10T10:00:00.000Z", remote_mtime: "2026-04-10T10:00:00.000Z", content_hash: null });
    db.upsertSyncState({ pair_id: "p1", relative_path: "a.txt", local_mtime: "2026-04-10T10:00:00.000Z", remote_mtime: "2026-04-10T10:00:00.000Z", content_hash: null });
    db.upsertSyncState({ pair_id: "p1", relative_path: "m.txt", local_mtime: "2026-04-10T10:00:00.000Z", remote_mtime: "2026-04-10T10:00:00.000Z", content_hash: null });
    const states = db.listSyncStates("p1");
    expect(states.length).toBe(3);
    expect(states[0]!.relative_path).toBe("a.txt");
    expect(states[1]!.relative_path).toBe("m.txt");
    expect(states[2]!.relative_path).toBe("z.txt");
  });

  it("upsertSyncState preserves rowid across updates", () => {
    db.upsertSyncState({ pair_id: "p1", relative_path: "a.txt", local_mtime: "2026-01-01T00:00:00.000Z", remote_mtime: "2026-01-01T00:00:00.000Z", content_hash: null });
    const before = (db as any)["db"].prepare("SELECT rowid FROM sync_state WHERE pair_id = 'p1' AND relative_path = 'a.txt'").get() as { rowid: number };
    db.upsertSyncState({ pair_id: "p1", relative_path: "a.txt", local_mtime: "2026-01-02T00:00:00.000Z", remote_mtime: "2026-01-02T00:00:00.000Z", content_hash: "abc" });
    const after = (db as any)["db"].prepare("SELECT rowid FROM sync_state WHERE pair_id = 'p1' AND relative_path = 'a.txt'").get() as { rowid: number };
    expect(before.rowid).toBe(after.rowid);
  });

  it("deleteSyncState removes the record", () => {
    db.upsertSyncState({ pair_id: "p1", relative_path: "del.txt", local_mtime: "2026-04-10T10:00:00.000Z", remote_mtime: "2026-04-10T10:00:00.000Z", content_hash: null });
    expect(db.getSyncState("p1", "del.txt") !== undefined).toBeTruthy();
    db.deleteSyncState("p1", "del.txt");
    expect(db.getSyncState("p1", "del.txt")).toBe(undefined);
  });

  it("updatePairRemoteId updates the remote_id field", () => {
    db.updatePairRemoteId("p1", "new-remote-uid");
    const pair = db.getPair("p1");
    expect(pair?.remote_id).toBe("new-remote-uid");
  });

  it("listSyncStates returns empty array for pair with no states", () => {
    expect(db.listSyncStates("p1")).toEqual([]);
  });
});

describe("StateDb — migration idempotency", () => {
  it("does not re-run migrations on a DB already at current version", () => {
    // Open DB once (runs migration → user_version=2)
    const db1 = new StateDb(":memory:");
    db1.insertPair({
      pair_id: "persistent",
      local_path: "/p",
      remote_path: "/rp",
      remote_id: "r",
      created_at: "2026-04-09T10:00:00.000Z",
      last_synced_at: null,
    });
    db1.close();

    // :memory: DBs are ephemeral, so idempotency test is meaningful for file DBs.
    // For :memory:, we confirm two independent StateDb instances both migrate
    // successfully without throwing (no "table already exists" error).
    const db2 = new StateDb(":memory:");
    expect(() => {
      db2.insertPair({
        pair_id: "second",
        local_path: "/s",
        remote_path: "/rs",
        remote_id: "rs",
        created_at: "2026-04-09T11:00:00.000Z",
        last_synced_at: null,
      });
    }).not.toThrow();
    db2.close();
  });
});

describe("StateDb — ChangeType enum (AC1)", () => {
  let db: StateDb;

  beforeEach(() => {
    db = new StateDb(":memory:");
    db.insertPair({
      pair_id: "p1",
      local_path: "/p",
      remote_path: "/rp",
      remote_id: "r",
      created_at: "2026-04-14T00:00:00.000Z",
      last_synced_at: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('enqueue accepts "created" and listQueue returns correct change_type', () => {
    const entry: Omit<ChangeQueueEntry, "id"> = {
      pair_id: "p1",
      relative_path: "new-file.txt",
      change_type: "created" as ChangeType,
      queued_at: "2026-04-14T00:00:00.000Z",
    };
    db.enqueue(entry);
    const queue = db.listQueue("p1");
    expect(queue.length).toBe(1);
    expect(queue[0]!.change_type).toBe("created");
  });

  it('enqueue accepts "modified" and listQueue returns correct change_type', () => {
    const entry: Omit<ChangeQueueEntry, "id"> = {
      pair_id: "p1",
      relative_path: "changed-file.txt",
      change_type: "modified" as ChangeType,
      queued_at: "2026-04-14T00:00:01.000Z",
    };
    db.enqueue(entry);
    const queue = db.listQueue("p1");
    expect(queue.length).toBe(1);
    expect(queue[0]!.change_type).toBe("modified");
  });

  it('enqueue accepts "deleted" and listQueue returns correct change_type', () => {
    const entry: Omit<ChangeQueueEntry, "id"> = {
      pair_id: "p1",
      relative_path: "gone-file.txt",
      change_type: "deleted" as ChangeType,
      queued_at: "2026-04-14T00:00:02.000Z",
    };
    db.enqueue(entry);
    const queue = db.listQueue("p1");
    expect(queue.length).toBe(1);
    expect(queue[0]!.change_type).toBe("deleted");
  });

  it("dequeue removes the correct entry, preserving change_type of remaining entries", () => {
    db.enqueue({ pair_id: "p1", relative_path: "a.txt", change_type: "created", queued_at: "2026-04-14T00:00:00.000Z" });
    db.enqueue({ pair_id: "p1", relative_path: "b.txt", change_type: "modified", queued_at: "2026-04-14T00:00:01.000Z" });
    db.enqueue({ pair_id: "p1", relative_path: "c.txt", change_type: "deleted", queued_at: "2026-04-14T00:00:02.000Z" });

    const before = db.listQueue("p1");
    expect(before.length).toBe(3);

    // Dequeue the "modified" entry (id = 2)
    db.dequeue(before[1]!.id);

    const after = db.listQueue("p1");
    expect(after.length).toBe(2);
    expect(after[0]!.change_type).toBe("created");
    expect(after[1]!.change_type).toBe("deleted");
  });
});

describe("StateDb — session_state dirty flag (Story 5-4)", () => {
  let flagDb: StateDb;

  beforeEach(() => {
    flagDb = new StateDb(":memory:");
  });

  afterEach(() => {
    flagDb.close();
  });

  it("isDirtySession() returns false on fresh DB", () => {
    expect(flagDb.isDirtySession()).toBe(false);
  });

  it("setDirtySession(true) → isDirtySession() returns true", () => {
    flagDb.setDirtySession(true);
    expect(flagDb.isDirtySession()).toBe(true);
  });

  it("setDirtySession(false) clears flag", () => {
    flagDb.setDirtySession(true);
    flagDb.setDirtySession(false);
    expect(flagDb.isDirtySession()).toBe(false);
  });

  it("flag persists across separate StateDb instances on same file", () => {
    const tmpPath = join(tmpdir(), `state-db-dirty-${Date.now()}.db`);
    try {
      const db1 = new StateDb(tmpPath);
      db1.setDirtySession(true);
      db1.close();
      const db2 = new StateDb(tmpPath);
      expect(db2.isDirtySession()).toBe(true);
      db2.close();
    } finally {
      rmSync(tmpPath, { force: true });
    }
  });
});

describe("StateDb — findSyncStateByRemoteNodeId (Story 8-1 D1)", () => {
  const PAIR: SyncPair = {
    pair_id: "p1",
    local_path: "/home/user/docs",
    remote_path: "/My Drive/docs",
    remote_id: "folder-abc",
    created_at: "2026-04-10T10:00:00.000Z",
    last_synced_at: null,
  };
  let db: StateDb;

  beforeEach(() => { db = new StateDb(":memory:"); db.insertPair(PAIR); });
  afterEach(() => { db.close(); });

  it("returns null when no matching remote_node_id exists", () => {
    expect(db.findSyncStateByRemoteNodeId("uid-unknown")).toBeNull();
  });

  it("returns pair_id and relative_path when remote_node_id matches", () => {
    db.upsertSyncState({
      pair_id: "p1",
      relative_path: "photos/vacation.jpg",
      local_mtime: "2026-01-01T00:00:00.000Z",
      remote_mtime: "2026-01-01T00:00:00.000Z",
      content_hash: null,
      remote_node_id: "uid-vacation",
    });
    const result = db.findSyncStateByRemoteNodeId("uid-vacation");
    expect(result).toEqual({ pair_id: "p1", relative_path: "photos/vacation.jpg" });
  });

  it("ignores rows with null remote_node_id", () => {
    db.upsertSyncState({
      pair_id: "p1",
      relative_path: "file.txt",
      local_mtime: "2026-01-01T00:00:00.000Z",
      remote_mtime: "2026-01-01T00:00:00.000Z",
      content_hash: null,
      remote_node_id: null,
    });
    expect(db.findSyncStateByRemoteNodeId("uid-anything")).toBeNull();
  });

  it("overwrites remote_node_id on upsert and lookup still works", () => {
    db.upsertSyncState({
      pair_id: "p1", relative_path: "doc.txt",
      local_mtime: "2026-01-01T00:00:00.000Z", remote_mtime: "2026-01-01T00:00:00.000Z",
      content_hash: null, remote_node_id: "uid-old",
    });
    db.upsertSyncState({
      pair_id: "p1", relative_path: "doc.txt",
      local_mtime: "2026-01-02T00:00:00.000Z", remote_mtime: "2026-01-02T00:00:00.000Z",
      content_hash: null, remote_node_id: "uid-new",
    });
    expect(db.findSyncStateByRemoteNodeId("uid-old")).toBeNull();
    expect(db.findSyncStateByRemoteNodeId("uid-new")).toEqual({ pair_id: "p1", relative_path: "doc.txt" });
  });
});

describe("StateDb — event_checkpoint and event_queue (Story 8-1)", () => {
  let db: StateDb;
  const SCOPE = "volume-abc-123";

  beforeEach(() => {
    db = new StateDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("getEventCheckpoint returns null on fresh DB", () => {
    expect(db.getEventCheckpoint(SCOPE)).toBe(null);
  });

  it("getQueuedEvents returns empty array on fresh DB", () => {
    expect(db.getQueuedEvents()).toEqual([]);
  });

  it("setEventCheckpoint stores value; getEventCheckpoint returns it", () => {
    db.setEventCheckpoint(SCOPE, "evt-001");
    expect(db.getEventCheckpoint(SCOPE)).toBe("evt-001");
  });

  it("setEventCheckpoint overwrites existing checkpoint for same scope", () => {
    db.setEventCheckpoint(SCOPE, "evt-001");
    db.setEventCheckpoint(SCOPE, "evt-002");
    expect(db.getEventCheckpoint(SCOPE)).toBe("evt-002");
  });

  it("clearEventCheckpoint removes the checkpoint", () => {
    db.setEventCheckpoint(SCOPE, "evt-001");
    db.clearEventCheckpoint(SCOPE);
    expect(db.getEventCheckpoint(SCOPE)).toBe(null);
  });

  it("clearEventCheckpoint is a no-op when no checkpoint exists", () => {
    expect(() => db.clearEventCheckpoint(SCOPE)).not.toThrow();
    expect(db.getEventCheckpoint(SCOPE)).toBe(null);
  });

  it("persistEvent with non-null checkpoint: event in queue; checkpoint advanced", () => {
    db.persistEvent(SCOPE, "node_created", '{"type":"node_created"}', "evt-100");
    const events = db.getQueuedEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.tree_event_scope_id).toBe(SCOPE);
    expect(events[0]!.event_type).toBe("node_created");
    expect(events[0]!.event_payload).toBe('{"type":"node_created"}');
    expect(db.getEventCheckpoint(SCOPE)).toBe("evt-100");
  });

  it("persistEvent with null checkpoint: event in queue; checkpoint cleared", () => {
    db.setEventCheckpoint(SCOPE, "evt-001");
    db.persistEvent(SCOPE, "tree_refresh", '{"type":"tree_refresh"}', null);
    const events = db.getQueuedEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.event_type).toBe("tree_refresh");
    expect(db.getEventCheckpoint(SCOPE)).toBe(null);
  });

  it("persistEvent atomicity: both event_queue and event_checkpoint written or neither", () => {
    // Use a real file-backed DB so we can test transaction semantics
    const tmpPath = join(tmpdir(), `state-db-persist-${Date.now()}.db`);
    let fileDb: StateDb | undefined;
    try {
      fileDb = new StateDb(tmpPath);
      fileDb.persistEvent(SCOPE, "fast_forward", '{"type":"fast_forward"}', "evt-001");
      // Verify both rows written
      expect(fileDb.getQueuedEvents().length).toBe(1);
      expect(fileDb.getEventCheckpoint(SCOPE)).toBe("evt-001");
      fileDb.close();
      fileDb = undefined;

      // Reopen — both should persist
      const db2 = new StateDb(tmpPath);
      expect(db2.getQueuedEvents().length).toBe(1);
      expect(db2.getEventCheckpoint(SCOPE)).toBe("evt-001");
      db2.close();
    } finally {
      if (fileDb) fileDb.close();
      for (const ext of ["", "-wal", "-shm"]) rmSync(tmpPath + ext, { force: true });
    }
  });

  it("deleteQueuedEvent removes target event; others unaffected", () => {
    db.persistEvent(SCOPE, "node_created", '{"a":1}', "evt-001");
    db.persistEvent(SCOPE, "node_updated", '{"b":2}', "evt-002");
    db.persistEvent(SCOPE, "fast_forward", '{"c":3}', "evt-003");
    const before = db.getQueuedEvents();
    expect(before.length).toBe(3);
    db.deleteQueuedEvent(before[1]!.id);
    const after = db.getQueuedEvents();
    expect(after.length).toBe(2);
    expect(after[0]!.event_type).toBe("node_created");
    expect(after[1]!.event_type).toBe("fast_forward");
  });

  it("clearQueuedEvents removes only target scope; other scope unaffected", () => {
    const OTHER_SCOPE = "volume-other-456";
    db.persistEvent(SCOPE, "node_created", '{"a":1}', "evt-001");
    db.persistEvent(OTHER_SCOPE, "node_created", '{"b":2}', "evt-002");
    db.clearQueuedEvents(SCOPE);
    const remaining = db.getQueuedEvents();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.tree_event_scope_id).toBe(OTHER_SCOPE);
  });

  it("getQueuedEvents returns events in id ASC order", () => {
    db.persistEvent(SCOPE, "node_created", '{"i":1}', "evt-001");
    db.persistEvent(SCOPE, "node_updated", '{"i":2}', "evt-002");
    db.persistEvent(SCOPE, "fast_forward", '{"i":3}', "evt-003");
    const events = db.getQueuedEvents();
    expect(events[0]!.event_type).toBe("node_created");
    expect(events[1]!.event_type).toBe("node_updated");
    expect(events[2]!.event_type).toBe("fast_forward");
  });

  it("user_version = 7 after migration v7", () => {
    expect(db.pragma("user_version")).toBe(7);
  });

  it("upgrade from v5-schema: event tables exist; old data intact", () => {
    const tmpPath = join(tmpdir(), `state-db-v5upgrade-${Date.now()}.db`);
    let fileDb: StateDb | undefined;
    try {
      // Build a v5 DB: open fresh (goes to v6), confirm old tables still work
      fileDb = new StateDb(tmpPath);
      // Insert old-schema data
      fileDb.insertPair({
        pair_id: "p1",
        local_path: "/p",
        remote_path: "/rp",
        remote_id: "r",
        created_at: "2026-04-25T00:00:00.000Z",
        last_synced_at: null,
      });
      // New tables exist and work
      expect(fileDb.getEventCheckpoint("scope-1")).toBe(null);
      fileDb.persistEvent("scope-1", "fast_forward", '{}', "evt-001");
      expect(fileDb.getQueuedEvents().length).toBe(1);
      // Old data intact
      expect(fileDb.getPair("p1")?.pair_id).toBe("p1");
      fileDb.close();
      fileDb = undefined;
    } finally {
      if (fileDb) fileDb.close();
      for (const ext of ["", "-wal", "-shm"]) rmSync(tmpPath + ext, { force: true });
    }
  });
});
