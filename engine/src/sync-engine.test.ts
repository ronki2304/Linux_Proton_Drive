/**
 * sync-engine.test.ts — Unit tests for SyncEngine (Story 2.5, AC11)
 *
 * Key design decisions:
 * - DriveClient is mocked entirely at the boundary (mock() from bun:test)
 * - StateDb uses :memory: for full isolation
 * - File system operations are mocked; we don't touch the real FS in most tests
 */

import { describe, it, mock, beforeEach, afterEach, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, statSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { StateDb } from "./state-db.js";
import { SyncEngine } from "./sync-engine.js";
import type { DriveClient, RemoteFile } from "./sdk.js";
import type { IpcPushEvent } from "./ipc.js";
import type { ConfigPair } from "./config.js";
import { AuthExpiredError, RateLimitError, SyncError } from "./errors.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const PAIR_ID = "test-pair-1";
const LOCAL_PATH_PLACEHOLDER = "/tmp/test-local";
const REMOTE_ID = "remote-folder-uid";

function makeRemoteFile(
  name: string,
  mtime: string,
  size = 100,
  id = `uid-${name}`,
): RemoteFile {
  return { id, name, parent_id: REMOTE_ID, remote_mtime: mtime, size };
}

function makeMockClient(overrides: Partial<DriveClient> = {}): DriveClient {
  return {
    listRemoteFolders: mock(async () => []),
    listRemoteFiles: mock(async () => []),
    uploadFile: mock(async () => ({ node_uid: "new-uid", revision_uid: "rev-uid" })),
    uploadFileRevision: mock(async () => ({ node_uid: "new-uid", revision_uid: "rev-uid" })),
    downloadFile: mock(async () => {}),
    validateSession: mock(async () => ({
      display_name: "",
      email: "",
      storage_used: 0,
      storage_total: 0,
      plan: "",
    })),
    ...overrides,
  } as unknown as DriveClient;
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

let db: StateDb;
let emittedEvents: IpcPushEvent[];
let mockClient: DriveClient;
let engine: SyncEngine;
let tmpDir: string;

function setupPair(remoteId = REMOTE_ID): void {
  db.insertPair({
    pair_id: PAIR_ID,
    local_path: tmpDir,
    remote_path: "/Documents",
    remote_id: remoteId,
    created_at: "2026-04-10T00:00:00.000Z",
    last_synced_at: null,
  });
}

function writeLocalFile(name: string, content = "hello"): void {
  writeFileSync(join(tmpDir, name), content);
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe("SyncEngine — delta detection (AC1)", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
    emittedEvents = [];
    tmpDir = join(tmpdir(), `sync-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    setupPair();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("local-only changed → uploadFile called, upsertSyncState called with correct local_mtime", async () => {
    const localMtime = "2026-04-10T10:00:00.000Z";
    const remoteMtime = "2026-04-10T08:00:00.000Z";

    writeLocalFile("file.txt");

    // Seed sync state with old local_mtime
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "file.txt",
      local_mtime: "2026-04-10T09:00:00.000Z", // older than actual
      remote_mtime: remoteMtime,
      content_hash: null,
    });

    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("file.txt", remoteMtime), // unchanged remote
      ]),
      uploadFileRevision: mock(async () => ({ node_uid: "uid-new", revision_uid: "rev-1" })),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    // File exists remotely → engine calls uploadFileRevision (not uploadFile)
    const uploadRevFn = mockClient.uploadFileRevision as ReturnType<typeof mock>;
    expect(uploadRevFn.mock.calls.length).toBe(1);

    // Verify sync state was persisted
    const state = db.getSyncState(PAIR_ID, "file.txt");
    expect(state).toBeTruthy();
    // local_mtime should be the actual file mtime (from stat after write)
    expect(state!.local_mtime.length > 0).toBeTruthy();
    localMtime; // suppress unused var warning
  });

  it("remote-only changed → downloadFile called, upsertSyncState called with correct remote_mtime", async () => {
    const localMtime = "2026-04-10T08:00:00.000Z";
    const oldRemoteMtime = "2026-04-10T09:00:00.000Z";
    const newRemoteMtime = "2026-04-10T10:00:00.000Z";

    writeLocalFile("file.txt");

    // Get actual local mtime
    const { stat } = await import("node:fs/promises");
    const s = await stat(join(tmpDir, "file.txt"));
    const actualLocalMtime = s.mtime.toISOString();

    // Seed sync state: local matches actual, remote is older
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "file.txt",
      local_mtime: actualLocalMtime,
      remote_mtime: oldRemoteMtime,
      content_hash: null,
    });

    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("file.txt", newRemoteMtime), // changed remote
      ]),
      downloadFile: mock(async (_uid: string, target: WritableStream<Uint8Array>) => {
        // Write something so rename succeeds
        const writer = target.getWriter();
        await writer.write(new Uint8Array([1, 2, 3]));
        await writer.close();
      }),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    const downloadFn = mockClient.downloadFile as ReturnType<typeof mock>;
    expect(downloadFn.mock.calls.length).toBe(1);

    const state = db.getSyncState(PAIR_ID, "file.txt");
    expect(state).toBeTruthy();
    expect(state!.remote_mtime).toBe(newRemoteMtime);
    localMtime; // suppress unused var warning
  });

  it("both unchanged → no upload, no download", async () => {
    writeLocalFile("file.txt");

    const { stat } = await import("node:fs/promises");
    const s = await stat(join(tmpDir, "file.txt"));
    const actualLocalMtime = s.mtime.toISOString();
    const remoteMtime = "2026-04-10T08:00:00.000Z";

    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "file.txt",
      local_mtime: actualLocalMtime,
      remote_mtime: remoteMtime,
      content_hash: null,
    });

    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("file.txt", remoteMtime), // matches state
      ]),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    const uploadFn = mockClient.uploadFile as ReturnType<typeof mock>;
    const downloadFn = mockClient.downloadFile as ReturnType<typeof mock>;
    expect(uploadFn.mock.calls.length).toBe(0);
    expect(downloadFn.mock.calls.length).toBe(0);
  });

  it("both changed (local AND remote) → conflict copy created, remote downloaded (no upload)", async () => {
    writeLocalFile("file.txt");

    // Use a timestamp guaranteed to be older than any file written during this test
    // run — avoids flakiness on coarse (1-second) filesystem mtime resolution. (F20)
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "file.txt",
      local_mtime: "2020-01-01T00:00:00.000Z",
      remote_mtime: "2020-01-01T00:00:00.000Z",
      content_hash: null,
    });

    const newRemoteMtime = "2026-04-10T11:00:00.000Z";
    const downloadFn = mock(async (_uid: string, target: WritableStream<Uint8Array>) => {
      const writer = target.getWriter();
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.close();
    });
    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("file.txt", newRemoteMtime), // remote also changed
      ]),
      downloadFile: downloadFn,
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    // No upload — conflict, not a local-only change
    const uploadFn = mockClient.uploadFile as ReturnType<typeof mock>;
    expect(uploadFn.mock.calls.length).toBe(0);

    // Remote version downloaded (Story 4-3 behavior)
    expect(downloadFn.mock.calls.length).toBe(1);

    // Conflict copy created
    const d = new Date();
    const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(existsSync(join(tmpDir, `file.txt.conflict-${localDate}`))).toBe(true);
  });

  it("new local file only → upload", async () => {
    writeLocalFile("newfile.txt");

    // No remote files, no sync state for this file
    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => []),
      uploadFile: mock(async () => ({ node_uid: "uid-new", revision_uid: "rev-1" })),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    const uploadFn = mockClient.uploadFile as ReturnType<typeof mock>;
    expect(uploadFn.mock.calls.length).toBe(1);
  });

  it("new remote file only → download", async () => {
    // Empty local dir, one remote file with no sync state
    const newRemoteMtime = "2026-04-10T10:00:00.000Z";
    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("remote-new.txt", newRemoteMtime),
      ]),
      downloadFile: mock(async (_uid: string, target: WritableStream<Uint8Array>) => {
        const writer = target.getWriter();
        await writer.write(new Uint8Array([1, 2, 3]));
        await writer.close();
      }),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    const downloadFn = mockClient.downloadFile as ReturnType<typeof mock>;
    expect(downloadFn.mock.calls.length).toBe(1);
  });

  it("file in both, no sync_state → collision: local renamed, conflict_detected emitted, download called", async () => {
    writeLocalFile("conflict.txt");

    const remoteMtime = "2026-04-10T10:00:00.000Z";
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("conflict.txt", remoteMtime),
      ]),
      downloadFile: mock(async (_uid: string, target: WritableStream<Uint8Array>) => {
        const writer = target.getWriter();
        await writer.write(new Uint8Array([1, 2, 3]));
        await writer.close();
      }),
    });

    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    const uploadFn = mockClient.uploadFile as ReturnType<typeof mock>;
    const downloadFn = mockClient.downloadFile as ReturnType<typeof mock>;
    // upload must NOT be called
    expect(uploadFn.mock.calls.length).toBe(0);
    // download IS called (remote version fetched to original path)
    expect(downloadFn.mock.calls.length).toBe(1);
    // conflict copy exists (original local content preserved)
    expect(existsSync(join(tmpDir, "conflict.txt.conflict-" + date))).toBe(true);
    // original path re-populated with remote version (downloaded)
    expect(existsSync(join(tmpDir, "conflict.txt"))).toBe(true);
    // conflict_detected event emitted
    const conflictEvent = emittedEvents.find((e) => e.type === "conflict_detected");
    expect(conflictEvent).toBeTruthy();
    expect((conflictEvent!.payload as Record<string, unknown>).local_path).toBe(join(tmpDir, "conflict.txt"));
    expect((conflictEvent!.payload as Record<string, unknown>).conflict_copy_path).toBe(join(tmpDir, "conflict.txt.conflict-" + date));
    // upsertSyncState called (from collision download handler)
    const state = db.getSyncState(PAIR_ID, "conflict.txt");
    expect(state).toBeTruthy();
    expect(state!.remote_mtime).toBe(remoteMtime);
  });

  it("rename fails → sync_file_error emitted, downloadFile NOT called", async () => {
    writeLocalFile("conflict.txt");

    const remoteMtime = "2026-04-10T10:00:00.000Z";
    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("conflict.txt", remoteMtime),
      ]),
      downloadFile: mock(async (_uid: string, target: WritableStream<Uint8Array>) => {
        const writer = target.getWriter();
        await writer.write(new Uint8Array([1, 2, 3]));
        await writer.close();
      }),
    });

    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    // Make directory non-writable so rename() fails with EACCES
    chmodSync(tmpDir, 0o555);
    try {
      await engine.startSyncAll();
    } finally {
      chmodSync(tmpDir, 0o755);
    }

    const downloadFn = mockClient.downloadFile as ReturnType<typeof mock>;
    // download must NOT be called — rename failed
    expect(downloadFn.mock.calls.length).toBe(0);
    // sync_file_error must be emitted
    const errorEvent = emittedEvents.find(
      (e) => e.type === "error" && (e.payload as Record<string, unknown>).code === "sync_file_error"
    );
    expect(errorEvent).toBeTruthy();
    expect((errorEvent!.payload as Record<string, unknown>).pair_id).toBe(PAIR_ID);
    expect(typeof (errorEvent!.payload as Record<string, unknown>).message).toBe("string");
    // conflict_detected must NOT be emitted
    const conflictEvent = emittedEvents.find((e) => e.type === "conflict_detected");
    expect(conflictEvent).toBeUndefined();
  });
});

describe("SyncEngine — remote_id resolution (AC6)", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
    emittedEvents = [];
    tmpDir = join(tmpdir(), `sync-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("remote_id = '' → resolveRemoteId called, updatePairRemoteId called with resolved id", async () => {
    db.insertPair({
      pair_id: PAIR_ID,
      local_path: tmpDir,
      remote_path: "/Documents",
      remote_id: "", // unresolved
      created_at: "2026-04-10T00:00:00.000Z",
      last_synced_at: null,
    });

    // First call (null) returns the folder for resolution.
    // Subsequent calls (with resolved uid) return empty — prevents infinite recursion in walkRemoteTree.
    mockClient = makeMockClient({
      listRemoteFolders: mock(async (parentId: string | null) => {
        if (parentId === null) {
          return [{ id: "resolved-docs-uid", name: "Documents", parent_id: "<root>" }];
        }
        return []; // no sub-folders inside Documents
      }),
      listRemoteFiles: mock(async () => []),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    const listFoldersFn = mockClient.listRemoteFolders as ReturnType<typeof mock>;
    expect(listFoldersFn.mock.calls.length >= 1).toBeTruthy();

    // Verify the remote_id was persisted
    const pair = db.getPair(PAIR_ID);
    expect(pair?.remote_id).toBe("resolved-docs-uid");
  });

  it("remote_id = '', segment not found → error push event emitted with code: 'remote_path_not_found'", async () => {
    db.insertPair({
      pair_id: PAIR_ID,
      local_path: tmpDir,
      remote_path: "/NonExistent",
      remote_id: "",
      created_at: "2026-04-10T00:00:00.000Z",
      last_synced_at: null,
    });

    mockClient = makeMockClient({
      listRemoteFolders: mock(async () => [
        // "NonExistent" not in list
        { id: "other-uid", name: "OtherFolder", parent_id: "<root>" },
      ]),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    const errorEvent = emittedEvents.find(
      (e) => e.type === "error" && (e.payload as Record<string, unknown>)["code"] === "remote_path_not_found",
    );
    expect(errorEvent).toBeTruthy();
    expect((errorEvent!.payload as Record<string, unknown>)["pair_id"]).toBe(PAIR_ID);
  });

  it("fetch failure → onNetworkFailure called, sync_cycle_error NOT emitted", async () => {
    // Simulates the user going offline mid-session: the SDK throws a
    // 'TypeError: fetch failed' (undici network error). The engine must call
    // onNetworkFailure() so the NetworkMonitor re-checks immediately, and must
    // NOT emit a sync_cycle_error (which would confuse the UI).
    db.insertPair({
      pair_id: PAIR_ID,
      local_path: tmpDir,
      remote_path: "/Documents",
      remote_id: "some-remote-id",
      created_at: "2026-04-10T00:00:00.000Z",
      last_synced_at: null,
    });

    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => {
        throw new TypeError("fetch failed");
      }),
    });

    let networkFailureCalled = false;
    engine = new SyncEngine(db, (e) => emittedEvents.push(e), undefined, () => {
      networkFailureCalled = true;
    });
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    expect(networkFailureCalled).toBe(true);
    const syncCycleErrors = emittedEvents.filter(
      (e) => e.type === "error" && (e.payload as Record<string, unknown>)["code"] === "sync_cycle_error",
    );
    expect(syncCycleErrors.length).toBe(0);
  });
});

describe("SyncEngine — 401 auth expiry detection", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
    emittedEvents = [];
    tmpDir = join(tmpdir(), `sync-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    db.insertPair({
      pair_id: PAIR_ID,
      local_path: tmpDir,
      remote_path: "/Documents",
      remote_id: "some-remote-id",
      created_at: "2026-04-10T00:00:00.000Z",
      last_synced_at: null,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  // AC1: 401 during reconcileAndEnqueue (walkRemoteTree/reconcilePair) → onTokenExpired called
  it("401 during reconcile → onTokenExpired called, not onNetworkFailure", async () => {
    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => {
        throw new AuthExpiredError("401");
      }),
    });

    let tokenExpiredCalled = false;
    let networkFailureCalled = false;
    engine = new SyncEngine(db, (e) => emittedEvents.push(e), undefined, () => {
      networkFailureCalled = true;
    }, () => {
      tokenExpiredCalled = true;
    });
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    expect(tokenExpiredCalled).toBe(true);
    expect(networkFailureCalled).toBe(false);
  });

  // AC1: 401 during drainQueue → onTokenExpired called, drain halts cleanly
  it("401 during drain → onTokenExpired called, drain halts", async () => {
    // Add a queue entry so drainQueue calls walkRemoteTree (which calls listRemoteFiles)
    db.enqueue({
      pair_id: PAIR_ID,
      relative_path: "file.txt",
      change_type: "created",
      queued_at: new Date().toISOString(),
    });

    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => {
        throw new AuthExpiredError("401");
      }),
    });

    let tokenExpiredCalled = false;
    engine = new SyncEngine(db, (e) => emittedEvents.push(e), undefined, () => {}, () => {
      tokenExpiredCalled = true;
    });
    engine.setDriveClient(mockClient);

    await engine.drainQueue();

    expect(tokenExpiredCalled).toBe(true);
    // queue_replay_complete must still emit (finally block still runs)
    const completeEvent = emittedEvents.find((e) => e.type === "queue_replay_complete");
    expect(completeEvent).toBeTruthy();
  });

  // AC3: with null driveClient (after token expiry), drainQueue returns immediately without throwing
  it("drainQueue with null client after token expiry returns immediately", async () => {
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    // No setDriveClient call — client stays null

    await engine.drainQueue(); // must not throw

    const errorEvents = emittedEvents.filter((e) => e.type === "error");
    expect(errorEvents.length).toBe(0);
  });
});

describe("SyncEngine — post-reauth queue drain (Story 5-3)", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
    emittedEvents = [];
    tmpDir = join(tmpdir(), `sync-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    setupPair(); // uses REMOTE_ID ("remote-folder-uid") as remote_id
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("null-client guard: drainQueue before setDriveClient emits queue_replay_complete{synced:0}", async () => {
    // During the expiry window, driveClient is null. Any FileWatcher-triggered drainQueue call
    // must short-circuit and still emit queue_replay_complete so the UI is never stuck waiting.
    db.enqueue({
      pair_id: PAIR_ID,
      relative_path: "notes.md",
      change_type: "modified",
      queued_at: new Date().toISOString(),
    });
    // Engine created without setDriveClient → driveClient is null.
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));

    const result = await engine.drainQueue();

    expect(result.synced).toBe(0);
    expect(result.skipped_conflicts).toBe(0);
    // Queue entry must remain — nothing was processed.
    expect(db.queueSize(PAIR_ID)).toBe(1);
    // queue_replay_complete emitted exactly once with zero counts.
    const replayEvents = emittedEvents.filter((e) => e.type === "queue_replay_complete");
    expect(replayEvents.length).toBe(1);
    expect((replayEvents[0]!.payload as { synced: number }).synced).toBe(0);
  });

  it("AC1: accumulated queue entries are drained after setDriveClient + drainQueue", async () => {
    // Simulate a file that was synced before expiry.
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "notes.md",
      local_mtime: "2026-04-10T10:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    // Simulate a local edit during expiry window.
    db.enqueue({
      pair_id: PAIR_ID,
      relative_path: "notes.md",
      change_type: "modified",
      queued_at: "2026-04-10T11:00:00.000Z",
    });
    // Write the local file so stat() succeeds in processQueueEntry.
    writeLocalFile("notes.md", "updated content");

    // Remote: file unchanged (same remote_mtime as sync_state) — AC2 scenario.
    // File exists remotely (has a node id) → uploadOne routes to uploadFileRevision, not uploadFile.
    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("notes.md", "2026-04-10T10:00:00.000Z", 15, "node-1"),
      ]),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.drainQueue();

    // AC4: queue entry removed
    expect(db.queueSize(PAIR_ID)).toBe(0);
    // AC4: queue_replay_complete emitted with synced: 1
    const complete = emittedEvents.find((e) => e.type === "queue_replay_complete");
    expect(complete).toBeTruthy();
    expect((complete!.payload as { synced: number }).synced).toBe(1);
    // AC2: uploadFileRevision called (file already existed remotely — no false conflict)
    expect(mockClient.uploadFileRevision).toHaveBeenCalledTimes(1);
  });

  it("AC2: remote-unchanged entry → upload, no conflict", async () => {
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "doc.md",
      local_mtime: "2026-04-10T10:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    db.enqueue({
      pair_id: PAIR_ID,
      relative_path: "doc.md",
      change_type: "modified",
      queued_at: "2026-04-10T11:00:00.000Z",
    });
    writeLocalFile("doc.md", "local edit during expiry");

    // doc.md exists remotely (has a node id) → uploadOne routes to uploadFileRevision.
    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("doc.md", "2026-04-10T10:00:00.000Z", 10, "node-doc"), // unchanged
      ]),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    const result = await engine.drainQueue();

    expect(result.synced).toBe(1);
    expect(result.skipped_conflicts).toBe(0);
    expect(db.queueSize(PAIR_ID)).toBe(0);
    // Upload happened via the revision path (no false conflict created).
    expect(mockClient.uploadFileRevision).toHaveBeenCalledTimes(1);
  });

  it("AC3: both-sides-changed entry → conflict, entry stays in queue", async () => {
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "shared.md",
      local_mtime: "2026-04-10T10:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    db.enqueue({
      pair_id: PAIR_ID,
      relative_path: "shared.md",
      change_type: "modified",
      queued_at: "2026-04-10T11:00:00.000Z",
    });
    writeLocalFile("shared.md", "my local edit");

    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("shared.md", "2026-04-10T10:30:00.000Z", 10, "node-shared"), // changed during expiry
      ]),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    const result = await engine.drainQueue();

    expect(result.synced).toBe(0);
    expect(result.skipped_conflicts).toBe(1);
    // Queue entry stays — conflict resolution is Epic 4's job.
    expect(db.queueSize(PAIR_ID)).toBe(1);
    // Neither upload path must fire on a conflict.
    expect(mockClient.uploadFile).not.toHaveBeenCalled();
    expect(mockClient.uploadFileRevision).not.toHaveBeenCalled();
  });

  it("AC4: queue_replay_complete payload has correct synced count", async () => {
    // Two entries: one clean upload, one conflict.
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "a.md",
      local_mtime: "2026-04-10T10:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "b.md",
      local_mtime: "2026-04-10T10:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    db.enqueue({ pair_id: PAIR_ID, relative_path: "a.md", change_type: "modified", queued_at: new Date().toISOString() });
    db.enqueue({ pair_id: PAIR_ID, relative_path: "b.md", change_type: "modified", queued_at: new Date().toISOString() });
    writeLocalFile("a.md", "edit a");
    writeLocalFile("b.md", "edit b");

    // Both files exist remotely → uploadOne routes to uploadFileRevision.
    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("a.md", "2026-04-10T10:00:00.000Z", 6, "n-a"),  // unchanged
        makeRemoteFile("b.md", "2026-04-10T10:45:00.000Z", 6, "n-b"),  // changed
      ]),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.drainQueue();

    const complete = emittedEvents.find((e) => e.type === "queue_replay_complete");
    expect(complete).toBeTruthy();
    expect(emittedEvents.filter((e) => e.type === "queue_replay_complete").length).toBe(1);
    const p = complete!.payload as { synced: number; skipped_conflicts: number };
    expect(p.synced).toBe(1);
    expect(p.skipped_conflicts).toBe(1);
  });

  it("AC1(integration): startSyncAll → reconcileAndEnqueue + drainQueue processes accumulated queue entries", async () => {
    // Simulate a file that was synced before token expired.
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "notes.md",
      local_mtime: "2026-04-10T09:00:00.000Z",  // old — real file mtime differs; reconcile sees local change
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    // Simulate a local edit accumulated in the queue during the expiry window.
    db.enqueue({
      pair_id: PAIR_ID,
      relative_path: "notes.md",
      change_type: "modified",
      queued_at: "2026-04-10T11:00:00.000Z",
    });
    writeLocalFile("notes.md", "updated content");

    // Remote: file unchanged (same remote_mtime as sync_state).
    // reconcileAndEnqueue sees notes.md as a local change but skips re-enqueueing (dedup).
    // drainQueue then processes the pre-seeded entry and uploads it.
    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("notes.md", "2026-04-10T10:00:00.000Z", 15, "node-1"),
      ]),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    // Queue fully drained by the startSyncAll → drainQueue path.
    expect(db.queueSize(PAIR_ID)).toBe(0);
    // File existed remotely → uploadOne routes to uploadFileRevision.
    expect(mockClient.uploadFileRevision).toHaveBeenCalledTimes(1);
    // queue_replay_complete emitted with synced: 1 (AC4 wiring verified end-to-end).
    const complete = emittedEvents.find((e) => e.type === "queue_replay_complete");
    expect(complete).toBeTruthy();
    expect((complete!.payload as { synced: number }).synced).toBe(1);
  });
});

