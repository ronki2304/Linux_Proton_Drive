import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SyncEngine } from "./sync-engine.js";
import type { SyncPair, SyncStateRecord, DriveItem } from "../types.js";
import type { DriveClient } from "../sdk/client.js";
import type { StateDB } from "./state-db.js";

// ─── mock helpers ─────────────────────────────────────────────────────────────

interface CallTracker {
  uploadCalls: Array<[string, string]>;
  downloadCalls: Array<[string, string]>;
  listFolderCalls: string[];
  upsertCalls: SyncStateRecord[];
  getCalls: string[];
}

function makeTracker(): CallTracker {
  return {
    uploadCalls: [],
    downloadCalls: [],
    listFolderCalls: [],
    upsertCalls: [],
    getCalls: [],
  };
}

function makeStateDb(
  tracker: CallTracker,
  getImpl: (localPath: string) => SyncStateRecord | null = () => null,
): StateDB {
  return {
    get: (localPath: string) => {
      tracker.getCalls.push(localPath);
      return getImpl(localPath);
    },
    upsert: (record: SyncStateRecord) => {
      tracker.upsertCalls.push(record);
    },
  } as unknown as StateDB;
}

function makeDriveClient(
  tracker: CallTracker,
  opts: {
    listFolderImpl?: (remote: string) => Promise<DriveItem[]>;
    downloadImpl?: (remotePath: string, tmpPath: string) => Promise<void>;
    uploadImpl?: (localPath: string, remotePath: string) => Promise<void>;
  } = {},
): DriveClient {
  return {
    listFolder: async (remotePath: string): Promise<DriveItem[]> => {
      tracker.listFolderCalls.push(remotePath);
      return opts.listFolderImpl ? opts.listFolderImpl(remotePath) : Promise.resolve([]);
    },
    uploadFile: async (localPath: string, remotePath: string): Promise<void> => {
      tracker.uploadCalls.push([localPath, remotePath]);
      return opts.uploadImpl ? opts.uploadImpl(localPath, remotePath) : Promise.resolve();
    },
    downloadFile: async (remotePath: string, localPath: string): Promise<void> => {
      tracker.downloadCalls.push([remotePath, localPath]);
      return opts.downloadImpl ? opts.downloadImpl(remotePath, localPath) : Promise.resolve();
    },
  } as unknown as DriveClient;
}

const FAKE_TOKEN = { accessToken: "tok", uid: "u1" };
const PAIR_REMOTE = "/remote/docs";

function makePair(localDir: string): SyncPair {
  return { id: "pair-1", local: localDir, remote: PAIR_REMOTE };
}

// ─── fixtures ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-engine-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── delta skip ───────────────────────────────────────────────────────────────

describe("delta detection — skip unchanged files", () => {
  test("unchanged mtime → no transfer", async () => {
    const filePath = path.join(tmpDir, "file.txt");
    fs.writeFileSync(filePath, "hello");
    const mtime = fs.statSync(filePath).mtime.toISOString();

    const tracker = makeTracker();
    const stateDb = makeStateDb(tracker, () => ({
      syncPairId: "pair-1",
      localPath: filePath,
      remotePath: `${PAIR_REMOTE}/file.txt`,
      lastSyncMtime: mtime,
      lastSyncHash: "doesnotmatter",
      state: "synced",
    }));
    const client = makeDriveClient(tracker);
    const engine = new SyncEngine(stateDb);

    const result = await engine.run([makePair(tmpDir)], FAKE_TOKEN, client);

    expect(result.transferred).toBe(0);
    expect(tracker.uploadCalls).toHaveLength(0);
    expect(tracker.downloadCalls).toHaveLength(0);
  });

  test("mtime changed but hash identical → no upload, mtime updated in StateDB", async () => {
    const filePath = path.join(tmpDir, "file.txt");
    fs.writeFileSync(filePath, "same content");
    const { createHash } = await import("node:crypto");
    const currentHash = createHash("sha256")
      .update(fs.readFileSync(filePath))
      .digest("hex");

    const tracker = makeTracker();
    const stateDb = makeStateDb(tracker, () => ({
      syncPairId: "pair-1",
      localPath: filePath,
      remotePath: `${PAIR_REMOTE}/file.txt`,
      lastSyncMtime: "2026-01-01T00:00:00.000Z", // older mtime → triggers hash check
      lastSyncHash: currentHash, // same hash → should skip upload
      state: "synced",
    }));
    const client = makeDriveClient(tracker);
    const engine = new SyncEngine(stateDb);

    const result = await engine.run([makePair(tmpDir)], FAKE_TOKEN, client);

    expect(result.transferred).toBe(0);
    expect(tracker.uploadCalls).toHaveLength(0);
    // StateDB should be updated with new mtime
    expect(tracker.upsertCalls).toHaveLength(1);
    expect(tracker.upsertCalls[0]!.lastSyncHash).toBe(currentHash);
  });
});

