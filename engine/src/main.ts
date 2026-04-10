import { pathToFileURL } from "node:url";

import pkg from "../package.json" with { type: "json" };
import type { IpcCommand, IpcResponse } from "./ipc.js";
import { IpcServer, resolveSocketPath } from "./ipc.js";
import { createDriveClient } from "./sdk.js";
import type { DriveClient } from "./sdk.js";
import { StateDb } from "./state-db.js";
import type { SyncPair } from "./state-db.js";
import { writeConfigYaml } from "./config.js";

const ENGINE_VERSION: string = pkg.version;
const PROTOCOL_VERSION = 1;

let server: IpcServer;

// Module-level authenticated client. Null until first successful token_refresh.
// Replaced on re-auth (second token_refresh); set to null on token_expired.
// Engine is single-connection (enforced by ipc.ts) → single token → single client.
let driveClient: DriveClient | null = null;

// Module-level state database. Undefined until main() initialises it.
let stateDb: StateDb | undefined;

// Test-only: inject a mock DriveClient without hitting real auth.
// Underscore prefix signals test-only usage — never call from production code.
export function _setDriveClientForTests(client: DriveClient | null): void {
  driveClient = client;
}

// Test-only: inject a StateDb instance for add_pair / get_status tests.
// Underscore prefix signals test-only usage — never call from production code.
export function _setStateDbForTests(db: StateDb | undefined): void {
  stateDb = db;
}

async function handleTokenRefresh(command: IpcCommand): Promise<void> {
  const token = command.payload?.["token"] as string | undefined;

  if (!token) {
    server.emitEvent({ type: "token_expired", payload: { queued_changes: 0 } });
    return;
  }

  try {
    const client = createDriveClient(token);
    const info = await client.validateSession();
    driveClient = client;
    server.emitEvent({ type: "session_ready", payload: info as unknown as Record<string, unknown> });
  } catch {
    // Any engine error → session invalid
    driveClient = null;
    server.emitEvent({ type: "token_expired", payload: { queued_changes: 0 } });
  }
}

export async function handleCommand(
  command: IpcCommand,
): Promise<IpcResponse | null> {
  // token_refresh responds via push events, not _result
  if (command.type === "token_refresh") {
    await handleTokenRefresh(command);
    return null;
  }

  if (command.type === "list_remote_folders") {
    if (!driveClient) {
      return {
        type: "list_remote_folders_result",
        id: command.id,
        payload: { error: "engine_not_ready" },
      };
    }
    const parentId = (command.payload?.["parent_id"] ?? null) as string | null;
    try {
      const folders = await driveClient.listRemoteFolders(parentId);
      return {
        type: "list_remote_folders_result",
        id: command.id,
        payload: { folders },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown_error";
      return {
        type: "list_remote_folders_result",
        id: command.id,
        payload: { error: message },
      };
    }
  }

  if (command.type === "add_pair") {
    if (!driveClient || !stateDb) {
      return {
        type: "add_pair_result",
        id: command.id,
        payload: { error: "engine_not_ready" },
      };
    }

    const localPath = command.payload?.["local_path"] as string | undefined;
    const remotePath = command.payload?.["remote_path"] as string | undefined;

    if (!localPath || !remotePath) {
      return {
        type: "add_pair_result",
        id: command.id,
        payload: { error: "invalid_payload" },
      };
    }

    // Resolve remote_id: best-effort match of first path segment against root folders.
    // Falls back to "" on any error — Story 2.5 resolves on first sync.
    let remoteId = "";
    try {
      const rootFolders = await driveClient.listRemoteFolders(null);
      const firstSegment = remotePath.replace(/^\//, "").split("/")[0] ?? "";
      const match = rootFolders.find((f) => f.name === firstSegment);
      if (match !== undefined) {
        remoteId = match.id;
      }
    } catch {
      // network / SDK error — fall back to ""
      // TODO(story-2.5): resolve remote_id for unresolved/nested paths
    }

    const pairId = crypto.randomUUID();
    const pair: SyncPair = {
      pair_id: pairId,
      local_path: localPath,
      remote_path: remotePath,
      remote_id: remoteId,
      created_at: new Date().toISOString(),
    };

    try {
      stateDb.insertPair(pair);
    } catch {
      return {
        type: "add_pair_result",
        id: command.id,
        payload: { error: "db_write_failed" },
      };
    }

    try {
      writeConfigYaml(pairId, localPath, remotePath);
    } catch {
      // YAML write failed — attempt rollback of DB insert
      try {
        stateDb.deletePair(pairId);
      } catch (rollbackErr) {
        console.error(`add_pair: rollback deletePair failed: ${rollbackErr}`);
      }
      return {
        type: "add_pair_result",
        id: command.id,
        payload: { error: "config_write_failed" },
      };
    }

    return {
      type: "add_pair_result",
      id: command.id,
      payload: { pair_id: pairId },
    };
  }

  if (command.type === "get_status") {
    if (!stateDb) {
      return {
        type: "get_status_result",
        id: command.id,
        payload: { error: "engine_not_ready" },
      };
    }
    const pairs = stateDb.listPairs().map((p) => ({
      pair_id: p.pair_id,
      local_path: p.local_path,
      remote_path: p.remote_path,
    }));
    return {
      type: "get_status_result",
      id: command.id,
      payload: { pairs, online: true },
    };
  }

  return {
    type: `${command.type}_result`,
    id: command.id,
    payload: { error: "unknown_command" },
  };
}

async function main(): Promise<void> {
  stateDb = new StateDb();
  const socketPath = resolveSocketPath();
  server = new IpcServer(socketPath, handleCommand);

  server.onConnect(() => {
    server.emitEvent({
      type: "ready",
      payload: {
        version: ENGINE_VERSION,
        protocol_version: PROTOCOL_VERSION,
      },
    });
  });

  server.onClose(() => {
    process.exit(0);
  });

  await server.start();

  process.on("SIGTERM", () => {
    server.close();
  });

  process.on("SIGINT", () => {
    server.close();
  });
}

// Only run main() when this file is executed directly, not when imported by
// tests. Use pathToFileURL so paths with spaces, symlinks, or characters that
// require URL encoding are compared correctly against import.meta.url.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
