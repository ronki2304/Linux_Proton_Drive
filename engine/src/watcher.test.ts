import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FSWatcher, WatchListener } from "node:fs";
import type { IpcPushEvent } from "./ipc.js";
import type { SyncPair } from "./state-db.js";
import { FileWatcher } from "./watcher.js";
import type { WatchFn } from "./watcher.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockWatcher(): FSWatcher {
  return { close: mock.fn(), on: mock.fn() } as unknown as FSWatcher;
}

function makeTestPair(localPath: string): SyncPair {
  return {
    pair_id: "p1",
    local_path: localPath,
    remote_path: "/r",
    remote_id: "r1",
    created_at: "2026-01-01T00:00:00Z",
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
    mock.restoreAll();
  });

  it("emits initializing then ready in order after initialize()", async () => {
    const mockWatcher = makeMockWatcher();
    const mockWatch = mock.fn((_path: string, _listener: unknown): FSWatcher => mockWatcher);
    const emittedEvents: IpcPushEvent[] = [];
    let watchCallCountAtInitializing = -1;
    const onChanges = mock.fn(async (_pairId: string) => {});
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
          watchCallCountAtInitializing = mockWatch.mock.callCount();
        }
      },
      mockWatch as unknown as WatchFn,
      50,
    );

    await fw.initialize();

    const statusEvents = emittedEvents.filter((e) => e.type === "watcher_status");
    assert.ok(statusEvents.length >= 2, "should emit at least 2 watcher_status events");
    assert.equal(statusEvents[0]!.payload["status"], "initializing");
    assert.equal(statusEvents[statusEvents.length - 1]!.payload["status"], "ready");
    assert.equal(watchCallCountAtInitializing, 0, "initializing emitted before any watchFn call");
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
    mock.restoreAll();
  });

  it("N rapid change events within debounceMs → single onChangesDetected call", async () => {
    const mockWatcher = makeMockWatcher();
    const mockWatch = mock.fn((_path: string, _listener: unknown): FSWatcher => mockWatcher);
    const onChanges = mock.fn(async (_pairId: string) => {});
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
    assert.ok(mockWatch.mock.callCount() >= 1, "watchFn should be called at least once");
    const listener = mockWatch.mock.calls[0]!.arguments[1] as WatchListener<string>;

    // Fire 5 rapid events
    for (let i = 0; i < 5; i++) {
      listener("change", "file.txt");
    }

    // Wait for debounce (50ms) + buffer
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(onChanges.mock.callCount(), 1);

    fw.stop();
  });

  it("event aggregation: changes from multiple dirs in same pair → single trigger", async () => {
    // Create one subdir so there are 2 watch registrations for same pair
    mkdirSync(join(tmpDir, "sub1"), { recursive: true });

    const mockWatchers: FSWatcher[] = [];
    const mockWatch = mock.fn((_path: string, _listener: unknown): FSWatcher => {
      const w = makeMockWatcher();
      mockWatchers.push(w);
      return w;
    });
    const onChanges = mock.fn(async (_pairId: string) => {});
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
    assert.ok(mockWatch.mock.callCount() >= 2, "should register at least 2 watchers");

    // Fire events from 2 different dir listeners within debounce window
    const listener0 = mockWatch.mock.calls[0]!.arguments[1] as WatchListener<string>;
    const listener1 = mockWatch.mock.calls[1]!.arguments[1] as WatchListener<string>;
    listener0("change", "file1.txt");
    listener1("change", "file2.txt");

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(onChanges.mock.callCount(), 1);

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
    mock.restoreAll();
  });

  it("ENOSPC on 3rd dir → INOTIFY_LIMIT error event, 2 watchers registered, no 4th call", async () => {
    const mockWatchers: FSWatcher[] = [];
    let callCount = 0;
    const mockWatch = mock.fn((_path: string, _listener: unknown): FSWatcher => {
      callCount++;
      if (callCount === 3) {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      }
      const w = makeMockWatcher();
      mockWatchers.push(w);
      return w;
    });
    const emittedEvents: IpcPushEvent[] = [];
    const onChanges = mock.fn(async (_pairId: string) => {});
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
    assert.ok(errorEvent, "error event should be emitted");
    assert.equal(errorEvent!.payload["code"], "INOTIFY_LIMIT");
    assert.equal(errorEvent!.payload["pair_id"], "p1");

    // Exactly 3 watchFn calls (no 4th after ENOSPC)
    assert.equal(mockWatch.mock.callCount(), 3);

    // Only 2 watchers successfully registered
    assert.equal(mockWatchers.length, 2);
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
    mock.restoreAll();
  });

  it("stop() closes all registered watchers and clears debounce timers", async () => {
    const mockWatchers: FSWatcher[] = [];
    const mockWatch = mock.fn((_path: string, _listener: unknown): FSWatcher => {
      const w = makeMockWatcher();
      mockWatchers.push(w);
      return w;
    });
    const onChanges = mock.fn(async (_pairId: string) => {});
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
    assert.equal(mockWatchers.length, 3);

    // Fire a listener to create a pending debounce timer
    const listener = mockWatch.mock.calls[0]!.arguments[1] as WatchListener<string>;
    listener("change", "file.txt");

    // stop() should clear the timer and close all watchers
    fw.stop();

    // All close() mocks called
    for (const w of mockWatchers) {
      const closeCallCount = (w.close as ReturnType<typeof mock.fn>).mock.callCount();
      assert.equal(closeCallCount, 1);
    }

    // Wait longer than debounce — onChangesDetected must NOT have been called
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(onChanges.mock.callCount(), 0);
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
    assert.ok(!content.includes(sdkPkg), "watcher.ts must not import the SDK package directly");
  });
});
