import { describe, it, afterEach, beforeEach, mock } from "node:test";
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

// --- Backpressure tests ---

interface FakeSocket {
  write: ReturnType<typeof mock.fn>;
  destroyed: boolean;
  once: (event: string, cb: () => void) => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  triggerDrain: () => void;
  triggerClose: () => void;
}

function makeFakeSocket(initialWriteResult: boolean): FakeSocket {
  const drainListeners: Array<() => void> = [];
  const closeListeners: Array<() => void> = [];
  const writeFn = mock.fn(() => initialWriteResult);
  return {
    write: writeFn,
    destroyed: false,
    once(event: string, cb: () => void): void {
      if (event === "drain") {
        drainListeners.push(cb);
      }
    },
    on(event: string, cb: (...args: unknown[]) => void): void {
      if (event === "close") {
        closeListeners.push(cb as () => void);
      }
      // 'data' and 'error' are not exercised by these tests.
    },
    triggerDrain(): void {
      const cbs = drainListeners.splice(0);
      for (const cb of cbs) cb();
    },
    triggerClose(): void {
      const cbs = closeListeners.splice(0);
      for (const cb of cbs) cb();
    },
  };
}

function decodeFrame(frame: Buffer): IpcMessage {
  const reader = new MessageReader();
  const messages = reader.feed(frame);
  return messages[0] as IpcMessage;
}

describe("IpcServer backpressure", () => {
  it("queues messages when socket.write returns false and flushes FIFO on drain", () => {
    const fakeSocket = makeFakeSocket(false);
    const server = new IpcServer(
      "/tmp/unused-backpressure-test.sock",
      async () => null,
    );
    // Inject the fake socket as the active connection without going through net.
    (server as unknown as { activeConnection: FakeSocket }).activeConnection =
      fakeSocket;

    // First write hits a saturated buffer → write() returns false, draining=true.
    server.emitEvent({ type: "evt1", payload: { n: 1 } });
    assert.equal(fakeSocket.write.mock.callCount(), 1);

    // Subsequent writes are queued — no more socket.write calls.
    server.emitEvent({ type: "evt2", payload: { n: 2 } });
    server.emitEvent({ type: "evt3", payload: { n: 3 } });
    assert.equal(
      fakeSocket.write.mock.callCount(),
      1,
      "queued messages must not call socket.write while draining",
    );

    // Switch to writeable mode and trigger drain.
    fakeSocket.write.mock.mockImplementation(() => true);
    fakeSocket.triggerDrain();

    // Queue should have flushed in FIFO order.
    assert.equal(fakeSocket.write.mock.callCount(), 3);
    const callArgs = fakeSocket.write.mock.calls.map(
      (c) => c.arguments[0] as Buffer,
    );
    const decoded = callArgs.map((buf) => decodeFrame(buf) as IpcPushEvent);
    assert.equal(decoded[0]?.type, "evt1");
    assert.equal(decoded[1]?.type, "evt2");
    assert.equal(decoded[2]?.type, "evt3");
    assert.equal(decoded[0]?.payload["n"], 1);
    assert.equal(decoded[1]?.payload["n"], 2);
    assert.equal(decoded[2]?.payload["n"], 3);
  });

  it("re-pauses when drain flush is itself saturated", () => {
    const fakeSocket = makeFakeSocket(false);
    const server = new IpcServer(
      "/tmp/unused-backpressure-test-2.sock",
      async () => null,
    );
    (server as unknown as { activeConnection: FakeSocket }).activeConnection =
      fakeSocket;

    // Saturate then queue two more.
    server.emitEvent({ type: "a", payload: {} });
    server.emitEvent({ type: "b", payload: {} });
    server.emitEvent({ type: "c", payload: {} });
    server.emitEvent({ type: "d", payload: {} });
    assert.equal(fakeSocket.write.mock.callCount(), 1);

    // Drain fires: flush "b" (success) then "c" (saturate) — must re-register
    // drain. "d" stays queued. Note: when socket.write() returns false the
    // bytes ARE still buffered for delivery; we just stop pushing more.
    let flushedCount = 0;
    fakeSocket.write.mock.mockImplementation(() => {
      flushedCount += 1;
      return flushedCount <= 1;
    });
    fakeSocket.triggerDrain();
    // 1 (initial) + 2 (b ok, c re-pauses) = 3
    assert.equal(fakeSocket.write.mock.callCount(), 3);

    // Second drain: write succeeds, "d" flushes.
    fakeSocket.write.mock.mockImplementation(() => true);
    fakeSocket.triggerDrain();
    assert.equal(fakeSocket.write.mock.callCount(), 4);

    const decoded = fakeSocket.write.mock.calls.map(
      (call) => decodeFrame(call.arguments[0] as Buffer) as IpcPushEvent,
    );
    assert.deepEqual(
      decoded.map((m) => m.type),
      ["a", "b", "c", "d"],
    );
  });

  it("clears the write queue when the connection closes", () => {
    const fakeSocket = makeFakeSocket(false);
    const server = new IpcServer(
      "/tmp/unused-backpressure-test-3.sock",
      async () => null,
    );
    // Route through the real onConnection so the production close handler
    // is wired up — bypassing it would mean the test fakes its own cleanup
    // and never exercises the queue/drain reset on `'close'`.
    (
      server as unknown as { onConnection: (s: FakeSocket) => void }
    ).onConnection(fakeSocket);

    // Saturate and queue.
    server.emitEvent({ type: "evt1", payload: {} });
    server.emitEvent({ type: "evt2", payload: {} });
    assert.equal(
      (server as unknown as { writeQueue: Buffer[] }).writeQueue.length,
      1,
      "second event should be queued while draining",
    );
    assert.equal(
      (server as unknown as { draining: boolean }).draining,
      true,
    );

    // Fire the real close handler — production code must reset state.
    fakeSocket.triggerClose();

    assert.equal(
      (server as unknown as { activeConnection: FakeSocket | null })
        .activeConnection,
      null,
      "close handler must clear activeConnection",
    );
    assert.equal(
      (server as unknown as { writeQueue: Buffer[] }).writeQueue.length,
      0,
      "close handler must clear writeQueue",
    );
    assert.equal(
      (server as unknown as { draining: boolean }).draining,
      false,
      "close handler must clear draining flag",
    );

    // After drop, emitEvent should be a silent no-op (no new write attempt).
    server.emitEvent({ type: "evt3", payload: {} });
    assert.equal(fakeSocket.write.mock.callCount(), 1);
  });
});

