import { describe, it, mock, spyOn, beforeEach, afterEach, expect } from "bun:test";
import fs from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FSWatcher, WatchListener } from "node:fs";
import type { IpcPushEvent } from "./ipc.js";
import type { SyncPair, ChangeQueueEntry } from "./state-db.js";
import { FileWatcher } from "./watcher.js";
import type { WatchFn } from "./watcher.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockWatcher(): FSWatcher {
  return { close: mock(() => {}), on: mock(() => {}) } as unknown as FSWatcher;
}

function makeTestPair(localPath: string): SyncPair {
  return {
    pair_id: "p1",
    local_path: localPath,
    remote_path: "/r",
    remote_id: "r1",
    created_at: "2026-01-01T00:00:00Z",
    last_synced_at: null,
  };
}

// ── watcher_status events ─────────────────────────────────────────────────────

describe("FileWatcher — watcher_status events (AC1, AC6)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("emits initializing then ready in order after initialize()", async () => {
    const mockWatcher = makeMockWatcher();
    const mockWatch = mock((_path: string, _listener: unknown): FSWatcher => mockWatcher);
    const emittedEvents: IpcPushEvent[] = [];
    let watchCallCountAtInitializing = -1;
    const onChanges = mock(async (_pairId: string) => {});
    const pair = makeTestPair(tmpDir);
    const fw = new FileWatcher(
      [pair],
      onChanges,
      (e) => {
        emittedEvents.push(e);
        if (
          e.type === "watcher_status" &&
          (e.payload as Record<string, unknown>)["status"] === "initializing"
        ) {
          watchCallCountAtInitializing = mockWatch.mock.calls.length;
        }
      },
      mockWatch as unknown as WatchFn,
      50,
    );

    await fw.initialize();

    const statusEvents = emittedEvents.filter((e) => e.type === "watcher_status");
    expect(statusEvents.length >= 2).toBeTruthy();
    expect(statusEvents[0]!.payload["status"]).toBe("initializing");
    expect(statusEvents[statusEvents.length - 1]!.payload["status"]).toBe("ready");
    expect(watchCallCountAtInitializing).toBe(0);
  });
});

// ── Debounce ──────────────────────────────────────────────────────────────────

describe("FileWatcher — debounce (AC2, AC6)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("N rapid change events within debounceMs → single onChangesDetected call", async () => {
    const mockWatcher = makeMockWatcher();
    const mockWatch = mock((_path: string, _listener: unknown): FSWatcher => mockWatcher);
    const onChanges = mock(async (_pairId: string) => {});
    const pair = makeTestPair(tmpDir);
    const fw = new FileWatcher(
      [pair],
      onChanges,
      (_e) => {},
      mockWatch as unknown as WatchFn,
      50,
    );

    await fw.initialize();

    // tmpDir has no subdirs → exactly 1 watchFn call
    expect(mockWatch.mock.calls.length >= 1).toBeTruthy();
    const listener = mockWatch.mock.calls[0]![1] as WatchListener<string>;

    // Fire 5 rapid events
    for (let i = 0; i < 5; i++) {
      listener("change", "file.txt");
    }

    // Wait for debounce (50ms) + buffer
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(onChanges.mock.calls.length).toBe(1);

    fw.stop();
  });

  it("event aggregation: changes from multiple dirs in same pair → single trigger", async () => {
    // Create one subdir so there are 2 watch registrations for same pair
    mkdirSync(join(tmpDir, "sub1"), { recursive: true });

    const mockWatchers: FSWatcher[] = [];
    const mockWatch = mock((_path: string, _listener: unknown): FSWatcher => {
      const w = makeMockWatcher();
      mockWatchers.push(w);
      return w;
    });
    const onChanges = mock(async (_pairId: string) => {});
    const pair = makeTestPair(tmpDir);
    const fw = new FileWatcher(
      [pair],
      onChanges,
      (_e) => {},
      mockWatch as unknown as WatchFn,
      50,
    );

    await fw.initialize();

    // Should have at least 2 watchFn calls (tmpDir + sub1)
    expect(mockWatch.mock.calls.length >= 2).toBeTruthy();

    // Fire events from 2 different dir listeners within debounce window
    const listener0 = mockWatch.mock.calls[0]![1] as WatchListener<string>;
    const listener1 = mockWatch.mock.calls[1]![1] as WatchListener<string>;
    listener0("change", "file1.txt");
    listener1("change", "file2.txt");

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(onChanges.mock.calls.length).toBe(1);

    fw.stop();
  });
});

