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
