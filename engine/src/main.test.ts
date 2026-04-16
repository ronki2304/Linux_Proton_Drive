import { describe, it, mock, afterEach, beforeEach, expect } from "bun:test";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { IpcCommand, IpcMessage, IpcPushEvent } from "./ipc.js";
import type { DriveClient } from "./sdk.js";
import {
  IpcServer,
  MessageReader,
  encodeMessage,
  writeMessage,
} from "./ipc.js";
import {
  handleCommand,
  _setDriveClientForTests,
  _setStateDbForTests,
  _setServerForTests,
  createNetworkMonitorCallback,
} from "./main.js";
import { StateDb } from "./state-db.js";
import { SyncEngine } from "./sync-engine.js";
import { NetworkMonitor } from "./network-monitor.js";

function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "main-test-"));
  return path.join(dir, "test.sock");
}

async function connectToSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => resolve(client));
    client.once("error", reject);
  });
}

async function readMessages(
  socket: net.Socket,
  timeout = 500,
): Promise<IpcMessage[]> {
  const reader = new MessageReader();
  const allMessages: IpcMessage[] = [];

  return new Promise((resolve) => {
    socket.on("data", (chunk: Buffer) => {
      const msgs = reader.feed(chunk);
      allMessages.push(...msgs);
    });
    setTimeout(() => resolve(allMessages), timeout);
  });
}