// ─── local-only change → upload ───────────────────────────────────────────────

describe("local-only change", () => {
  test("new local file (no StateDB record) → uploaded to remote", async () => {
    const filePath = path.join(tmpDir, "new.txt");
    fs.writeFileSync(filePath, "brand new");

    const tracker = makeTracker();
    const stateDb = makeStateDb(tracker, () => null);
    const client = makeDriveClient(tracker);
    const engine = new SyncEngine(stateDb);

    const result = await engine.run([makePair(tmpDir)], FAKE_TOKEN, client);

    expect(result.transferred).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(tracker.uploadCalls).toHaveLength(1);
    expect(tracker.uploadCalls[0]![0]).toBe(filePath);
    expect(tracker.uploadCalls[0]![1]).toBe(`${PAIR_REMOTE}/new.txt`);
  });

  test("local file changed since last sync, remote not changed → upload", async () => {
    const filePath = path.join(tmpDir, "updated.txt");
    fs.writeFileSync(filePath, "new content");

    const LAST_SYNC_MTIME = "2026-03-01T10:00:00.000Z";
    const currentMtime = fs.statSync(filePath).mtime.toISOString();

    // Remote item has old mtime ≤ lastSyncMtime (not changed on remote)
    const tracker = makeTracker();
    const stateDb = makeStateDb(tracker, () => ({
      syncPairId: "pair-1",
      localPath: filePath,
      remotePath: `${PAIR_REMOTE}/updated.txt`,
      lastSyncMtime: LAST_SYNC_MTIME,
      lastSyncHash: "oldhash",
      state: "synced",
    }));
    const client = makeDriveClient(tracker, {
      listFolderImpl: async () => [
        {
          remotePath: `${PAIR_REMOTE}/updated.txt`,
          mtime: LAST_SYNC_MTIME, // remote mtime ≤ lastSyncMtime → no conflict
          isFolder: false,
          name: "updated.txt",
        },
      ],
    });
    const engine = new SyncEngine(stateDb);

    const result = await engine.run([makePair(tmpDir)], FAKE_TOKEN, client);

    expect(result.transferred).toBe(1);
    expect(tracker.uploadCalls).toHaveLength(1);
    expect(tracker.uploadCalls[0]![0]).toBe(filePath);
    // StateDB updated after upload
    expect(tracker.upsertCalls.some((r) => r.state === "synced")).toBe(true);
    expect(tracker.upsertCalls[0]!.lastSyncMtime).toBe(currentMtime);
  });

  test("upload failure → error recorded, transferred not incremented", async () => {
    const filePath = path.join(tmpDir, "fail.txt");
    fs.writeFileSync(filePath, "content");

    const tracker = makeTracker();
    const stateDb = makeStateDb(tracker, () => null);
    const client = makeDriveClient(tracker, {
      uploadImpl: async () => {
        throw new Error("Network timeout");
      },
    });
    const engine = new SyncEngine(stateDb);

    const result = await engine.run([makePair(tmpDir)], FAKE_TOKEN, client);

    expect(result.transferred).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Network timeout");
    expect(tracker.upsertCalls).toHaveLength(0);
  });
});