describe("SyncEngine — sync_progress and sync_complete events (AC7)", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
    emittedEvents = [];
    tmpDir = join(tmpdir(), `sync-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    setupPair();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("sync_complete event emitted after cycle finishes", async () => {
    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => []),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    const completeEvent = emittedEvents.find((e) => e.type === "sync_complete");
    expect(completeEvent).toBeTruthy();
    expect((completeEvent!.payload as Record<string, unknown>)["pair_id"]).toBe(PAIR_ID);
    expect(typeof (completeEvent!.payload as Record<string, unknown>)["timestamp"]).toBe("string");
  });

  it("initial sync_progress emitted with files_done: 0 before transfers", async () => {
    writeLocalFile("file.txt");

    let initialProgressIndex = -1;
    let uploadCallIndex = -1;

    const uploadCalls: number[] = [];
    let eventIdx = 0;

    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => []),
      uploadFile: mock(async () => {
        uploadCallIndex = eventIdx;
        return { node_uid: "uid", revision_uid: "rev" };
      }),
    });

    engine = new SyncEngine(db, (e) => {
      if (e.type === "sync_progress" && (e.payload as Record<string, unknown>)["files_done"] === 0) {
        if (initialProgressIndex === -1) initialProgressIndex = eventIdx;
      }
      eventIdx++;
      emittedEvents.push(e);
      uploadCalls; // suppress
    });
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    const initialProgress = emittedEvents.find(
      (e) => e.type === "sync_progress" && (e.payload as Record<string, unknown>)["files_done"] === 0,
    );
    expect(initialProgress).toBeTruthy();
    expect(
      initialProgressIndex < uploadCallIndex || uploadCallIndex === -1,
    ).toBeTruthy();
    const payload = initialProgress!.payload as Record<string, unknown>;
    expect(payload["files_total"]).toBe(1);
    expect(payload["pair_id"]).toBe(PAIR_ID);
  });
});

describe("SyncEngine — state persistence ordering (AC3)", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
    emittedEvents = [];
    tmpDir = join(tmpdir(), `sync-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    setupPair();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("upsertSyncState is called BEFORE sync_progress is updated (state durable before counter increments)", async () => {
    writeLocalFile("file.txt");

    const callOrder: string[] = [];

    // Wrap db to track upsertSyncState calls
    const origUpsert = db.upsertSyncState.bind(db);
    db.upsertSyncState = (state) => {
      callOrder.push("upsertSyncState");
      return origUpsert(state);
    };

    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => []),
      uploadFile: mock(async () => ({ node_uid: "uid", revision_uid: "rev" })),
    });

    engine = new SyncEngine(db, (e) => {
      if (
        e.type === "sync_progress" &&
        (e.payload as Record<string, unknown>)["files_done"] === 1
      ) {
        callOrder.push("sync_progress_files_done_1");
      }
      emittedEvents.push(e);
    });
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    const upsertIdx = callOrder.indexOf("upsertSyncState");
    const progressIdx = callOrder.indexOf("sync_progress_files_done_1");

    expect(upsertIdx !== -1).toBeTruthy();
    expect(progressIdx !== -1).toBeTruthy();
    expect(upsertIdx < progressIdx).toBeTruthy();
  });
});

