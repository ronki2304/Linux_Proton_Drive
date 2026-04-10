import { describe, it, mock } from "node:test";
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
import { handleCommand } from "./main.js";

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
    assert.equal(
      (sessionReady as { payload: { display_name: string } }).payload.display_name,
      "Test User",
    );

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
      (expired as { payload: { queued_changes: number } }).payload.queued_changes,
      0,
    );

    client.destroy();
    server.close();
    fs.rmSync(path.dirname(socketPath), { recursive: true });
  });
});

describe("list_remote_folders command", () => {
  it("returns empty folders[] for parent_id=null", async () => {
    const cmd: IpcCommand = {
      type: "list_remote_folders",
      id: "lrf-1",
      payload: { parent_id: null },
    };

    const response = await handleCommand(cmd);

    assert.ok(response, "handleCommand must return a response");
    assert.equal(response.type, "list_remote_folders_result");
    assert.equal(response.id, "lrf-1");
    assert.deepEqual(response.payload, { folders: [] });
  });

  it("returns empty folders[] for non-null parent_id", async () => {
    const cmd: IpcCommand = {
      type: "list_remote_folders",
      id: "lrf-2",
      payload: { parent_id: "some-uid" },
    };

    const response = await handleCommand(cmd);

    assert.ok(response, "handleCommand must return a response");
    assert.equal(response.type, "list_remote_folders_result");
    assert.equal(response.id, "lrf-2");
    assert.deepEqual(response.payload, { folders: [] });
  });

  it("returns empty folders[] when payload is missing", async () => {
    const cmd: IpcCommand = {
      type: "list_remote_folders",
      id: "lrf-3",
    };

    const response = await handleCommand(cmd);

    assert.ok(response, "handleCommand must return a response");
    assert.equal(response.type, "list_remote_folders_result");
    assert.equal(response.id, "lrf-3");
    assert.deepEqual(response.payload, { folders: [] });
  });
});
