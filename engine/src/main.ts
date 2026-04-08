import pkg from "../package.json" with { type: "json" };

import type { IpcCommand, IpcResponse } from "./ipc.js";
import { IpcServer, resolveSocketPath } from "./ipc.js";

const PROTOCOL_VERSION = 1;

let server: IpcServer;

async function handleTokenRefresh(
  command: IpcCommand,
): Promise<void> {
  const token = command.payload?.["token"] as string | undefined;

  if (!token) {
    server.emitEvent({
      type: "token_expired",
      payload: { queued_changes: 0 },
    });
    return;
  }

  // TODO: Story 1-13 will add DriveClient.validateSession(token)
  // For now, emit session_ready with placeholder data.
  // The real implementation will call sdk.ts DriveClient wrapper.
  server.emitEvent({
    type: "session_ready",
    payload: {
      display_name: "",
      email: "",
      storage_used: 0,
      storage_total: 0,
      plan: "",
    },
  });
}

async function handleCommand(
  command: IpcCommand,
): Promise<IpcResponse | null> {
  // token_refresh responds via push events, not _result
  if (command.type === "token_refresh") {
    await handleTokenRefresh(command);
    return null;
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
        version: pkg.version,
        protocol_version: PROTOCOL_VERSION,
      },
    });
  });

  await server.start();

  process.on("SIGTERM", () => {
    server.close();
  });

  process.on("SIGINT", () => {
    server.close();
  });
}

void main();
