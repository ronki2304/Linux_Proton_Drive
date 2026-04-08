import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import {
  MessageReader,
  encodeMessage,
  IpcServer,
  writeMessage,
} from "./ipc.js";
import type { IpcCommand, IpcMessage, IpcPushEvent } from "./ipc.js";
import { IpcError } from "./errors.js";

// --- MessageReader tests ---

describe("MessageReader", () => {
  let reader: MessageReader;

  beforeEach(() => {
    reader = new MessageReader();
  });

  it("handles partial message — no messages until complete", () => {
    const msg = encodeMessage({ type: "test", payload: {} } as IpcPushEvent);
    // Feed first half only
    const half = msg.subarray(0, Math.floor(msg.length / 2));
    const result1 = reader.feed(half);
    assert.equal(result1.length, 0);

    // Feed remainder
    const rest = msg.subarray(Math.floor(msg.length / 2));
    const result2 = reader.feed(rest);
    assert.equal(result2.length, 1);
    assert.equal((result2[0] as IpcPushEvent).type, "test");
  });

  it("handles multiple messages in one chunk", () => {
    const msg1 = encodeMessage({
      type: "first",
      payload: {},
    } as IpcPushEvent);
    const msg2 = encodeMessage({
      type: "second",
      payload: {},
    } as IpcPushEvent);
    const combined = Buffer.concat([msg1, msg2]);

    const results = reader.feed(combined);
    assert.equal(results.length, 2);
    assert.equal((results[0] as IpcPushEvent).type, "first");
    assert.equal((results[1] as IpcPushEvent).type, "second");
  });

  it("handles message split across chunks at arbitrary offset", () => {
    const msg = encodeMessage({
      type: "split_test",
      payload: { data: "hello" },
    } as IpcPushEvent);

    // Split at byte 6 (inside the JSON payload)
    const part1 = msg.subarray(0, 6);
    const part2 = msg.subarray(6);

    const r1 = reader.feed(part1);
    assert.equal(r1.length, 0);

    const r2 = reader.feed(part2);
    assert.equal(r2.length, 1);
    assert.equal((r2[0] as IpcPushEvent).type, "split_test");
  });

  it("rejects zero-length payload with IpcError", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(0, 0);

    assert.throws(() => reader.feed(header), IpcError);
  });

  it("rejects oversized payload with IpcError", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(2 * 1024 * 1024, 0); // 2 MB > 1 MB limit

    assert.throws(() => reader.feed(header), IpcError);
  });

  it("rejects malformed JSON with IpcError", () => {
    const badJson = Buffer.from("{invalid json");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(badJson.length, 0);
    const frame = Buffer.concat([header, badJson]);

    assert.throws(() => reader.feed(frame), IpcError);
  });

  it("rejects message missing 'type' field with IpcError", () => {
    const json = Buffer.from(JSON.stringify({ id: "abc", payload: {} }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(json.length, 0);
    const frame = Buffer.concat([header, json]);

    assert.throws(() => reader.feed(frame), IpcError);
  });
});

// --- IpcServer tests ---

function createTempSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-test-"));
  return path.join(dir, "test.sock");
}

function connectToSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => resolve(client));
    client.on("error", reject);
  });
}

function readMessages(socket: net.Socket): Promise<IpcMessage[]> {
  return new Promise((resolve) => {
    const reader = new MessageReader();
    const messages: IpcMessage[] = [];

    socket.on("data", (chunk: Buffer) => {
      try {
        messages.push(...reader.feed(chunk));
      } catch {
        // ignore parse errors in test reader
      }
    });

    // Give time for messages to arrive
    setTimeout(() => resolve(messages), 100);
  });
}

describe("IpcServer", () => {
  let socketPath: string;
  let server: IpcServer;

  beforeEach(() => {
    socketPath = createTempSocketPath();
  });

  afterEach(() => {
    if (server) {
      server.close();
    }
  });

  it("emits ready event on connection", async () => {
    server = new IpcServer(socketPath, async () => null);
    server.onConnect(() => {
      server.emitEvent({
        type: "ready",
        payload: { version: "0.1.0", protocol_version: 1 },
      });
    });
    await server.start();

    const client = await connectToSocket(socketPath);
    const messages = await readMessages(client);

    assert.equal(messages.length, 1);
    const ready = messages[0] as IpcPushEvent;
    assert.equal(ready.type, "ready");
    assert.equal(ready.payload["version"], "0.1.0");
    assert.equal(ready.payload["protocol_version"], 1);

    client.destroy();
  });

  it("rejects second connection with ALREADY_CONNECTED", async () => {
    server = new IpcServer(socketPath, async () => null);
    await server.start();

    const client1 = await connectToSocket(socketPath);
    // Wait for connection to register
    await new Promise((r) => setTimeout(r, 50));

    const client2 = await connectToSocket(socketPath);
    const messages = await readMessages(client2);

    assert.equal(messages.length, 1);
    const err = messages[0] as IpcPushEvent;
    assert.equal(err.type, "error");
    assert.equal(err.payload["code"], "ALREADY_CONNECTED");

    client1.destroy();
    client2.destroy();
  });

  it("handles shutdown command — server closes", async () => {
    server = new IpcServer(socketPath, async () => null);
    await server.start();

    const client = await connectToSocket(socketPath);
    await new Promise((r) => setTimeout(r, 50));

    const shutdownCmd: IpcCommand = {
      type: "shutdown",
      id: "test-shutdown-1",
    };
    writeMessage(client, shutdownCmd);

    // Wait for server to close
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(server.connected, false);

    client.destroy();
  });

  it("responds with _result suffix and echoed id", async () => {
    server = new IpcServer(socketPath, async (cmd) => ({
      type: `${cmd.type}_result`,
      id: cmd.id,
      payload: { status: "ok" },
    }));
    await server.start();

    const client = await connectToSocket(socketPath);
    await new Promise((r) => setTimeout(r, 50));

    const cmd: IpcCommand = {
      type: "get_status",
      id: "abc-123",
    };
    writeMessage(client, cmd);

    const messages = await readMessages(client);
    const response = messages.find(
      (m) => (m as { type: string }).type === "get_status_result",
    );
    assert.ok(response);
    assert.equal((response as { id: string }).id, "abc-123");

    client.destroy();
  });

  it("sends error response when command handler throws", async () => {
    server = new IpcServer(socketPath, async () => {
      throw new Error("handler failed");
    });
    await server.start();

    const client = await connectToSocket(socketPath);
    await new Promise((r) => setTimeout(r, 50));

    const cmd: IpcCommand = {
      type: "do_something",
      id: "err-456",
    };
    writeMessage(client, cmd);

    const messages = await readMessages(client);
    const errResponse = messages.find(
      (m) => (m as { type: string }).type === "do_something_result",
    );
    assert.ok(errResponse);
    assert.equal(
      (errResponse as IpcPushEvent).payload["error"],
      "handler failed",
    );

    client.destroy();
  });
});