// ─── remote-only change → atomic download ─────────────────────────────────────

describe("remote-only change", () => {
  test("remote-only file downloaded atomically (via .protondrive-tmp)", async () => {
    const localDest = path.join(tmpDir, "from-remote.txt");
    const tmpPath = localDest + ".protondrive-tmp";

    const tracker = makeTracker();
    const stateDb = makeStateDb(tracker, () => null);
    const client = makeDriveClient(tracker, {
      listFolderImpl: async () => [
        {
          remotePath: `${PAIR_REMOTE}/from-remote.txt`,
          mtime: "2026-04-01T12:00:00.000Z",
          isFolder: false,
          name: "from-remote.txt",
        },
      ],
      downloadImpl: async (_remotePath: string, destPath: string) => {
        // downloadFile is called with tmpPath as destination
        fs.writeFileSync(destPath, "downloaded content");
      },
    });
    const engine = new SyncEngine(stateDb);

    const result = await engine.run([makePair(tmpDir)], FAKE_TOKEN, client);

    expect(result.transferred).toBe(1);
    expect(result.errors).toHaveLength(0);
    // Final file at localDest (renamed from tmp)
    expect(fs.existsSync(localDest)).toBe(true);
    expect(fs.readFileSync(localDest, "utf8")).toBe("downloaded content");
    // Tmp file cleaned up after rename
    expect(fs.existsSync(tmpPath)).toBe(false);
    // downloadFile was called with tmpPath as destination
    expect(tracker.downloadCalls[0]![1]).toBe(tmpPath);
    // StateDB updated
    expect(tracker.upsertCalls).toHaveLength(1);
    expect(tracker.upsertCalls[0]!.state).toBe("synced");
  });

  test("remote-only file — StateDB mtime matches → skip", async () => {
    // File does NOT exist locally — purely remote-only path
    const localDest = path.join(tmpDir, "known.txt");
    const REMOTE_MTIME = "2026-04-01T12:00:00.000Z";

    const tracker = makeTracker();
    const stateDb = makeStateDb(tracker, (localPath) =>
      localPath === localDest
        ? {
            syncPairId: "pair-1",
            localPath,
            remotePath: `${PAIR_REMOTE}/known.txt`,
            lastSyncMtime: REMOTE_MTIME, // matches remote → skip
            lastSyncHash: "somehash",
            state: "synced",
          }
        : null,
    );
    const client = makeDriveClient(tracker, {
      listFolderImpl: async () => [
        {
          remotePath: `${PAIR_REMOTE}/known.txt`,
          mtime: REMOTE_MTIME,
          isFolder: false,
          name: "known.txt",
        },
      ],
    });
    const engine = new SyncEngine(stateDb);

    const result = await engine.run([makePair(tmpDir)], FAKE_TOKEN, client);

    expect(result.transferred).toBe(0);
    expect(tracker.downloadCalls).toHaveLength(0);
  });
});

// ─── interrupted download cleanup ─────────────────────────────────────────────

describe("interrupted download cleanup", () => {
  test("download failure → .protondrive-tmp deleted, error recorded", async () => {
    // File does NOT exist locally — purely remote-only, tests tmp cleanup
    const localDest = path.join(tmpDir, "important.txt");
    const tmpPath = localDest + ".protondrive-tmp";

    const tracker = makeTracker();
    const stateDb = makeStateDb(tracker, () => null);
    const client = makeDriveClient(tracker, {
      listFolderImpl: async () => [
        {
          remotePath: `${PAIR_REMOTE}/important.txt`,
          mtime: "2026-04-02T08:00:00.000Z",
          isFolder: false,
          name: "important.txt",
        },
      ],
      downloadImpl: async (_remotePath: string, destPath: string) => {
        // Simulate partial write then failure
        fs.writeFileSync(destPath, "partial data");
        throw new Error("Connection reset");
      },
    });
    const engine = new SyncEngine(stateDb);

    const result = await engine.run([makePair(tmpDir)], FAKE_TOKEN, client);

    expect(result.transferred).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Connection reset");
    // tmp file must be cleaned up by atomic download error handler
    expect(fs.existsSync(tmpPath)).toBe(false);
    // final destination must NOT exist (no rename happened)
    expect(fs.existsSync(localDest)).toBe(false);
    // StateDB must NOT be updated
    expect(tracker.upsertCalls).toHaveLength(0);
  });
});