// --- Malformed JSON debug logging integration ---

describe("IpcServer debug logging on malformed JSON", () => {
  let socketPath: string;
  let server: IpcServer;
  let cacheDir: string;
  const originalDebug = process.env["PROTONDRIVE_DEBUG"];
  const originalCacheHome = process.env["XDG_CACHE_HOME"];

  beforeEach(() => {
    socketPath = createTempSocketPath();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-debug-log-"));
    process.env["XDG_CACHE_HOME"] = cacheDir;
    process.env["PROTONDRIVE_DEBUG"] = "1";
  });

  afterEach(() => {
    if (server) server.close();
    if (originalDebug === undefined) delete process.env["PROTONDRIVE_DEBUG"];
    else process.env["PROTONDRIVE_DEBUG"] = originalDebug;
    if (originalCacheHome === undefined) delete process.env["XDG_CACHE_HOME"];
    else process.env["XDG_CACHE_HOME"] = originalCacheHome;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("writes a debug-log entry when malformed JSON arrives", async () => {
    server = new IpcServer(socketPath, async () => null);
    await server.start();

    const client = await connectToSocket(socketPath);
    await new Promise((r) => setTimeout(r, 50));

    // Send a frame with a valid header length but invalid JSON body.
    const badJson = Buffer.from("{this is not json");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(badJson.length, 0);
    client.write(Buffer.concat([header, badJson]));

    // Allow the parse error to propagate and debug-log to flush (sync write).
    await new Promise((r) => setTimeout(r, 100));

    const logPath = path.join(cacheDir, "protondrive", "engine.log");
    assert.equal(fs.existsSync(logPath), true, "debug log should exist");
    const contents = fs.readFileSync(logPath, "utf8");
    assert.match(contents, /IPC parse error/);
    assert.match(contents, /Invalid JSON in IPC message/);

    client.destroy();
  });
});
