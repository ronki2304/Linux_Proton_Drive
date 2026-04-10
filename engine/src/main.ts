import { pathToFileURL } from "node:url";

import pkg from "../package.json" with { type: "json" };
import type { IpcCommand, IpcResponse } from "./ipc.js";
import { IpcServer, resolveSocketPath } from "./ipc.js";
import { createDriveClient } from "./sdk.js";
import type { DriveClient } from "./sdk.js";

const ENGINE_VERSION: string = pkg.version;
const PROTOCOL_VERSION = 1;

let server: IpcServer;

// Module-level authenticated client. Null until first successful token_refresh.
// Replaced on re-auth (second token_refresh); set to null on token_expired.
// Engine is single-connection (enforced by ipc.ts) → single token → single client.
let driveClient: DriveClient | null = null;

// Test-only: inject a mock DriveClient without hitting real auth.
// Underscore prefix signals test-only usage — never call from production code.
export function _setDriveClientForTests(client: DriveClient | null): void {
  driveClient = client;
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

  return {
    type: `${command.type}_result`,
    id: command.id,
    payload: { error: "unknown_command" },
  };
}

async function main(): Promise<void> {
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