// ─── conflict detection ───────────────────────────────────────────────────────

describe("conflict: both sides changed since last sync", () => {
  test("conflict detected → conflict copy created, both uploaded, StateDB updated for both", async () => {
    const filePath = path.join(tmpDir, "shared.txt");
    fs.writeFileSync(filePath, "local changes");

    const LAST_SYNC_MTIME = "2026-03-30T10:00:00.000Z";
    const localMtime = fs.statSync(filePath).mtime.toISOString();

    const tracker = makeTracker();
    const stateDb = makeStateDb(tracker, () => ({
      syncPairId: "pair-1",
      localPath: filePath,
      remotePath: `${PAIR_REMOTE}/shared.txt`,
      lastSyncMtime: LAST_SYNC_MTIME,
      lastSyncHash: "oldhash",
      state: "synced",
    }));
    const client = makeDriveClient(tracker, {
      listFolderImpl: async () => [
        {
          remotePath: `${PAIR_REMOTE}/shared.txt`,
          mtime: "2026-04-01T09:00:00.000Z", // remote also changed after LAST_SYNC_MTIME
          isFolder: false,
          name: "shared.txt",
        },
      ],
    });
    const engine = new SyncEngine(stateDb);

    const result = await engine.run([makePair(tmpDir)], FAKE_TOKEN, client);

    // Conflict copy created on disk
    expect(result.conflicts).toHaveLength(1);
    const conflictRecord = result.conflicts[0]!;
    expect(fs.existsSync(conflictRecord.conflictCopy)).toBe(true);
    expect(conflictRecord.original).toBe(filePath);

    // Both original and conflict copy uploaded
    expect(tracker.uploadCalls).toHaveLength(2);
    const uploadedPaths = tracker.uploadCalls.map(([local]) => local);
    expect(uploadedPaths).toContain(filePath);
    expect(uploadedPaths).toContain(conflictRecord.conflictCopy);

    // 2 files transferred (original + conflict copy)
    expect(result.transferred).toBe(2);
    expect(result.errors).toHaveLength(0);

    // StateDB updated for both
    expect(tracker.upsertCalls).toHaveLength(2);
    const upsertedPaths = tracker.upsertCalls.map((r) => r.localPath);
    expect(upsertedPaths).toContain(filePath);
    expect(upsertedPaths).toContain(conflictRecord.conflictCopy);

    // Original record saved as "conflict" state
    const originalRecord = tracker.upsertCalls.find((r) => r.localPath === filePath)!;
    expect(originalRecord.state).toBe("conflict");
    expect(originalRecord.lastSyncMtime).toBe(localMtime);

    // Conflict copy record saved as "synced"
    const conflictCopyRecord = tracker.upsertCalls.find(
      (r) => r.localPath === conflictRecord.conflictCopy,
    )!;
    expect(conflictCopyRecord.state).toBe("synced");
  });

  test("conflict — original file not modified by conflict handling", async () => {
    const filePath = path.join(tmpDir, "myfile.txt");
    fs.writeFileSync(filePath, "my local version");

    const tracker = makeTracker();
    const stateDb = makeStateDb(tracker, () => ({
      syncPairId: "pair-1",
      localPath: filePath,
      remotePath: `${PAIR_REMOTE}/myfile.txt`,
      lastSyncMtime: "2026-03-01T00:00:00.000Z",
      lastSyncHash: "oldhash",
      state: "synced",
    }));
    const client = makeDriveClient(tracker, {
      listFolderImpl: async () => [
        {
          remotePath: `${PAIR_REMOTE}/myfile.txt`,
          mtime: "2026-04-01T08:00:00.000Z",
          isFolder: false,
          name: "myfile.txt",
        },
      ],
    });
    const engine = new SyncEngine(stateDb);

    await engine.run([makePair(tmpDir)], FAKE_TOKEN, client);

    // Original must be untouched
    expect(fs.readFileSync(filePath, "utf8")).toBe("my local version");
  });
});

