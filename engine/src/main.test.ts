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
import { handleCommand, _setDriveClientForTests, _setStateDbForTests, _setServerForTests } from "./main.js";
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
});