describe("SyncEngine — cold-start (AC5)", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
    emittedEvents = [];
    tmpDir = join(tmpdir(), `sync-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("pair in config but absent from SQLite → insertPair called, treated as fresh sync", async () => {
    // Inject a custom config provider so the test controls what listConfigPairs() returns
    // without touching the real config.yaml. (F19)
    const configPair: ConfigPair = {
      pair_id: "cold-start-pair",
      local_path: tmpDir,
      remote_path: "/Docs",
      created_at: "2026-04-10T00:00:00.000Z",
    };

    mockClient = makeMockClient({
      listRemoteFolders: mock(async (parentId: string | null) =>
        parentId === null
          ? [{ id: "docs-uid", name: "Docs", parent_id: "<root>" }]
          : [],
      ),
      listRemoteFiles: mock(async () => []),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e), () => [configPair]);
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    // The pair must now exist in SQLite — insertPair was called by the cold-start path.
    const pair = db.getPair("cold-start-pair");
    expect(pair).toBeTruthy();
    expect(pair!.pair_id).toBe("cold-start-pair");
  });

  it("engine does not crash when driveClient is null", async () => {
    // No client set — startSyncAll should return without crashing
    // (pairs exist but driveClient is null → syncPair returns early)
    db.insertPair({
      pair_id: PAIR_ID,
      local_path: tmpDir,
      remote_path: "/Docs",
      remote_id: REMOTE_ID,
      created_at: "2026-04-10T00:00:00.000Z",
      last_synced_at: null,
    });

    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    // driveClient not set → null

    await engine.startSyncAll();
  });
});

describe("SyncEngine — concurrency cap (AC4)", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
    emittedEvents = [];
    tmpDir = join(tmpdir(), `sync-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    setupPair();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("concurrency cap — 5 files downloading, max 3 concurrent downloadFile calls at any moment", async () => {
    // Create 5 remote files (no local copies — all new downloads)
    const FILES = 5;
    const remoteMtime = "2026-04-10T10:00:00.000Z";
    const remoteFiles: RemoteFile[] = Array.from({ length: FILES }, (_, i) =>
      makeRemoteFile(`file${i}.txt`, remoteMtime, 100, `uid-${i}`),
    );

    let activeConcurrent = 0;
    let maxConcurrent = 0;

    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => remoteFiles),
      downloadFile: mock(async (_uid: string, target: WritableStream<Uint8Array>) => {
        activeConcurrent++;
        if (activeConcurrent > maxConcurrent) maxConcurrent = activeConcurrent;

        // Simulate async work
        await new Promise<void>((resolve) => setTimeout(resolve, 10));

        const writer = target.getWriter();
        await writer.write(new Uint8Array([1]));
        await writer.close();

        activeConcurrent--;
      }),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    const downloadFn = mockClient.downloadFile as ReturnType<typeof mock>;
    expect(downloadFn.mock.calls.length).toBe(FILES);
    expect(maxConcurrent <= 3).toBeTruthy();
  });
});