// ─── idempotency ──────────────────────────────────────────────────────────────

describe("idempotency", () => {
  test("second run on synced folder transfers 0 files", async () => {
    const filePath = path.join(tmpDir, "synced.txt");
    fs.writeFileSync(filePath, "content");
    const currentMtime = fs.statSync(filePath).mtime.toISOString();
    const { createHash } = await import("node:crypto");
    const currentHash = createHash("sha256")
      .update(fs.readFileSync(filePath))
      .digest("hex");

    // Simulate state after first run: StateDB reflects current file state
    const tracker = makeTracker();
    const stateDb = makeStateDb(tracker, () => ({
      syncPairId: "pair-1",
      localPath: filePath,
      remotePath: `${PAIR_REMOTE}/synced.txt`,
      lastSyncMtime: currentMtime,
      lastSyncHash: currentHash,
      state: "synced",
    }));
    const client = makeDriveClient(tracker);
    const engine = new SyncEngine(stateDb);

    const result = await engine.run([makePair(tmpDir)], FAKE_TOKEN, client);

    expect(result.transferred).toBe(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(tracker.uploadCalls).toHaveLength(0);
    expect(tracker.downloadCalls).toHaveLength(0);
  });
});

// ─── error handling ───────────────────────────────────────────────────────────

describe("error handling", () => {
  test("listFolder failure → error recorded, sync pair skipped", async () => {
    const filePath = path.join(tmpDir, "file.txt");
    fs.writeFileSync(filePath, "data");

    const tracker = makeTracker();
    const stateDb = makeStateDb(tracker, () => null);
    const client = makeDriveClient(tracker, {
      listFolderImpl: async () => {
        throw new Error("Remote unreachable");
      },
    });
    const engine = new SyncEngine(stateDb);

    const result = await engine.run([makePair(tmpDir)], FAKE_TOKEN, client);

    expect(result.transferred).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Remote unreachable");
  });

  test("SyncResult returned even when all pairs fail", async () => {
    const tracker = makeTracker();
    const stateDb = makeStateDb(tracker, () => null);
    const client = makeDriveClient(tracker, {
      listFolderImpl: async () => {
        throw new Error("Boom");
      },
    });
    const engine = new SyncEngine(stateDb);

    const pairs: SyncPair[] = [
      { id: "p1", local: tmpDir, remote: "/r1" },
      { id: "p2", local: tmpDir, remote: "/r2" },
    ];

    const result = await engine.run(pairs, FAKE_TOKEN, client);

    expect(result.errors).toHaveLength(2);
    expect(result.transferred).toBe(0);
  });
});

// ─── multiple files ───────────────────────────────────────────────────────────

describe("multiple files in a directory", () => {
  test("all new local files are uploaded", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "aaa");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "bbb");
    fs.writeFileSync(path.join(tmpDir, "c.txt"), "ccc");

    const tracker = makeTracker();
    const stateDb = makeStateDb(tracker, () => null);
    const client = makeDriveClient(tracker);
    const engine = new SyncEngine(stateDb);

    const result = await engine.run([makePair(tmpDir)], FAKE_TOKEN, client);

    expect(result.transferred).toBe(3);
    expect(tracker.uploadCalls).toHaveLength(3);
    const uploadedNames = tracker.uploadCalls
      .map(([local]) => path.basename(local))
      .sort();
    expect(uploadedNames).toEqual(["a.txt", "b.txt", "c.txt"]);
  });
});