// ── ENOSPC ────────────────────────────────────────────────────────────────────

describe("FileWatcher — ENOSPC handling (AC3, AC6)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    // Create 2 subdirs so dirs = [root, sub1, sub2] → 3 watchFn calls
    mkdirSync(join(tmpDir, "sub1"));
    mkdirSync(join(tmpDir, "sub2"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("ENOSPC on 3rd dir → INOTIFY_LIMIT error event, 2 watchers registered, no 4th call", async () => {
    const mockWatchers: FSWatcher[] = [];
    let callCount = 0;
    const mockWatch = mock((_path: string, _listener: unknown): FSWatcher => {
      callCount++;
      if (callCount === 3) {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      }
      const w = makeMockWatcher();
      mockWatchers.push(w);
      return w;
    });
    const emittedEvents: IpcPushEvent[] = [];
    const onChanges = mock(async (_pairId: string) => {});
    const pair = makeTestPair(tmpDir);
    const fw = new FileWatcher(
      [pair],
      onChanges,
      (e) => emittedEvents.push(e),
      mockWatch as unknown as WatchFn,
      50,
    );

    await fw.initialize();

    // Error event emitted with INOTIFY_LIMIT
    const errorEvent = emittedEvents.find((e) => e.type === "error");
    expect(errorEvent).toBeTruthy();
    expect(errorEvent!.payload["code"]).toBe("INOTIFY_LIMIT");
    expect(errorEvent!.payload["pair_id"]).toBe("p1");

    // Exactly 3 watchFn calls (no 4th after ENOSPC)
    expect(mockWatch.mock.calls.length).toBe(3);

    // Only 2 watchers successfully registered
    expect(mockWatchers.length).toBe(2);
  });
});

// ── stop() ────────────────────────────────────────────────────────────────────

describe("FileWatcher — stop() (AC4, AC6)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    // 2 subdirs → 3 dirs total
    mkdirSync(join(tmpDir, "sub1"));
    mkdirSync(join(tmpDir, "sub2"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("stop() closes all registered watchers and clears debounce timers", async () => {
    const mockWatchers: FSWatcher[] = [];
    const mockWatch = mock((_path: string, _listener: unknown): FSWatcher => {
      const w = makeMockWatcher();
      mockWatchers.push(w);
      return w;
    });
    const onChanges = mock(async (_pairId: string) => {});
    const pair = makeTestPair(tmpDir);
    const fw = new FileWatcher(
      [pair],
      onChanges,
      (_e) => {},
      mockWatch as unknown as WatchFn,
      50,
    );

    await fw.initialize();

    // Should have 3 watchers (tmpDir + sub1 + sub2)
    expect(mockWatchers.length).toBe(3);

    // Fire a listener to create a pending debounce timer
    const listener = mockWatch.mock.calls[0]![1] as WatchListener<string>;
    listener("change", "file.txt");

    // stop() should clear the timer and close all watchers
    fw.stop();

    // All close() mocks called
    for (const w of mockWatchers) {
      const closeCallCount = (w.close as ReturnType<typeof mock>).mock.calls.length;
      expect(closeCallCount).toBe(1);
    }

    // Wait longer than debounce — onChangesDetected must NOT have been called
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(onChanges.mock.calls.length).toBe(0);
  });
});

// ── onChangesDetected rejection handling (AC3) ────────────────────────────────

describe("FileWatcher — onChangesDetected rejection logging (AC3)", () => {
  let tmpDir: string;
  const originalDebug = process.env["PROTONDRIVE_DEBUG"];

  beforeEach(() => {
    tmpDir = join(tmpdir(), `watcher-reject-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env["PROTONDRIVE_DEBUG"] = "1";
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalDebug === undefined) {
      delete process.env["PROTONDRIVE_DEBUG"];
    } else {
      process.env["PROTONDRIVE_DEBUG"] = originalDebug;
    }
    mock.restore();
  });

  it("logs rejection via debugLog when onChangesDetected rejects; watcher does not crash", async () => {
    const pairId = "p1";
    // Spy on fs.appendFileSync so we can assert on the log message content
    // without reading files from disk. mockImplementation prevents actual
    // writes while still capturing call arguments.
    const appendSpy = spyOn(fs, "appendFileSync").mockImplementation(() => {});

    const mockWatcher = makeMockWatcher();
    const mockWatch = mock((_path: string, _listener: unknown): FSWatcher => mockWatcher);
    const onChanges = mock(async (_id: string) => {
      throw new Error("boom");
    });
    const pair = makeTestPair(tmpDir);

    const fw = new FileWatcher(
      [pair],
      onChanges,
      (_e) => {},
      mockWatch as unknown as WatchFn,
      0, // debounceMs=0 so timer fires immediately
    );

    try {
      await fw.initialize();

      // Trigger a change event to schedule the sync
      const listener = mockWatch.mock.calls[0]![1] as WatchListener<string>;
      listener("change", "file.txt");

      // Allow the microtask queue and the zero-ms timeout to flush
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      // Verify onChangesDetected was actually called (and threw)
      expect(onChanges.mock.calls.length).toBe(1);

      // Verify debugLog was called with a message containing the error text
      // and the pair ID — check appendFileSync call arguments directly.
      const logCall = appendSpy.mock.calls.find(
        (c) => typeof c[1] === "string" && (c[1] as string).includes("boom"),
      );
      expect(logCall).toBeDefined();
      expect(logCall![1] as string).toContain(pairId);
    } finally {
      fw.stop();
    }
  });
});

// ── Offline change queue ──────────────────────────────────────────────────────

describe("FileWatcher — offline change queue", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `watcher-offline-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  // 3.2 — online path: enqueueChange NOT called
  it("online: 'change' event → onChanges called, enqueueChange NOT called", async () => {
    const mockWatcher = makeMockWatcher();
    const mockWatch = mock((_path: string, _listener: unknown): FSWatcher => mockWatcher);
    const onChanges = mock(async (_pairId: string) => {});
    const enqueueCalls: Array<Omit<ChangeQueueEntry, "id">> = [];
    const pair = makeTestPair(tmpDir);

    const fw = new FileWatcher(
      [pair],
      onChanges,
      (_e) => {},
      mockWatch as unknown as WatchFn,
      0,            // debounceMs=0 so timer fires immediately
      () => true,   // isOnline = true
      (e) => enqueueCalls.push(e),
    );
    await fw.initialize();

    const listener = mockWatch.mock.calls[0]![1] as WatchListener<string>;
    listener("change", "file.txt");

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(onChanges.mock.calls.length).toBe(1);
    expect(enqueueCalls.length).toBe(0);

    fw.stop();
  });

  // 3.3 — offline + 'change' → change_type: "modified", scheduleSync NOT triggered
  it("offline: 'change' event → enqueueChange with change_type='modified', onChanges NOT called", async () => {
    const mockWatcher = makeMockWatcher();
    const mockWatch = mock((_path: string, _listener: unknown): FSWatcher => mockWatcher);
    const onChanges = mock(async (_pairId: string) => {});
    const enqueueCalls: Array<Omit<ChangeQueueEntry, "id">> = [];
    const pair = makeTestPair(tmpDir);

    const fw = new FileWatcher(
      [pair],
      onChanges,
      (_e) => {},
      mockWatch as unknown as WatchFn,
      0,             // debounceMs=0
      () => false,   // isOnline = false
      (e) => enqueueCalls.push(e),
    );
    await fw.initialize();

    const listener = mockWatch.mock.calls[0]![1] as WatchListener<string>;
    listener("change", "file.txt");

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(enqueueCalls.length).toBe(1);
    expect(enqueueCalls[0]!.change_type).toBe("modified");
    expect(onChanges.mock.calls.length).toBe(0);

    fw.stop();
  });

  // 3.4 — offline + 'rename' + file exists → change_type: "created"
  it("offline: 'rename' + file exists → change_type='created'", async () => {
    const mockWatcher = makeMockWatcher();
    const mockWatch = mock((_path: string, _listener: unknown): FSWatcher => mockWatcher);
    const enqueueCalls: Array<Omit<ChangeQueueEntry, "id">> = [];
    const pair = makeTestPair(tmpDir);

    const fw = new FileWatcher(
      [pair],
      mock(async () => {}),
      (_e) => {},
      mockWatch as unknown as WatchFn,
      undefined,
      () => false,
      (e) => enqueueCalls.push(e),
    );
    await fw.initialize();

    const tmpFile = join(tmpDir, "newfile.txt");
    writeFileSync(tmpFile, "");  // file exists

    const listener = mockWatch.mock.calls[0]![1] as WatchListener<string>;
    listener("rename", "newfile.txt");

    expect(enqueueCalls.length).toBe(1);
    expect(enqueueCalls[0]!.change_type).toBe("created");

    fw.stop();
  });

  // 3.5 — offline + 'rename' + file missing → change_type: "deleted"
  it("offline: 'rename' + file missing → change_type='deleted'", async () => {
    const mockWatcher = makeMockWatcher();
    const mockWatch = mock((_path: string, _listener: unknown): FSWatcher => mockWatcher);
    const enqueueCalls: Array<Omit<ChangeQueueEntry, "id">> = [];
    const pair = makeTestPair(tmpDir);

    const fw = new FileWatcher(
      [pair],
      mock(async () => {}),
      (_e) => {},
      mockWatch as unknown as WatchFn,
      undefined,
      () => false,
      (e) => enqueueCalls.push(e),
    );
    await fw.initialize();

    // Do NOT create ghost.txt — it should not exist
    const listener = mockWatch.mock.calls[0]![1] as WatchListener<string>;
    listener("rename", "ghost.txt");

    expect(enqueueCalls.length).toBe(1);
    expect(enqueueCalls[0]!.change_type).toBe("deleted");

    fw.stop();
  });

  // 3.6 — offline + null filename → enqueueChange NOT called, scheduleSync NOT called
  it("offline: null filename → enqueueChange NOT called, scheduleSync NOT called", async () => {
    const mockWatcher = makeMockWatcher();
    const mockWatch = mock((_path: string, _listener: unknown): FSWatcher => mockWatcher);
    const enqueueCalls: Array<Omit<ChangeQueueEntry, "id">> = [];
    const onChanges = mock(async (_pairId: string) => {});
    const pair = makeTestPair(tmpDir);

    const fw = new FileWatcher(
      [pair],
      onChanges,
      (_e) => {},
      mockWatch as unknown as WatchFn,
      0,
      () => false,
      (e) => enqueueCalls.push(e),
    );
    await fw.initialize();

    const listener = mockWatch.mock.calls[0]![1] as WatchListener<string>;
    listener("change", null);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(enqueueCalls.length).toBe(0);
    expect(onChanges.mock.calls.length).toBe(0);

    fw.stop();
  });

  // 3.7 — multiple offline events each enqueued (no debounce on queue writes)
  it("offline: 3 events on 3 filenames → enqueueChange called 3 times", async () => {
    const mockWatcher = makeMockWatcher();
    const mockWatch = mock((_path: string, _listener: unknown): FSWatcher => mockWatcher);
    const enqueueCalls: Array<Omit<ChangeQueueEntry, "id">> = [];
    const pair = makeTestPair(tmpDir);

    const fw = new FileWatcher(
      [pair],
      mock(async () => {}),
      (_e) => {},
      mockWatch as unknown as WatchFn,
      500,           // long debounce — queue writes should still fire immediately
      () => false,
      (e) => enqueueCalls.push(e),
    );
    await fw.initialize();

    const listener = mockWatch.mock.calls[0]![1] as WatchListener<string>;
    listener("change", "a.txt");
    listener("change", "b.txt");
    listener("change", "c.txt");

    // Should all be enqueued synchronously — no debounce involved
    expect(enqueueCalls.length).toBe(3);

    fw.stop();
  });

  // 3.8 — relative path is correct (no leading slash)
  it("relative path computed correctly — no leading slash", async () => {
    const mockWatcher = makeMockWatcher();
    const mockWatch = mock((_path: string, _listener: unknown): FSWatcher => mockWatcher);
    const enqueueCalls: Array<Omit<ChangeQueueEntry, "id">> = [];
    const pair = makeTestPair(tmpDir);

    const fw = new FileWatcher(
      [pair],
      mock(async () => {}),
      (_e) => {},
      mockWatch as unknown as WatchFn,
      undefined,
      () => false,
      (e) => enqueueCalls.push(e),
    );
    await fw.initialize();

    const listener = mockWatch.mock.calls[0]![1] as WatchListener<string>;
    listener("change", "notes.txt");

    expect(enqueueCalls.length).toBe(1);
    expect(enqueueCalls[0]!.relative_path).toBe("notes.txt");

    fw.stop();
  });
});

// ── Structural boundary ───────────────────────────────────────────────────────

describe("FileWatcher — structural boundary (AC6)", () => {
  it("watcher.ts has no drive-sdk import", () => {
    const srcDir = path.join(import.meta.dirname!, ".");
    const content = fs.readFileSync(path.join(srcDir, "watcher.ts"), "utf8");
    // Construct package name dynamically so this test file itself doesn't
    // trigger the sdk.test.ts boundary scanner.
    const sdkPkg = ["@protontech", "drive-sdk"].join("/");
    expect(!content.includes(sdkPkg)).toBeTruthy();
  });
});