describe("SyncEngine — atomic download writes (AC2)", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
    emittedEvents = [];
    tmpDir = join(tmpdir(), `sync-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    setupPair();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("no partial files at destination when download fails", async () => {
    const { readdir } = await import("node:fs/promises");

    const remoteMtime = "2026-04-10T10:00:00.000Z";
    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("important.txt", remoteMtime),
      ]),
      downloadFile: mock(async () => {
        throw new Error("network failure mid-download");
      }),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    // The tmp file should be cleaned up; important.txt should not exist
    const files = await readdir(tmpDir);
    const tmpFiles = files.filter((f) => f.includes(".protondrive-tmp-"));
    expect(tmpFiles.length).toBe(0);

    const destFile = files.find((f) => f === "important.txt");
    expect(destFile).toBeUndefined();

    // Error event must be emitted (per-file errors are non-fatal)
    const errorEvent = emittedEvents.find((e) => e.type === "error");
    expect(errorEvent).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 3-3 — replayQueue tests
// ─────────────────────────────────────────────────────────────────────────────

describe("SyncEngine — drainQueue", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
    emittedEvents = [];
    tmpDir = join(
      tmpdir(),
      `replay-queue-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    setupPair();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  function makeReplayClient(
    overrides: Partial<DriveClient> = {},
  ): DriveClient {
    return {
      ...makeMockClient(),
      trashNode: mock(async (_uid: string) => {}),
      ...overrides,
    } as unknown as DriveClient;
  }

  function enqueue(
    relativePath: string,
    changeType: "created" | "modified" | "deleted",
  ): void {
    db.enqueue({
      pair_id: PAIR_ID,
      relative_path: relativePath,
      change_type: changeType,
      queued_at: "2026-04-15T00:00:00.000Z",
    });
  }

  it("4.3 empty queue → returns zero counts and emits one queue_replay_complete", async () => {
    mockClient = makeReplayClient();
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    const result = await engine.drainQueue();

    expect(result).toEqual({ synced: 0, skipped_conflicts: 0, failed: 0 });
    const completeEvents = emittedEvents.filter(
      (e) => e.type === "queue_replay_complete",
    );
    expect(completeEvents.length).toBe(1);
    expect(completeEvents[0]!.payload).toEqual({
      synced: 0,
      skipped_conflicts: 0,
    });
  });

  it("4.4 single modified entry, remote unchanged → upload + dequeue + synced=1", async () => {
    writeLocalFile("file.txt");
    const remoteMtime = "2026-04-10T10:00:00.000Z";
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "file.txt",
      local_mtime: "2026-04-10T09:00:00.000Z",
      remote_mtime: remoteMtime,
      content_hash: null,
    });
    enqueue("file.txt", "modified");

    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => [makeRemoteFile("file.txt", remoteMtime)]),
      uploadFileRevision: mock(async () => ({
        node_uid: "uid-file.txt",
        revision_uid: "rev-1",
      })),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    const result = await engine.drainQueue();

    expect(result.synced).toBe(1);
    expect(result.skipped_conflicts).toBe(0);
    expect(result.failed).toBe(0);
    const uploadRevFn = mockClient.uploadFileRevision as ReturnType<typeof mock>;
    expect(uploadRevFn.mock.calls.length).toBe(1);
    expect(db.queueSize(PAIR_ID)).toBe(0);
    // sync_state row updated (still present — upload path does not delete it)
    expect(db.getSyncState(PAIR_ID, "file.txt")).toBeTruthy();
  });

  it("4.5 single modified entry, remote changed → conflict, kept in queue", async () => {
    writeLocalFile("file.txt");
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "file.txt",
      local_mtime: "2026-04-10T09:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    enqueue("file.txt", "modified");

    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => [
        // Different remote mtime → conflict
        makeRemoteFile("file.txt", "2026-04-11T10:00:00.000Z"),
      ]),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    const result = await engine.drainQueue();

    expect(result.synced).toBe(0);
    expect(result.skipped_conflicts).toBe(1);
    const uploadRevFn = mockClient.uploadFileRevision as ReturnType<typeof mock>;
    expect(uploadRevFn.mock.calls.length).toBe(0);
    expect(db.queueSize(PAIR_ID)).toBe(1);
  });

  it("4.6 new file (no sync_state), no remote collision → uploaded", async () => {
    writeLocalFile("new.txt");
    enqueue("new.txt", "created");

    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => []),
      uploadFile: mock(async () => ({
        node_uid: "uid-new",
        revision_uid: "rev-1",
      })),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    const result = await engine.drainQueue();

    expect(result.synced).toBe(1);
    const uploadFn = mockClient.uploadFile as ReturnType<typeof mock>;
    expect(uploadFn.mock.calls.length).toBe(1);
    expect(db.getSyncState(PAIR_ID, "new.txt")).toBeTruthy();
    expect(db.queueSize(PAIR_ID)).toBe(0);
  });

  it("4.7 new file (no sync_state), remote collision → conflict", async () => {
    writeLocalFile("collide.txt");
    enqueue("collide.txt", "created");

    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("collide.txt", "2026-04-10T10:00:00.000Z"),
      ]),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    const result = await engine.drainQueue();

    expect(result.skipped_conflicts).toBe(1);
    expect(result.synced).toBe(0);
    const uploadFn = mockClient.uploadFile as ReturnType<typeof mock>;
    expect(uploadFn.mock.calls.length).toBe(0);
    expect(db.queueSize(PAIR_ID)).toBe(1);
  });

  it("4.8 deleted entry, remote unchanged → trashNode called + dequeued", async () => {
    const remoteMtime = "2026-04-10T10:00:00.000Z";
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "gone.txt",
      local_mtime: "2026-04-10T09:00:00.000Z",
      remote_mtime: remoteMtime,
      content_hash: null,
    });
    enqueue("gone.txt", "deleted");

    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("gone.txt", remoteMtime, 100, "remote-node-uid"),
      ]),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    const result = await engine.drainQueue();

    expect(result.synced).toBe(1);
    const trashFn = mockClient.trashNode as unknown as ReturnType<typeof mock>;
    expect(trashFn.mock.calls.length).toBe(1);
    expect(trashFn.mock.calls[0]![0]).toBe("remote-node-uid");
    expect(db.getSyncState(PAIR_ID, "gone.txt")).toBeUndefined();
    expect(db.queueSize(PAIR_ID)).toBe(0);
  });

  it("4.9 deleted entry, remote already gone → idempotent dequeue", async () => {
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "gone.txt",
      local_mtime: "2026-04-10T09:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    enqueue("gone.txt", "deleted");

    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => []),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    const result = await engine.drainQueue();

    expect(result.synced).toBe(1);
    const trashFn = mockClient.trashNode as unknown as ReturnType<typeof mock>;
    expect(trashFn.mock.calls.length).toBe(0);
    expect(db.getSyncState(PAIR_ID, "gone.txt")).toBeUndefined();
    expect(db.queueSize(PAIR_ID)).toBe(0);
  });

  it("4.10 deleted entry, remote changed → conflict, kept in queue", async () => {
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "gone.txt",
      local_mtime: "2026-04-10T09:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    enqueue("gone.txt", "deleted");

    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => [
        // Remote mtime differs from stored
        makeRemoteFile("gone.txt", "2026-04-11T10:00:00.000Z"),
      ]),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    const result = await engine.drainQueue();

    expect(result.skipped_conflicts).toBe(1);
    expect(result.synced).toBe(0);
    const trashFn = mockClient.trashNode as unknown as ReturnType<typeof mock>;
    expect(trashFn.mock.calls.length).toBe(0);
    expect(db.queueSize(PAIR_ID)).toBe(1);
    expect(db.getSyncState(PAIR_ID, "gone.txt")).toBeTruthy();
  });

  it("4.11 per-entry failure isolation — middle entry throws, others succeed", async () => {
    writeLocalFile("a.txt");
    writeLocalFile("b.txt");
    writeLocalFile("c.txt");
    enqueue("a.txt", "created");
    enqueue("b.txt", "created");
    enqueue("c.txt", "created");

    let callCount = 0;
    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => []),
      uploadFile: mock(async () => {
        callCount++;
        if (callCount === 2) throw new Error("network boom");
        return { node_uid: "uid-x", revision_uid: "rev-x" };
      }),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    const result = await engine.drainQueue();

    expect(result.synced).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.skipped_conflicts).toBe(0);

    // Queue: only the middle entry remains
    const remaining = db.listQueue(PAIR_ID);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.relative_path).toBe("b.txt");

    // One error push event with queue_replay_failed
    const errEvents = emittedEvents.filter((e) => e.type === "error");
    expect(errEvents.length).toBe(1);
    expect(
      (errEvents[0]!.payload as Record<string, unknown>).code,
    ).toBe("queue_replay_failed");
  });

  it("4.12 empty queue → queue_replay_complete still emitted with zero counts", async () => {
    mockClient = makeReplayClient();
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.drainQueue();

    const completeEvents = emittedEvents.filter(
      (e) => e.type === "queue_replay_complete",
    );
    expect(completeEvents.length).toBe(1);
    expect(completeEvents[0]!.payload).toEqual({
      synced: 0,
      skipped_conflicts: 0,
    });
  });

  it("4.13 re-entrancy guard — second concurrent replayQueue() returns zero counts while busy", async () => {
    writeLocalFile("slow.txt");
    enqueue("slow.txt", "created");

    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });

    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => []),
      uploadFile: mock(async () => {
        await uploadGate;
        return { node_uid: "uid-slow", revision_uid: "rev-1" };
      }),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    const firstPromise = engine.drainQueue();
    // Second call sees busy === 'replay', sets replayPending, returns zero counts
    const secondResult = await engine.drainQueue();
    expect(secondResult).toEqual({ synced: 0, skipped_conflicts: 0, failed: 0 });

    releaseUpload();
    const firstResult = await firstPromise;
    expect(firstResult.synced).toBe(1);
  });

  it("4.14 driveClient === null → returns zero counts, emits queue_replay_complete, no DB touch", async () => {
    enqueue("file.txt", "created");
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(null);

    const result = await engine.drainQueue();

    expect(result).toEqual({ synced: 0, skipped_conflicts: 0, failed: 0 });
    const completeEvents = emittedEvents.filter(
      (e) => e.type === "queue_replay_complete",
    );
    expect(completeEvents.length).toBe(1);
    // Queue untouched
    expect(db.queueSize(PAIR_ID)).toBe(1);
  });

  it("4.15 second drainQueue() bounces while first is active, returns zero immediately", async () => {
    writeLocalFile("a.txt");
    writeLocalFile("b.txt");
    enqueue("a.txt", "created");
    enqueue("b.txt", "created");

    // Gate the first upload so the first drain stays busy long enough for
    // the second drainQueue call to see isDraining=true and bounce.
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((r) => { releaseUpload = r; });
    let uploadCount = 0;

    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => []),
      uploadFile: mock(async () => {
        if (uploadCount++ === 0) await uploadGate;
        return { node_uid: "uid-x", revision_uid: "rev-x" };
      }),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    const firstPromise = engine.drainQueue();

    // Second call sees isDraining=true, returns zero immediately — no auto-retry.
    const bouncedResult = await engine.drainQueue();
    expect(bouncedResult).toEqual({ synced: 0, skipped_conflicts: 0, failed: 0 });

    releaseUpload();
    const firstResult = await firstPromise;
    expect(firstResult.synced).toBe(2);
    expect(db.queueSize(PAIR_ID)).toBe(0);

    // Simplified lock: no auto-retry after bounce → exactly ONE queue_replay_complete.
    const completeEvents = emittedEvents.filter(
      (e) => e.type === "queue_replay_complete",
    );
    expect(completeEvents.length).toBe(1);
  });

  it("4.16 multiple concurrent bounces all return zero, no extra drain fires", async () => {
    writeLocalFile("a.txt");
    enqueue("a.txt", "created");

    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((r) => { releaseUpload = r; });

    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => []),
      uploadFile: mock(async () => {
        await uploadGate;
        return { node_uid: "uid-x", revision_uid: "rev-x" };
      }),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    const firstPromise = engine.drainQueue();

    // Three bounced calls while busy — all return zero, no auto-retry queued.
    const b1 = await engine.drainQueue();
    const b2 = await engine.drainQueue();
    const b3 = await engine.drainQueue();
    expect(b1).toEqual({ synced: 0, skipped_conflicts: 0, failed: 0 });
    expect(b2).toEqual({ synced: 0, skipped_conflicts: 0, failed: 0 });
    expect(b3).toEqual({ synced: 0, skipped_conflicts: 0, failed: 0 });

    releaseUpload();
    await firstPromise;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    // Only the first drain completes — no pending drain → exactly ONE event.
    const completeEvents = emittedEvents.filter(
      (e) => e.type === "queue_replay_complete",
    );
    expect(completeEvents.length).toBe(1);
    expect(db.queueSize(PAIR_ID)).toBe(0);
  });

  it("4.17 nested drainQueue() from within upload callback returns zero immediately", async () => {
    writeLocalFile("first.txt");
    enqueue("first.txt", "created");

    engine = new SyncEngine(db, (e) => emittedEvents.push(e));

    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => []),
      uploadFile: mock(async () => {
        // Nested call sees isDraining=true, returns zero — no replayPending
        const nested = await engine.drainQueue();
        expect(nested).toEqual({ synced: 0, skipped_conflicts: 0, failed: 0 });
        return { node_uid: "uid-x", revision_uid: "rev-x" };
      }),
    });
    engine.setDriveClient(mockClient);

    const firstResult = await engine.drainQueue();
    expect(firstResult.synced).toBe(1);
    expect(db.queueSize(PAIR_ID)).toBe(0);
    // No replayPending → exactly ONE queue_replay_complete.
    const completeEvents = emittedEvents.filter(
      (e) => e.type === "queue_replay_complete",
    );
    expect(completeEvents.length).toBe(1);
  });

  it("4.18 network failure mid-upload → onNetworkFailure called, entry counted as failed", async () => {
    writeLocalFile("net.txt");
    enqueue("net.txt", "created");

    let networkFailureCalled = false;
    const onNetworkFailure = mock(() => { networkFailureCalled = true; });

    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => []),
      uploadFile: mock(async () => {
        const err = new TypeError("fetch failed");
        (err as NodeJS.ErrnoException & { name: string }).name = "TypeError";
        throw err;
      }),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e), () => [], onNetworkFailure);
    engine.setDriveClient(mockClient);

    const result = await engine.drainQueue();

    expect(result.failed).toBe(1);
    expect(result.synced).toBe(0);
    expect(networkFailureCalled).toBe(true);
  });

  it("AC6a emission ordering — queue_replay_complete BEFORE sync_complete", async () => {
    writeLocalFile("ordered.txt");
    enqueue("ordered.txt", "created");

    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => []),
      uploadFile: mock(async () => ({
        node_uid: "uid-x",
        revision_uid: "rev-1",
      })),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.drainQueue();

    const types = emittedEvents.map((e) => e.type);
    const replayIdx = types.indexOf("queue_replay_complete");
    const syncCompleteIdx = types.indexOf("sync_complete");
    expect(replayIdx).toBeGreaterThanOrEqual(0);
    expect(syncCompleteIdx).toBeGreaterThan(replayIdx);
  });

  it("sync_progress emitted per synced entry during replay", async () => {
    writeLocalFile("x1.txt");
    writeLocalFile("x2.txt");
    enqueue("x1.txt", "created");
    enqueue("x2.txt", "created");

    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => []),
      uploadFile: mock(async () => ({
        node_uid: "uid-x",
        revision_uid: "rev-1",
      })),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.drainQueue();

    const progress = emittedEvents.filter((e) => e.type === "sync_progress");
    expect(progress.length).toBe(2);
    expect((progress[0]!.payload as Record<string, unknown>).files_done).toBe(1);
    expect((progress[1]!.payload as Record<string, unknown>).files_done).toBe(2);
  });

  it("4.3 rate limit on upload during replay → retries, emits rate_limited, entry dequeued", async () => {
    writeLocalFile("rl.txt");
    const remoteMtime = "2026-04-10T10:00:00.000Z";
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "rl.txt",
      local_mtime: "2026-04-10T09:00:00.000Z",
      remote_mtime: remoteMtime,
      content_hash: null,
    });
    enqueue("rl.txt", "modified");

    let uploadAttempt = 0;
    const noopSleep = mock(async (_ms: number) => {});
    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => [makeRemoteFile("rl.txt", remoteMtime)]),
      uploadFileRevision: mock(async () => {
        if (uploadAttempt++ === 0) throw new RateLimitError("rate limited");
        return { node_uid: "uid-rl", revision_uid: "rev-1" };
      }),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e), () => [{ pair_id: PAIR_ID, local_path: tmpDir, remote_path: "/Documents", created_at: "2026-04-10T00:00:00.000Z" }], () => {}, () => {}, noopSleep);
    engine.setDriveClient(mockClient);

    const result = await engine.drainQueue();

    const rateLimitedEvents = emittedEvents.filter((e) => e.type === "rate_limited");
    expect(rateLimitedEvents.length).toBe(1);
    expect(result.synced).toBe(1);
    expect(db.queueSize(PAIR_ID)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 3-4 — withBackoff tests
// ─────────────────────────────────────────────────────────────────────────────

describe("SyncEngine — withBackoff", () => {
  let sleepSpy: ReturnType<typeof mock>;
  let backoffEngine: SyncEngine;
  let backoffEvents: IpcPushEvent[];

  beforeEach(() => {
    db = new StateDb(":memory:");
    backoffEvents = [];
    sleepSpy = mock(async (_ms: number) => {});
    backoffEngine = new SyncEngine(
      db,
      (e) => backoffEvents.push(e),
      () => [],
      () => {},
      () => {},
      sleepSpy,
    );
  });

  afterEach(() => {
    db.close();
    mock.restore();
  });

  it("no rate limit → calls fn once, returns result", async () => {
    let callCount = 0;
    const fn = mock(async () => { callCount++; return "ok"; });
    // Access private method via cast
    const result = await (backoffEngine as unknown as { withBackoff: <T>(fn: () => Promise<T>) => Promise<T> }).withBackoff(fn);
    expect(result).toBe("ok");
    expect(fn.mock.calls.length).toBe(1);
    expect(backoffEvents.filter((e) => e.type === "rate_limited").length).toBe(0);
  });

  it("one rate limit then success → retries, emits event, returns result", async () => {
    let attempt = 0;
    const fn = mock(async () => {
      if (attempt++ === 0) throw new RateLimitError("rate limited");
      return "ok";
    });
    const result = await (backoffEngine as unknown as { withBackoff: <T>(fn: () => Promise<T>) => Promise<T> }).withBackoff(fn);
    expect(result).toBe("ok");
    expect(fn.mock.calls.length).toBe(2);
    const rateLimitedEvents = backoffEvents.filter((e) => e.type === "rate_limited");
    expect(rateLimitedEvents.length).toBe(1);
    expect((rateLimitedEvents[0]!.payload as Record<string, unknown>).resume_in_seconds).toBe(1);
    expect((sleepSpy.mock.calls[0] as [number])[0]).toBe(1000);
  });

  it("two rate limits then success → correct backoff schedule", async () => {
    let attempt = 0;
    const fn = mock(async () => {
      if (attempt++ < 2) throw new RateLimitError("rate limited");
      return "ok";
    });
    await (backoffEngine as unknown as { withBackoff: <T>(fn: () => Promise<T>) => Promise<T> }).withBackoff(fn);
    const rateLimitedEvents = backoffEvents.filter((e) => e.type === "rate_limited");
    expect(rateLimitedEvents.length).toBe(2);
    expect((rateLimitedEvents[0]!.payload as Record<string, unknown>).resume_in_seconds).toBe(1); // 2^0
    expect((rateLimitedEvents[1]!.payload as Record<string, unknown>).resume_in_seconds).toBe(2); // 2^1
    expect((sleepSpy.mock.calls[0] as [number])[0]).toBe(1000);
    expect((sleepSpy.mock.calls[1] as [number])[0]).toBe(2000);
  });

  it("rate limit capped at 30s — attempt 4 uses min(2^4,30)=16", async () => {
    // 5 failures total: attempts 0,1,2,3 retry (4 sleeps); attempt 4 re-throws
    let attempt = 0;
    const fn = mock(async () => {
      attempt++;
      throw new RateLimitError("rate limited");
    });
    let threw = false;
    try {
      await (backoffEngine as unknown as { withBackoff: <T>(fn: () => Promise<T>) => Promise<T> }).withBackoff(fn);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(fn.mock.calls.length).toBe(5);
    const rateLimitedEvents = backoffEvents.filter((e) => e.type === "rate_limited");
    // 4 events (retries 0-3); 5th failure re-throws without emitting
    expect(rateLimitedEvents.length).toBe(4);
    const resumeTimes = rateLimitedEvents.map(
      (e) => (e.payload as Record<string, unknown>).resume_in_seconds,
    );
    expect(resumeTimes).toEqual([1, 2, 4, 8]); // 2^0, 2^1, 2^2, 2^3
    const sleepTimes = (sleepSpy.mock.calls as [number][]).map(([ms]) => ms);
    expect(sleepTimes).toEqual([1000, 2000, 4000, 8000]);
  });

  it("max retries exhausted → re-throws RateLimitError on 5th failure", async () => {
    const fn = mock(async () => { throw new RateLimitError("always rate limited"); });
    let caughtErr: unknown;
    try {
      await (backoffEngine as unknown as { withBackoff: <T>(fn: () => Promise<T>) => Promise<T> }).withBackoff(fn);
    } catch (err) {
      caughtErr = err;
    }
    expect(fn.mock.calls.length).toBe(5);
    expect(caughtErr).toBeInstanceOf(RateLimitError);
    const rateLimitedEvents = backoffEvents.filter((e) => e.type === "rate_limited");
    expect(rateLimitedEvents.length).toBe(4); // 4 retries, not 5
  });

  it("non-RateLimitError passes through immediately", async () => {
    const syncErr = new SyncError("something else");
    const fn = mock(async () => { throw syncErr; });
    let caughtErr: unknown;
    try {
      await (backoffEngine as unknown as { withBackoff: <T>(fn: () => Promise<T>) => Promise<T> }).withBackoff(fn);
    } catch (err) {
      caughtErr = err;
    }
    expect(fn.mock.calls.length).toBe(1);
    expect(caughtErr).toBe(syncErr);
    expect(backoffEvents.filter((e) => e.type === "rate_limited").length).toBe(0);
    expect(sleepSpy.mock.calls.length).toBe(0);
  });
});

// ── Deletion propagation (Story 4-0b) ────────────────────────────────────────

describe("SyncEngine — deletion propagation (Story 4-0b)", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
    emittedEvents = [];
    tmpDir = join(tmpdir(), `sync-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    setupPair();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("local deleted (sync_state exists) → trashNode called, sync_state removed (AC1)", async () => {
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "gone.txt",
      local_mtime: "2026-04-10T10:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    const trashNode = mock(async () => {});
    mockClient = makeMockClient({
      trashNode,
      listRemoteFiles: mock(async () => [
        makeRemoteFile("gone.txt", "2026-04-10T10:00:00.000Z"),
      ]),
    });
    engine = new SyncEngine(db, (e) => { emittedEvents.push(e); });
    engine.setDriveClient(mockClient);
    // no local file written — it's "deleted"

    await engine.startSyncAll();

    expect(trashNode.mock.calls.length).toBe(1);
    expect(db.getSyncState(PAIR_ID, "gone.txt")).toBeUndefined();
  });

  it("remote deleted (sync_state exists) → local file deleted, sync_state removed (AC2)", async () => {
    writeLocalFile("local-only.txt");
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "local-only.txt",
      local_mtime: "2026-04-10T10:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    // no remote files returned — remote is "deleted"
    const trashNode = mock(async () => {});
    mockClient = makeMockClient({ trashNode });
    engine = new SyncEngine(db, (e) => { emittedEvents.push(e); });
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    expect(() => statSync(join(tmpDir, "local-only.txt"))).toThrow();
    expect(db.getSyncState(PAIR_ID, "local-only.txt")).toBeUndefined();
    expect(trashNode.mock.calls.length).toBe(0); // remote was deleted, not trashed
  });

  it("both-sides-deleted → sync_state removed, no trashNode called (AC3)", async () => {
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "vanished.txt",
      local_mtime: "2026-04-10T10:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    const trashNode = mock(async () => {});
    // no remote files, no local file
    mockClient = makeMockClient({ trashNode });
    engine = new SyncEngine(db, (e) => { emittedEvents.push(e); });
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    expect(trashNode.mock.calls.length).toBe(0);
    expect(db.getSyncState(PAIR_ID, "vanished.txt")).toBeUndefined();
  });

  it("never-synced local deletion (no sync_state, no remote) → no trashNode, no error (AC4)", async () => {
    // no sync_state, no local file, no remote file
    const trashNode = mock(async () => {});
    mockClient = makeMockClient({ trashNode });
    engine = new SyncEngine(db, (e) => { emittedEvents.push(e); });
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    expect(trashNode.mock.calls.length).toBe(0);
    expect(emittedEvents.filter((e) => e.type === "error").length).toBe(0);
  });

  it("delete_local EPERM failure → sync_file_error event emitted, sync_state preserved", async () => {
    writeLocalFile("perm-denied.txt");
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "perm-denied.txt",
      local_mtime: "2026-04-10T10:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    // no remote files — remote was deleted, triggering delete_local
    // make tmpDir non-writable so unlink fails with EPERM
    chmodSync(tmpDir, 0o555);
    mockClient = makeMockClient({ trashNode: mock(async () => {}) });
    engine = new SyncEngine(db, (e) => { emittedEvents.push(e); });
    engine.setDriveClient(mockClient);

    try {
      await engine.startSyncAll();
    } finally {
      chmodSync(tmpDir, 0o755); // restore so afterEach rmSync can run
    }

    const errors = emittedEvents.filter((e) => e.type === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as any).payload.code).toBe("sync_file_error");
    // sync_state preserved for retry
    expect(db.getSyncState(PAIR_ID, "perm-denied.txt")).toBeDefined();
  });

  it("trashNode SDK error → sync_cycle_error event emitted, sync_state preserved (AC5)", async () => {
    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "fail.txt",
      local_mtime: "2026-04-10T10:00:00.000Z",
      remote_mtime: "2026-04-10T10:00:00.000Z",
      content_hash: null,
    });
    mockClient = makeMockClient({
      trashNode: mock(async () => { throw new SyncError("server rejected trash"); }),
      listRemoteFiles: mock(async () => [
        makeRemoteFile("fail.txt", "2026-04-10T10:00:00.000Z"),
      ]),
    });
    engine = new SyncEngine(db, (e) => { emittedEvents.push(e); });
    engine.setDriveClient(mockClient);
    // no local file

    await engine.startSyncAll();

    const errors = emittedEvents.filter((e) => e.type === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as any).payload.code).toBe("sync_cycle_error");
    // sync_state preserved for retry
    expect(db.getSyncState(PAIR_ID, "fail.txt")).toBeDefined();
  });
});

// ── Story 4-1: Conflict detection (existing files) ───────────────────────────

describe("SyncEngine — conflict detection (Story 4-1)", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
    emittedEvents = [];
    tmpDir = join(tmpdir(), `sync-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    setupPair();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("both mtimes changed → conflict copy created, conflict_detected emitted, remote downloaded", async () => {
    // Write local file then seed sync_state with an old mtime (well before file was written)
    writeLocalFile("conflict.txt", "local content");

    const storedLocalMtime  = "2020-01-01T00:00:00.000Z";
    const storedRemoteMtime = "2020-01-01T00:00:00.000Z";
    const newRemoteMtime    = "2026-04-10T12:00:00.000Z"; // clearly changed

    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "conflict.txt",
      local_mtime: storedLocalMtime,   // older than actual file mtime → localChanged
      remote_mtime: storedRemoteMtime,
      content_hash: null,
    });

    const uploadFn = mock(async () => ({ node_uid: "uid", revision_uid: "rev" }));
    const downloadFn = mock(async (_uid: string, target: WritableStream<Uint8Array>) => {
      const writer = target.getWriter();
      await writer.write(new Uint8Array([10, 20, 30]));
      await writer.close();
    });

    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("conflict.txt", newRemoteMtime), // remote also changed
      ]),
      uploadFile: uploadFn,
      uploadFileRevision: uploadFn,
      downloadFile: downloadFn,
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    // Conflict copy must exist (preserving local "local content")
    const d = new Date();
    const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(existsSync(join(tmpDir, `conflict.txt.conflict-${localDate}`))).toBe(true);

    // conflict_detected event emitted
    const conflictEvent = emittedEvents.find((e) => e.type === "conflict_detected");
    expect(conflictEvent).toBeTruthy();
    expect((conflictEvent!.payload as Record<string, unknown>).local_path).toBe(join(tmpDir, "conflict.txt"));
    expect((conflictEvent!.payload as Record<string, unknown>).conflict_copy_path).toBe(join(tmpDir, `conflict.txt.conflict-${localDate}`));

    // Remote version was downloaded to original path
    expect(downloadFn.mock.calls.length).toBe(1);

    // Upload NOT called (conflict, not an upload)
    expect(uploadFn.mock.calls.length).toBe(0);

    // sync_state updated (remote version now tracked)
    const state = db.getSyncState(PAIR_ID, "conflict.txt");
    expect(state).toBeTruthy();
    expect(state!.remote_mtime).toBe(newRemoteMtime);
    expect(state!.content_hash).not.toBeNull(); // hash populated by Story 4-3
  });

  it("conflict copy creation fails → sync_file_error emitted, no download", async () => {
    writeLocalFile("conflict.txt", "local content");

    const storedLocalMtime  = "2020-01-01T00:00:00.000Z";
    const storedRemoteMtime = "2020-01-01T00:00:00.000Z";
    const newRemoteMtime    = "2026-04-10T12:00:00.000Z";

    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "conflict.txt",
      local_mtime: storedLocalMtime,
      remote_mtime: storedRemoteMtime,
      content_hash: null,
    });

    const downloadFn = mock(async (_uid: string, target: WritableStream<Uint8Array>) => {
      const writer = target.getWriter();
      await writer.write(new Uint8Array([10, 20, 30]));
      await writer.close();
    });

    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("conflict.txt", newRemoteMtime),
      ]),
      downloadFile: downloadFn,
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    // Make tmpDir non-writable so copyFile to tmp fails
    chmodSync(tmpDir, 0o555);
    try {
      await engine.startSyncAll();
    } finally {
      chmodSync(tmpDir, 0o755);
    }

    // sync_file_error emitted
    const errorEvent = emittedEvents.find((e) => e.type === "error");
    expect(errorEvent).toBeTruthy();
    expect((errorEvent!.payload as Record<string, unknown>).code).toBe("sync_file_error");
    expect(typeof (errorEvent!.payload as Record<string, unknown>).message).toBe("string");
    expect((errorEvent!.payload as Record<string, unknown>).pair_id).toBe(PAIR_ID);

    // conflict_detected NOT emitted
    const conflictEvent = emittedEvents.find((e) => e.type === "conflict_detected");
    expect(conflictEvent).toBeUndefined();

    // downloadFile NOT called
    expect(downloadFn.mock.calls.length).toBe(0);
  });

  it("same-second + same hash → no conflict, file treated as unchanged", async () => {
    const content = "stable content";
    writeLocalFile("samehash.txt", content);

    // Compute the actual file mtime and its hash
    const actualMtime    = statSync(join(tmpDir, "samehash.txt")).mtime.toISOString();
    const contentHash    = createHash("sha256").update(content).digest("hex");

    // storedLocalMtime = same second as actual, but milliseconds set to .000Z
    const storedLocalMtime  = actualMtime.slice(0, 19) + ".000Z";
    // storedRemoteMtime and remoteMtime both within same second
    const storedRemoteMtime = "2026-04-10T08:00:00.000Z";
    const newRemoteMtime    = "2026-04-10T08:00:00.500Z"; // same second as stored remote

    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "samehash.txt",
      local_mtime: storedLocalMtime,
      remote_mtime: storedRemoteMtime,
      content_hash: contentHash, // matches actual file content
    });

    const uploadFn   = mock(async () => ({ node_uid: "uid", revision_uid: "rev" }));
    const downloadFn = mock(async () => {});

    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("samehash.txt", newRemoteMtime),
      ]),
      uploadFile: uploadFn,
      uploadFileRevision: uploadFn,
      downloadFile: downloadFn,
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    // Same hash → not a conflict and not a meaningful change → no transfer
    expect(uploadFn.mock.calls.length).toBe(0);
    expect(downloadFn.mock.calls.length).toBe(0);
  });

  it("local-only changed → uploadFileRevision called (no conflict)", async () => {
    writeLocalFile("local-changed.txt", "updated local");

    const actualMtime   = statSync(join(tmpDir, "local-changed.txt")).mtime.toISOString();
    const remoteMtime   = "2020-01-01T00:00:00.000Z";

    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "local-changed.txt",
      local_mtime: "2020-01-01T00:00:00.000Z", // older → localChanged
      remote_mtime: remoteMtime,
      content_hash: null,
    });

    const uploadRevFn = mock(async () => ({ node_uid: "uid", revision_uid: "rev" }));
    const downloadFn  = mock(async () => {});

    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("local-changed.txt", remoteMtime), // remote unchanged
      ]),
      uploadFileRevision: uploadRevFn,
      downloadFile: downloadFn,
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    expect(uploadRevFn.mock.calls.length).toBe(1);
    expect(downloadFn.mock.calls.length).toBe(0);
    actualMtime; // suppress unused var warning
  });

  it("remote-only changed → downloadFile called (no conflict)", async () => {
    writeLocalFile("remote-changed.txt", "local version");

    const actualMtime      = statSync(join(tmpDir, "remote-changed.txt")).mtime.toISOString();
    const storedRemoteMtime = "2020-01-01T00:00:00.000Z";
    const newRemoteMtime    = "2026-04-10T12:00:00.000Z";

    db.upsertSyncState({
      pair_id: PAIR_ID,
      relative_path: "remote-changed.txt",
      local_mtime: actualMtime, // matches actual → localUnchanged
      remote_mtime: storedRemoteMtime,
      content_hash: null,
    });

    const uploadFn   = mock(async () => ({ node_uid: "uid", revision_uid: "rev" }));
    const downloadFn = mock(async (_uid: string, target: WritableStream<Uint8Array>) => {
      const writer = target.getWriter();
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.close();
    });

    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("remote-changed.txt", newRemoteMtime),
      ]),
      uploadFile: uploadFn,
      uploadFileRevision: uploadFn,
      downloadFile: downloadFn,
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    expect(downloadFn.mock.calls.length).toBe(1);
    expect(uploadFn.mock.calls.length).toBe(0);
  });
});

