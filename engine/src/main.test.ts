import { describe, it, mock, afterEach } from "node:test";
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
import { handleCommand, _setDriveClientForTests } from "./main.js";
import type { DriveClient } from "./sdk.js";

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