// ---------------------------------------------------------------------------
// token_refresh tests
// ---------------------------------------------------------------------------
describe("token_refresh command", () => {
  it("emits session_ready (not _result) for valid token", async () => {
    const socketPath = tmpSocketPath();
    let emittedEvents: IpcPushEvent[] = [];

    const server = new IpcServer(socketPath, async (command: IpcCommand) => {
      if (command.type === "token_refresh") {
        server.emitEvent({
          type: "session_ready",
          payload: {
            display_name: "Test User",
            email: "test@proton.me",
            storage_used: 1073741824,
            storage_total: 5368709120,
            plan: "Plus",
          },
        });
        return null; // No _result response
      }
      return {
        type: `${command.type}_result`,
        id: command.id,
        payload: {},
      };
    });

    await server.start();
    const client = await connectToSocket(socketPath);
    const messagesPromise = readMessages(client);

    await new Promise((r) => setTimeout(r, 50));

    const cmd: IpcCommand = {
      type: "token_refresh",
      id: "token-test-1",
      payload: { token: "test-session-token" },
    };
    writeMessage(client, cmd);

    const messages = await messagesPromise;

    // Should NOT have token_refresh_result
    const result = messages.find(
      (m) => (m as { type: string }).type === "token_refresh_result",
    );
    expect(result).toBeUndefined();

    // Should have session_ready
    const sessionReady = messages.find(
      (m) => (m as { type: string }).type === "session_ready",
    );
    expect(sessionReady).toBeTruthy();

    client.destroy();
    server.close();
    fs.rmSync(path.dirname(socketPath), { recursive: true });
  });

  it("emits token_expired for missing token", async () => {
    const socketPath = tmpSocketPath();

    const server = new IpcServer(socketPath, async (command: IpcCommand) => {
      if (command.type === "token_refresh") {
        server.emitEvent({
          type: "token_expired",
          payload: { queued_changes: 0 },
        });
        return null;
      }
      return {
        type: `${command.type}_result`,
        id: command.id,
        payload: {},
      };
    });

    await server.start();
    const client = await connectToSocket(socketPath);
    const messagesPromise = readMessages(client);

    await new Promise((r) => setTimeout(r, 50));

    const cmd: IpcCommand = {
      type: "token_refresh",
      id: "token-test-2",
      payload: {},
    };
    writeMessage(client, cmd);

    const messages = await messagesPromise;

    const expired = messages.find(
      (m) => (m as { type: string }).type === "token_expired",
    );
    expect(expired).toBeTruthy();
    expect(
      ((expired as { payload: Record<string, unknown> }).payload)["queued_changes"],
    ).toBe(0);

    client.destroy();
    server.close();
    fs.rmSync(path.dirname(socketPath), { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// list_remote_folders tests
// ---------------------------------------------------------------------------
describe("list_remote_folders command", () => {
  afterEach(() => {
    // Reset module-level driveClient between tests to prevent state leakage.
    _setDriveClientForTests(null);
  });

  it("returns engine_not_ready when no driveClient is set (no prior token_refresh)", async () => {
    const cmd: IpcCommand = {
      type: "list_remote_folders",
      id: "lrf-not-ready",
      payload: { parent_id: null },
    };

    const response = await handleCommand(cmd);

    expect(response).toBeTruthy();
    expect(response!.type).toBe("list_remote_folders_result");
    expect(response!.id).toBe("lrf-not-ready");
    expect(response!.payload).toEqual({ error: "engine_not_ready" });
  });

  it("returns engine_not_ready when payload is missing", async () => {
    const cmd: IpcCommand = {
      type: "list_remote_folders",
      id: "lrf-no-payload",
    };

    const response = await handleCommand(cmd);

    expect(response).toBeTruthy();
    expect(response!.type).toBe("list_remote_folders_result");
    expect(response!.id).toBe("lrf-no-payload");
    expect(response!.payload).toEqual({ error: "engine_not_ready" });
  });

  it("returns folders when driveClient is set (happy path)", async () => {
    const mockFolders = [
      { id: "uid-1", name: "Documents", parent_id: "<root>" },
      { id: "uid-2", name: "Photos", parent_id: "<root>" },
    ];
    const mockClient = {
      listRemoteFolders: mock(async () => mockFolders),
    } as unknown as DriveClient;

    _setDriveClientForTests(mockClient);

    const cmd: IpcCommand = {
      type: "list_remote_folders",
      id: "lrf-happy",
      payload: { parent_id: null },
    };

    const response = await handleCommand(cmd);

    expect(response).toBeTruthy();
    expect(response!.type).toBe("list_remote_folders_result");
    expect(response!.id).toBe("lrf-happy");
    expect(response!.payload).toEqual({ folders: mockFolders });
  });

  it("returns error message when driveClient.listRemoteFolders throws (error path)", async () => {
    const mockClient = {
      listRemoteFolders: mock(async () => {
        throw new Error("network timeout");
      }),
    } as unknown as DriveClient;

    _setDriveClientForTests(mockClient);

    const cmd: IpcCommand = {
      type: "list_remote_folders",
      id: "lrf-error",
      payload: { parent_id: null },
    };

    const response = await handleCommand(cmd);

    expect(response).toBeTruthy();
    expect(response!.type).toBe("list_remote_folders_result");
    expect(response!.id).toBe("lrf-error");
    expect(response!.payload).toEqual({ error: "network timeout" });
  });
});

// ---------------------------------------------------------------------------
// add_pair tests
// ---------------------------------------------------------------------------
describe("add_pair command", () => {
  let tmpDir: string;
  let origXdg: string | undefined;
  let addPairServer: IpcServer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-pair-test-"));
    origXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = tmpDir;
    _setStateDbForTests(new StateDb(":memory:"));
    // add_pair handler creates a FileWatcher that calls server.emitEvent — wire a stub server.
    addPairServer = new IpcServer(tmpSocketPath(), handleCommand);
    addPairServer.emitEvent = () => {};
    _setServerForTests(addPairServer);
  });

  afterEach(() => {
    _setDriveClientForTests(null);
    _setStateDbForTests(undefined);
    if (origXdg === undefined) {
      delete process.env["XDG_CONFIG_HOME"];
    } else {
      process.env["XDG_CONFIG_HOME"] = origXdg;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("success: driveClient set, valid payload → add_pair_result with pair_id (UUID format)", async () => {
    const mockClient = {
      listRemoteFolders: mock(async () => []),
    } as unknown as DriveClient;
    _setDriveClientForTests(mockClient);

    const cmd: IpcCommand = {
      type: "add_pair",
      id: "ap-happy",
      payload: { local_path: "/home/user/Docs", remote_path: "/Documents" },
    };

    const response = await handleCommand(cmd);

    expect(response).toBeTruthy();
    expect(response!.type).toBe("add_pair_result");
    expect(response!.id).toBe("ap-happy");
    expect("pair_id" in response!.payload).toBeTruthy();
    const pairId = response!.payload["pair_id"] as string;
    // UUID v4 format
    expect(pairId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("missing local_path → invalid_payload", async () => {
    const mockClient = {
      listRemoteFolders: mock(async () => []),
    } as unknown as DriveClient;
    _setDriveClientForTests(mockClient);

    const cmd: IpcCommand = {
      type: "add_pair",
      id: "ap-no-local",
      payload: { remote_path: "/Documents" },
    };

    const response = await handleCommand(cmd);
    expect(response).toBeTruthy();
    expect(response!.type).toBe("add_pair_result");
    expect(response!.payload).toEqual({ error: "invalid_payload" });
  });

  it("missing remote_path → invalid_payload", async () => {
    const mockClient = {
      listRemoteFolders: mock(async () => []),
    } as unknown as DriveClient;
    _setDriveClientForTests(mockClient);

    const cmd: IpcCommand = {
      type: "add_pair",
      id: "ap-no-remote",
      payload: { local_path: "/home/user/Docs" },
    };

    const response = await handleCommand(cmd);
    expect(response).toBeTruthy();
    expect(response!.type).toBe("add_pair_result");
    expect(response!.payload).toEqual({ error: "invalid_payload" });
  });

  it("driveClient null → engine_not_ready", async () => {
    const cmd: IpcCommand = {
      type: "add_pair",
      id: "ap-not-ready",
      payload: { local_path: "/home/user/Docs", remote_path: "/Documents" },
    };

    const response = await handleCommand(cmd);
    expect(response).toBeTruthy();
    expect(response!.type).toBe("add_pair_result");
    expect(response!.payload).toEqual({ error: "engine_not_ready" });
  });

  it("stateDb undefined (driveClient set) → engine_not_ready", async () => {
    const mockClient = {
      listRemoteFolders: mock(async () => []),
    } as unknown as DriveClient;
    _setDriveClientForTests(mockClient);
    _setStateDbForTests(undefined);

    const cmd: IpcCommand = {
      type: "add_pair",
      id: "ap-no-statedb",
      payload: { local_path: "/home/user/Docs", remote_path: "/Documents" },
    };

    const response = await handleCommand(cmd);
    expect(response).toBeTruthy();
    expect(response!.type).toBe("add_pair_result");
    expect(response!.payload).toEqual({ error: "engine_not_ready" });
  });
});

// ---------------------------------------------------------------------------
// unlock_keys command (Story 2.11, AC5, AC9)
// ---------------------------------------------------------------------------
describe("unlock_keys command", () => {
  let testServer: IpcServer;
  let capturedEvents: IpcPushEvent[];

  beforeEach(() => {
    capturedEvents = [];
    const socketPath = tmpSocketPath();
    testServer = new IpcServer(socketPath, handleCommand);
    // Patch emitEvent to capture events without needing a live socket
    testServer.emitEvent = (event: IpcPushEvent) => {
      capturedEvents.push(event);
    };
    _setServerForTests(testServer);
  });

  afterEach(() => {
    _setDriveClientForTests(null);
    _setStateDbForTests(undefined);
  });

  it("emits key_unlock_required (not _result) when no driveClient is set", async () => {
    _setDriveClientForTests(null);

    const response = await handleCommand({
      type: "unlock_keys",
      id: "unlock-no-client",
      payload: { password: "any" },
    });

    expect(response).toBeNull();
    expect(capturedEvents.some((e) => e.type === "key_unlock_required")).toBeTruthy();
  });

  it("emits key_unlock_required when password is missing from payload", async () => {
    _setDriveClientForTests({} as unknown as DriveClient);

    const response = await handleCommand({
      type: "unlock_keys",
      id: "unlock-no-pw",
      payload: {},
    });

    expect(response).toBeNull();
    expect(capturedEvents.some((e) => e.type === "key_unlock_required")).toBeTruthy();
  });

  it("emits session_ready on successful key derivation", async () => {
    const db = new StateDb(":memory:");
    _setStateDbForTests(db);

    const mockClient = {
      deriveAndUnlock: mock(async () => "$2y$10$fakekeypassword00000000"),
      validateSession: mock(async () => ({
        email: "u@p.me",
        display_name: "U",
        storage_used: 0,
        storage_total: 0,
        plan: "",
      })),
      setDriveClient: mock(() => {}),
      startSyncAll: mock(async () => {}),
    };
    _setDriveClientForTests(mockClient as unknown as DriveClient);

    const response = await handleCommand({
      type: "unlock_keys",
      id: "unlock-ok",
      payload: { password: "correct-password" },
    });

    expect(response).toBeNull();
    const ready = capturedEvents.find((e) => e.type === "session_ready");
    expect(ready).toBeTruthy();
    // key_password included so UI can store it
    expect(
      (ready!.payload as Record<string, unknown>)["key_password"],
    ).toBe("$2y$10$fakekeypassword00000000");
  });

  it("emits key_unlock_required with error hint when derivation fails", async () => {
    const mockClient = {
      deriveAndUnlock: mock(async () => {
        throw new Error("bcrypt failed");
      }),
    };
    _setDriveClientForTests(mockClient as unknown as DriveClient);

    const response = await handleCommand({
      type: "unlock_keys",
      id: "unlock-fail",
      payload: { password: "wrong-password" },
    });

    expect(response).toBeNull();
    const event = capturedEvents.find((e) => e.type === "key_unlock_required");
    expect(event).toBeTruthy();
    // Error hint present — raw password must NOT be in the payload
    const payload = event!.payload as Record<string, unknown>;
    expect(!JSON.stringify(payload).includes("wrong-password")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// token_refresh: key_password flow (Story 2.11, AC5)
// ---------------------------------------------------------------------------
describe("token_refresh: key_password flow", () => {
  let testServer: IpcServer;
  let capturedEvents: IpcPushEvent[];

  beforeEach(() => {
    capturedEvents = [];
    const socketPath = tmpSocketPath();
    testServer = new IpcServer(socketPath, handleCommand);
    testServer.emitEvent = (event: IpcPushEvent) => {
      capturedEvents.push(event);
    };
    _setServerForTests(testServer);
  });

  afterEach(() => {
    _setDriveClientForTests(null);
    _setStateDbForTests(undefined);
  });

  it("emits key_unlock_required when token valid but key_password absent", async () => {
    const stubSocketPath = tmpSocketPath();
    const stubServer = new IpcServer(
      stubSocketPath,
      async (command: IpcCommand) => {
        if (command.type === "token_refresh") {
          stubServer.emitEvent({ type: "key_unlock_required", payload: {} });
          return null;
        }
        return { type: `${command.type}_result`, id: command.id, payload: {} };
      },
    );

    await stubServer.start();
    const client = await connectToSocket(stubSocketPath);
    const msgsPromise = readMessages(client);

    await new Promise((r) => setTimeout(r, 30));

    writeMessage(client, {
      type: "token_refresh",
      id: "tr-no-kp",
      payload: { token: "uid:accesstoken" },
    });

    const msgs = await msgsPromise;
    const event = msgs.find((m) => (m as { type: string }).type === "key_unlock_required");
    expect(event).toBeTruthy();

    const result = msgs.find((m) => (m as { type: string }).type === "token_refresh_result");
    expect(result).toBeUndefined();

    client.destroy();
    stubServer.close();
    fs.rmSync(path.dirname(stubSocketPath), { recursive: true });
  });
});

describe("get_status command", () => {
  beforeEach(() => {
    _setStateDbForTests(new StateDb(":memory:"));
  });

  afterEach(() => {
    _setStateDbForTests(undefined);
  });

  it("returns pairs:[] and online:true when no pairs exist", async () => {
    const cmd: IpcCommand = {
      type: "get_status",
      id: "gs-empty",
    };

    const response = await handleCommand(cmd);
    expect(response).toBeTruthy();
    expect(response!.type).toBe("get_status_result");
    expect(response!.id).toBe("gs-empty");
    expect(response!.payload).toEqual({ pairs: [], online: true });
  });

  it("get_status_result includes queued_changes:0 per pair when queue is empty", async () => {
    const db = new StateDb(":memory:");
    _setStateDbForTests(db);
    db.insertPair({
      pair_id: "pair-qs1",
      local_path: "/tmp/local",
      remote_path: "/remote",
      remote_id: "r1",
      created_at: "2026-01-01T00:00:00Z",
      last_synced_at: null,
    });

    const cmd: IpcCommand = { type: "get_status", id: "gs-zero" };
    const response = await handleCommand(cmd);
    expect(response!.type).toBe("get_status_result");
    const pairs = response!.payload["pairs"] as Array<Record<string, unknown>>;
    expect(pairs.length).toBe(1);
    expect(pairs[0]!["queued_changes"]).toBe(0);
  });

  it("get_status_result reflects non-zero queue count", async () => {
    const db = new StateDb(":memory:");
    _setStateDbForTests(db);
    db.insertPair({
      pair_id: "pair-qs2",
      local_path: "/tmp/local2",
      remote_path: "/remote2",
      remote_id: "r2",
      created_at: "2026-01-01T00:00:00Z",
      last_synced_at: null,
    });
    db.enqueue({ pair_id: "pair-qs2", relative_path: "a.txt", change_type: "modified", queued_at: new Date().toISOString() });
    db.enqueue({ pair_id: "pair-qs2", relative_path: "b.txt", change_type: "created", queued_at: new Date().toISOString() });

    const cmd: IpcCommand = { type: "get_status", id: "gs-nonzero" };
    const response = await handleCommand(cmd);
    expect(response!.type).toBe("get_status_result");
    const pairs = response!.payload["pairs"] as Array<Record<string, unknown>>;
    expect(pairs.length).toBe(1);
    expect(pairs[0]!["queued_changes"]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Story 3-3 — createNetworkMonitorCallback wiring tests
// ---------------------------------------------------------------------------
describe("createNetworkMonitorCallback (Story 3-3 wiring)", () => {
  it("forwards every event to the server emitter", () => {
    const emitted: IpcPushEvent[] = [];
    const fakeEngine = { replayQueue: mock(async () => ({ synced: 0, skipped_conflicts: 0, failed: 0 })) } as unknown as SyncEngine;
    const cb = createNetworkMonitorCallback(
      (e) => emitted.push(e),
      () => fakeEngine,
    );
    cb({ type: "offline", payload: {} });
    cb({ type: "online", payload: {} });
    expect(emitted.length).toBe(2);
    expect(emitted[0]!.type).toBe("offline");
    expect(emitted[1]!.type).toBe("online");
  });

  it("triggers engine.replayQueue() ONLY on 'online' events", () => {
    const emitted: IpcPushEvent[] = [];
    const replayFn = mock(async () => ({ synced: 0, skipped_conflicts: 0, failed: 0 }));
    const fakeEngine = { replayQueue: replayFn } as unknown as SyncEngine;
    const cb = createNetworkMonitorCallback(
      (e) => emitted.push(e),
      () => fakeEngine,
    );
    cb({ type: "offline", payload: {} });
    expect(replayFn.mock.calls.length).toBe(0);
    cb({ type: "online", payload: {} });
    expect(replayFn.mock.calls.length).toBe(1);
    cb({ type: "online", payload: {} });
    expect(replayFn.mock.calls.length).toBe(2);
  });

  it("emits server event BEFORE invoking replayQueue (ordering guarantee)", () => {
    const order: string[] = [];
    const fakeEngine = {
      replayQueue: mock(async () => {
        order.push("replay");
        return { synced: 0, skipped_conflicts: 0, failed: 0 };
      }),
    } as unknown as SyncEngine;
    const cb = createNetworkMonitorCallback(
      (_e) => order.push("emit"),
      () => fakeEngine,
    );
    cb({ type: "online", payload: {} });
    // replayQueue is called synchronously from cb but runs async; the first
    // microtask of an async fn runs up to the first await, which here is the
    // `return {...}`. Either way, emit happens first in the call sequence.
    expect(order[0]).toBe("emit");
    expect(order.includes("replay")).toBe(true);
  });

  it("first-check online (startup path) does NOT trigger replayQueue (Task 5.3 lock-in)", async () => {
    // NetworkMonitor starts with isOnline=true (optimistic). The first
    // runCheck() resolves the real state; if the machine is actually online
    // the new value equals the old and no event fires — therefore replay must
    // not run on startup, only on a real offline→online transition.
    const emitted: IpcPushEvent[] = [];
    const replayFn = mock(async () => ({ synced: 0, skipped_conflicts: 0, failed: 0 }));
    const fakeEngine = { replayQueue: replayFn } as unknown as SyncEngine;
    const cb = createNetworkMonitorCallback(
      (e) => emitted.push(e),
      () => fakeEngine,
    );
    // checkFn always resolves true → no transition from the optimistic
    // default, so NetworkMonitor never emits `online`.
    const monitor = new NetworkMonitor(cb, async () => true);
    monitor.start();
    // Wait a few microtasks for runCheck() to complete.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    monitor.stop();

    expect(emitted.length).toBe(0);
    expect(replayFn.mock.calls.length).toBe(0);
  });

  it("emits over real IPC when wired to IpcServer+StateDb+SyncEngine", async () => {
    // Integration-lite: construct a real IpcServer + StateDb + SyncEngine,
    // wire the callback, trigger 'online' through the wrapped callback, and
    // verify a `queue_replay_complete` event lands on the wire.
    const socketPath = tmpSocketPath();
    const server = new IpcServer(socketPath, async (command: IpcCommand) => ({
      type: `${command.type}_result`,
      id: command.id,
      payload: {},
    }));
    const db = new StateDb(":memory:");
    const engine = new SyncEngine(db, (e) => server.emitEvent(e));
    // driveClient null → replayQueue returns zero counts but still emits
    // queue_replay_complete (AC6).
    engine.setDriveClient(null);

    await server.start();
    const client = await connectToSocket(socketPath);
    const messagesPromise = readMessages(client, 300);

    const cb = createNetworkMonitorCallback(
      (e) => server.emitEvent(e),
      () => engine,
    );
    cb({ type: "online", payload: {} });

    const messages = await messagesPromise;
    const types = messages.map((m) => (m as { type: string }).type);
    // Expect online forwarded over the wire AND queue_replay_complete.
    expect(types).toContain("online");
    expect(types).toContain("queue_replay_complete");
    // Ordering: online BEFORE queue_replay_complete on the wire.
    expect(types.indexOf("online")).toBeLessThan(types.indexOf("queue_replay_complete"));

    client.end();
    server.close();
    db.close();
  });
});