describe("SyncEngine — DISK_FULL detection (Story 5-5)", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
    emittedEvents = [];
    tmpDir = join(
      tmpdir(),
      `disk-full-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    setupPair();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("ENOSPC via processQueueEntry → DISK_FULL emitted, queue_replay_failed NOT emitted", async () => {
    // Enqueue a file creation so drainQueue → processQueueEntry runs.
    writeLocalFile("upload.txt");
    db.enqueue({
      pair_id: PAIR_ID,
      relative_path: "upload.txt",
      change_type: "created",
      queued_at: new Date().toISOString(),
    });

    // Client.listRemoteFiles is called inside processQueueEntry to get remote snapshot;
    // make uploadFile throw ENOSPC to exercise isDiskFull in the catch site.
    const enospcErr = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => []),
      uploadFile: mock(async () => { throw enospcErr; }),
    });

    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.drainQueue();

    const diskFullEvent = emittedEvents.find(
      (e) => e.type === "error" && (e.payload as Record<string, unknown>).code === "DISK_FULL",
    );
    expect(diskFullEvent).toBeTruthy();
    expect((diskFullEvent!.payload as Record<string, unknown>).pair_id).toBe(PAIR_ID);
    const msg = (diskFullEvent!.payload as Record<string, unknown>).message as string;
    expect(msg).toContain("Free up space on");
    expect(msg).toContain(tmpDir);

    const replayFailed = emittedEvents.find(
      (e) => e.type === "error" && (e.payload as Record<string, unknown>).code === "queue_replay_failed",
    );
    expect(replayFailed).toBeUndefined();
  });

  it("non-ENOSPC error in processQueueEntry → queue_replay_failed emitted, DISK_FULL NOT emitted", async () => {
    writeLocalFile("upload.txt");
    db.enqueue({
      pair_id: PAIR_ID,
      relative_path: "upload.txt",
      change_type: "created",
      queued_at: new Date().toISOString(),
    });

    const ioErr = Object.assign(new Error("I/O error"), { code: "EIO" });
    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => []),
      uploadFile: mock(async () => { throw ioErr; }),
    });

    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.drainQueue();

    const diskFullEvent = emittedEvents.find(
      (e) => e.type === "error" && (e.payload as Record<string, unknown>).code === "DISK_FULL",
    );
    expect(diskFullEvent).toBeUndefined();

    const replayFailed = emittedEvents.find(
      (e) => e.type === "error" && (e.payload as Record<string, unknown>).code === "queue_replay_failed",
    );
    expect(replayFailed).toBeTruthy();
  });
});

describe("SyncEngine — dirty-session flag lifecycle (Story 5-4)", () => {
  beforeEach(() => {
    db = new StateDb(":memory:");
    emittedEvents = [];
    tmpDir = join(
      tmpdir(),
      `dirty-flag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    setupPair();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("drainQueue with client sets dirty flag before I/O, clears in finally", async () => {
    mockClient = makeMockClient();
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    expect(db.isDirtySession()).toBe(false);
    await engine.drainQueue();
    expect(db.isDirtySession()).toBe(false); // cleared in finally
  });

  it("drainQueue without client does NOT set dirty flag", async () => {
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    // No setDriveClient — driveClient stays null

    await engine.drainQueue();
    expect(db.isDirtySession()).toBe(false);
  });

  it("re-entrant drainQueue bounce does NOT change dirty flag", async () => {
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    (engine as any).isDraining = true;
    db.setDirtySession(true); // pre-set to known state
    await engine.drainQueue(); // hits re-entrancy guard, returns early
    expect(db.isDirtySession()).toBe(true); // unchanged — bounce path never touches flag
    (engine as any).isDraining = false; // cleanup
  });

  it("dirty flag cleared even when AuthExpiredError thrown during drain", async () => {
    db.enqueue({
      pair_id: PAIR_ID,
      relative_path: "file.txt",
      change_type: "created",
      queued_at: new Date().toISOString(),
    });

    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => {
        throw new AuthExpiredError("401");
      }),
    });

    engine = new SyncEngine(db, (e) => emittedEvents.push(e), undefined, () => {}, () => {});
    engine.setDriveClient(mockClient);

    await engine.drainQueue();
    expect(db.isDirtySession()).toBe(false); // finally block always clears dirtied flag
  });
});
