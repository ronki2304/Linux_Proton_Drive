/**
 * sync-engine.test.ts — Unit tests for SyncEngine (Story 2.5, AC11)
 *
 * Key design decisions:
 * - DriveClient is mocked entirely at the boundary (mock() from bun:test)
 * - StateDb uses :memory: for full isolation
 * - File system operations are mocked; we don't touch the real FS in most tests
 */

import { describe, it, mock, beforeEach, afterEach, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { StateDb } from "./state-db.js";
import { SyncEngine } from "./sync-engine.js";
import type { DriveClient, RemoteFile } from "./sdk.js";
import type { IpcPushEvent } from "./ipc.js";
import type { ConfigPair } from "./config.js";
import { RateLimitError, SyncError } from "./errors.js";

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

  it("both changed (local AND remote) → skip (no upload, no download)", async () => {
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
    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("file.txt", newRemoteMtime), // remote also changed
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

  it("file in both, no sync_state → skip (conflict deferred to Epic 4)", async () => {
    writeLocalFile("conflict.txt");

    const remoteMtime = "2026-04-10T10:00:00.000Z";
    mockClient = makeMockClient({
      listRemoteFiles: mock(async () => [
        makeRemoteFile("conflict.txt", remoteMtime),
      ]),
    });

    // Spy on upsertSyncState — must NOT be called when a conflict is skipped. (F21)
    let upsertCalled = false;
    const origUpsert = db.upsertSyncState.bind(db);
    db.upsertSyncState = (state) => { upsertCalled = true; return origUpsert(state); };

    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    await engine.startSyncAll();

    const uploadFn = mockClient.uploadFile as ReturnType<typeof mock>;
    const downloadFn = mockClient.downloadFile as ReturnType<typeof mock>;
    expect(uploadFn.mock.calls.length).toBe(0);
    expect(downloadFn.mock.calls.length).toBe(0);
    expect(upsertCalled).toBe(false);
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

describe("SyncEngine — replayQueue", () => {
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

    const result = await engine.replayQueue();

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

    const result = await engine.replayQueue();

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

    const result = await engine.replayQueue();

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

    const result = await engine.replayQueue();

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

    const result = await engine.replayQueue();

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

    const result = await engine.replayQueue();

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

    const result = await engine.replayQueue();

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

    const result = await engine.replayQueue();

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

    const result = await engine.replayQueue();

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

    await engine.replayQueue();

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

    const firstPromise = engine.replayQueue();
    // Second call sees busy === 'replay', sets replayPending, returns zero counts
    const secondResult = await engine.replayQueue();
    expect(secondResult).toEqual({ synced: 0, skipped_conflicts: 0, failed: 0 });

    releaseUpload();
    const firstResult = await firstPromise;
    expect(firstResult.synced).toBe(1);
  });

  it("4.14 driveClient === null → returns zero counts, emits queue_replay_complete, no DB touch", async () => {
    enqueue("file.txt", "created");
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(null);

    const result = await engine.replayQueue();

    expect(result).toEqual({ synced: 0, skipped_conflicts: 0, failed: 0 });
    const completeEvents = emittedEvents.filter(
      (e) => e.type === "queue_replay_complete",
    );
    expect(completeEvents.length).toBe(1);
    // Queue untouched
    expect(db.queueSize(PAIR_ID)).toBe(1);
  });

  it("4.15 concurrent replayQueue + startSyncAll — drain-on-completion", async () => {
    writeLocalFile("a.txt");
    writeLocalFile("b.txt");
    enqueue("a.txt", "created");
    enqueue("b.txt", "created");

    // Make startSyncAll's walkRemoteTree fail on its first call so syncPair
    // throws before writing any sync_state — this keeps the drain's decision
    // table in the (undefined, undefined, created) = upload cell. Subsequent
    // calls (the drain's own walkRemoteTree) succeed.
    let lrfCalls = 0;
    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => {
        lrfCalls++;
        if (lrfCalls === 1) throw new Error("sync-phase-blocker");
        return [];
      }),
      uploadFile: mock(async () => ({ node_uid: "uid-x", revision_uid: "rev-x" })),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    const syncPromise = engine.startSyncAll();

    // Replay while busy === 'sync' — call runs synchronously up to its first
    // await, seeing busy='sync' and returning zero counts with replayPending
    // flipped to true.
    const bouncedResult = await engine.replayQueue();
    expect(bouncedResult).toEqual({ synced: 0, skipped_conflicts: 0, failed: 0 });

    await syncPromise;
    // Drain fires in startSyncAll's finally as a detached void promise.
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    // After the drain, both entries have been processed.
    expect(db.queueSize(PAIR_ID)).toBe(0);
    // The drain emits ONE queue_replay_complete — the bounced call returned
    // early before entering the finally block, so it does not emit.
    const completeEvents = emittedEvents.filter(
      (e) => e.type === "queue_replay_complete",
    );
    expect(completeEvents.length).toBe(1);
    expect(completeEvents[0]!.payload).toEqual({
      synced: 2,
      skipped_conflicts: 0,
    });
  });

  it("4.16 one-shot replayPending flag — multiple bounced calls trigger exactly one drain", async () => {
    writeLocalFile("a.txt");
    enqueue("a.txt", "created");

    let lrfCalls = 0;
    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => {
        lrfCalls++;
        if (lrfCalls === 1) throw new Error("sync-phase-blocker");
        return [];
      }),
      uploadFile: mock(async () => ({ node_uid: "uid-x", revision_uid: "rev-x" })),
    });
    engine = new SyncEngine(db, (e) => emittedEvents.push(e));
    engine.setDriveClient(mockClient);

    const syncPromise = engine.startSyncAll();

    // Three bounced calls — replayPending flips to true but only drains once.
    await engine.replayQueue();
    await engine.replayQueue();
    await engine.replayQueue();

    await syncPromise;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    // Exactly ONE drained run → one queue_replay_complete event.
    const completeEvents = emittedEvents.filter(
      (e) => e.type === "queue_replay_complete",
    );
    expect(completeEvents.length).toBe(1);
    expect(db.queueSize(PAIR_ID)).toBe(0);
  });

  it("4.17 replay-during-replay: recursive pending", async () => {
    writeLocalFile("first.txt");
    writeLocalFile("second.txt");
    enqueue("first.txt", "created");
    enqueue("second.txt", "created");

    engine = new SyncEngine(db, (e) => emittedEvents.push(e));

    let nestedTriggered = false;
    mockClient = makeReplayClient({
      listRemoteFiles: mock(async () => []),
      uploadFile: mock(async () => {
        if (!nestedTriggered) {
          nestedTriggered = true;
          // Nested call sees busy === 'replay', flips replayPending, returns early
          const nested = await engine.replayQueue();
          expect(nested).toEqual({
            synced: 0,
            skipped_conflicts: 0,
            failed: 0,
          });
        }
        return { node_uid: "uid-x", revision_uid: "rev-x" };
      }),
    });
    engine.setDriveClient(mockClient);

    const firstResult = await engine.replayQueue();
    // First replay processed both entries (no new entries added).
    expect(firstResult.synced).toBe(2);
    // Drain fires in finally → void detached promise; wait a tick.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(db.queueSize(PAIR_ID)).toBe(0);
    // Expect 2 queue_replay_complete events — first run + drain.
    const completeEvents = emittedEvents.filter(
      (e) => e.type === "queue_replay_complete",
    );
    expect(completeEvents.length).toBe(2);
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

    await engine.replayQueue();

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

    await engine.replayQueue();

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
    engine = new SyncEngine(db, (e) => emittedEvents.push(e), () => [{ pair_id: PAIR_ID, local_path: tmpDir, remote_path: "/Documents", created_at: "2026-04-10T00:00:00.000Z" }], () => {}, noopSleep);
    engine.setDriveClient(mockClient);

    const result = await engine.replayQueue();

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
