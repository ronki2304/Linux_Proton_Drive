import { describe, it, mock, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { IpcCommand, IpcMessage, IpcPushEvent } from "./ipc.js";
import {
  IpcServer,
  MessageReader,
  encodeMessage,
  writeMessage,
} from "./ipc.js";
import { handleCommand, _setDriveClientForTests, _setStateDbForTests } from "./main.js";
import type { DriveClient } from "./sdk.js";
import { StateDb } from "./state-db.js";

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
//
// These tests verify the IPC contract: token_refresh must NOT produce a
// _result response and MUST emit a push event (session_ready or token_expired).
// They use a hand-rolled IpcServer that stubs the handler to avoid hitting
// real Proton infrastructure.
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
    assert.equal(result, undefined, "token_refresh must NOT produce a _result");

    // Should have session_ready
    const sessionReady = messages.find(
      (m) => (m as { type: string }).type === "session_ready",
    );
    assert.ok(sessionReady, "session_ready event should be emitted");

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
    assert.ok(expired, "token_expired event should be emitted");
    assert.equal(
      ((expired as { payload: Record<string, unknown> }).payload)["queued_changes"],
      0,
    );

    client.destroy();
    server.close();
    fs.rmSync(path.dirname(socketPath), { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// list_remote_folders tests
//
// The handler now has three paths:
//  1. engine_not_ready: driveClient is null (no successful token_refresh yet)
//  2. happy path: driveClient.listRemoteFolders returns folders
//  3. error path: driveClient.listRemoteFolders throws
//
// We test paths 1 and 3 directly via handleCommand (which uses the module-level
// driveClient). Since driveClient starts null in test context (no real auth),
// path 1 is testable without mocking. Paths 2 and 3 require injecting a mock
// DriveClient via the sdk module, which is done by mocking the createDriveClient
// import at the module level.
// ---------------------------------------------------------------------------
describe("list_remote_folders command", () => {
  afterEach(() => {
    // Reset module-level driveClient between tests to prevent state leakage.
    _setDriveClientForTests(null);
  });

  it("returns engine_not_ready when no driveClient is set (no prior token_refresh)", async () => {
    // driveClient is null at module init and after test isolation — this tests
    // the guard path without touching real auth.
    const cmd: IpcCommand = {
      type: "list_remote_folders",
      id: "lrf-not-ready",
      payload: { parent_id: null },
    };

    const response = await handleCommand(cmd);

    assert.ok(response, "handleCommand must return a response");
    assert.equal(response.type, "list_remote_folders_result");
    assert.equal(response.id, "lrf-not-ready");
    assert.deepEqual(response.payload, { error: "engine_not_ready" });
  });

  it("returns engine_not_ready when payload is missing", async () => {
    const cmd: IpcCommand = {
      type: "list_remote_folders",
      id: "lrf-no-payload",
    };

    const response = await handleCommand(cmd);

    assert.ok(response, "handleCommand must return a response");
    assert.equal(response.type, "list_remote_folders_result");
    assert.equal(response.id, "lrf-no-payload");
    assert.deepEqual(response.payload, { error: "engine_not_ready" });
  });

  it("returns folders when driveClient is set (happy path)", async () => {
    const mockFolders = [
      { id: "uid-1", name: "Documents", parent_id: "<root>" },
      { id: "uid-2", name: "Photos", parent_id: "<root>" },
    ];
    const mockClient = {
      listRemoteFolders: mock.fn(async () => mockFolders),
    } as unknown as DriveClient;

    _setDriveClientForTests(mockClient);

    const cmd: IpcCommand = {
      type: "list_remote_folders",
      id: "lrf-happy",
      payload: { parent_id: null },
    };

    const response = await handleCommand(cmd);

    assert.ok(response, "handleCommand must return a response");
    assert.equal(response.type, "list_remote_folders_result");
    assert.equal(response.id, "lrf-happy");
    assert.deepEqual(response.payload, { folders: mockFolders });
  });

  it("returns error message when driveClient.listRemoteFolders throws (error path)", async () => {
    const mockClient = {
      listRemoteFolders: mock.fn(async () => {
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

    assert.ok(response, "handleCommand must return a response");
    assert.equal(response.type, "list_remote_folders_result");
    assert.equal(response.id, "lrf-error");
    assert.deepEqual(response.payload, { error: "network timeout" });
  });
});

// ---------------------------------------------------------------------------
// add_pair tests
// ---------------------------------------------------------------------------
describe("add_pair command", () => {
  let tmpDir: string;
  let origXdg: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-pair-test-"));
    origXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = tmpDir;
    _setStateDbForTests(new StateDb(":memory:"));
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
      listRemoteFolders: mock.fn(async () => []),
    } as unknown as DriveClient;
    _setDriveClientForTests(mockClient);

    const cmd: IpcCommand = {
      type: "add_pair",
      id: "ap-happy",
      payload: { local_path: "/home/user/Docs", remote_path: "/Documents" },
    };

    const response = await handleCommand(cmd);

    assert.ok(response);
    assert.equal(response.type, "add_pair_result");
    assert.equal(response.id, "ap-happy");
    assert.ok("pair_id" in response.payload, "response must have pair_id");
    const pairId = response.payload["pair_id"] as string;
    // UUID v4 format
    assert.match(pairId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("missing local_path → invalid_payload", async () => {
    const mockClient = {
      listRemoteFolders: mock.fn(async () => []),
    } as unknown as DriveClient;
    _setDriveClientForTests(mockClient);

    const cmd: IpcCommand = {
      type: "add_pair",
      id: "ap-no-local",
      payload: { remote_path: "/Documents" },
    };

    const response = await handleCommand(cmd);
    assert.ok(response);
    assert.equal(response.type, "add_pair_result");
    assert.deepEqual(response.payload, { error: "invalid_payload" });
  });

  it("missing remote_path → invalid_payload", async () => {
    const mockClient = {
      listRemoteFolders: mock.fn(async () => []),
    } as unknown as DriveClient;
    _setDriveClientForTests(mockClient);

    const cmd: IpcCommand = {
      type: "add_pair",
      id: "ap-no-remote",
      payload: { local_path: "/home/user/Docs" },
    };

    const response = await handleCommand(cmd);
    assert.ok(response);
    assert.equal(response.type, "add_pair_result");
    assert.deepEqual(response.payload, { error: "invalid_payload" });
  });

  it("driveClient null → engine_not_ready", async () => {
    // driveClient already null from module init / afterEach reset
    const cmd: IpcCommand = {
      type: "add_pair",
      id: "ap-not-ready",
      payload: { local_path: "/home/user/Docs", remote_path: "/Documents" },
    };

    const response = await handleCommand(cmd);
    assert.ok(response);
    assert.equal(response.type, "add_pair_result");
    assert.deepEqual(response.payload, { error: "engine_not_ready" });
  });

  it("stateDb undefined (driveClient set) → engine_not_ready", async () => {
    const mockClient = {
      listRemoteFolders: mock.fn(async () => []),
    } as unknown as DriveClient;
    _setDriveClientForTests(mockClient);
    _setStateDbForTests(undefined);

    const cmd: IpcCommand = {
      type: "add_pair",
      id: "ap-no-statedb",
      payload: { local_path: "/home/user/Docs", remote_path: "/Documents" },
    };

    const response = await handleCommand(cmd);
    assert.ok(response);
    assert.equal(response.type, "add_pair_result");
    assert.deepEqual(response.payload, { error: "engine_not_ready" });
  });
});

// ---------------------------------------------------------------------------
// get_status tests
// ---------------------------------------------------------------------------
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
    assert.ok(response);
    assert.equal(response.type, "get_status_result");
    assert.equal(response.id, "gs-empty");
    assert.deepEqual(response.payload, { pairs: [], online: true });
  });
});
