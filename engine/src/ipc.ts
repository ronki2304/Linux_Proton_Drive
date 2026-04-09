import net from "node:net";
import path from "node:path";
import fs from "node:fs";

import { IpcError, ConfigError } from "./errors.js";
import { debugLog } from "./debug-log.js";

// --- Protocol Types (snake_case wire format) ---

export interface IpcCommand {
  type: string;
  id: string;
  payload?: Record<string, unknown>;
}

export interface IpcResponse {
  type: string;
  id: string;
  payload?: Record<string, unknown>;
}

export interface IpcPushEvent {
  type: string;
  payload: Record<string, unknown>;
}

export type IpcMessage = IpcCommand | IpcResponse | IpcPushEvent;

// --- MessageReader ---

const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1 MB
const HEADER_SIZE = 4;

export class MessageReader {
  private buffer = Buffer.alloc(0);

  feed(chunk: Buffer): IpcMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: IpcMessage[] = [];

    while (this.buffer.length >= HEADER_SIZE) {
      const payloadLength = this.buffer.readUInt32BE(0);

      if (payloadLength > MAX_PAYLOAD_SIZE) {
        this.buffer = Buffer.alloc(0);
        throw new IpcError(
          `Payload size ${payloadLength} exceeds maximum ${MAX_PAYLOAD_SIZE}`,
        );
      }

      if (payloadLength === 0) {
        this.buffer = this.buffer.subarray(HEADER_SIZE);
        throw new IpcError("Zero-length payload");
      }

      if (this.buffer.length < HEADER_SIZE + payloadLength) {
        break; // Incomplete message
      }

      const jsonBytes = this.buffer.subarray(
        HEADER_SIZE,
        HEADER_SIZE + payloadLength,
      );
      this.buffer = this.buffer.subarray(HEADER_SIZE + payloadLength);

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonBytes.toString("utf8"));
      } catch (err: unknown) {
        throw new IpcError("Invalid JSON in IPC message", { cause: err });
      }

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as Record<string, unknown>)["type"] !== "string"
      ) {
        throw new IpcError(
          "Invalid IPC message: missing or non-string 'type' field",
        );
      }

      messages.push(parsed as IpcMessage);
    }

    return messages;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

// --- Wire helpers ---

export function encodeMessage(message: IpcMessage): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.alloc(HEADER_SIZE + json.length);
  frame.writeUInt32BE(json.length, 0);
  json.copy(frame, HEADER_SIZE);
  return frame;
}

export function writeMessage(
  socket: net.Socket,
  message: IpcMessage,
): boolean {
  return socket.write(encodeMessage(message));
}

// --- Socket path ---

export function resolveSocketPath(): string {
  const runtimeDir = process.env["XDG_RUNTIME_DIR"];
  if (!runtimeDir) {
    throw new ConfigError("XDG_RUNTIME_DIR not set");
  }
  const socketDir = path.join(
    runtimeDir,
    "io.github.ronki2304.ProtonDriveLinuxClient",
  );
  return path.join(socketDir, "sync-engine.sock");
}

function ensureSocketDir(socketPath: string): void {
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true });
}

function removeStaleSocket(socketPath: string): void {
  try {
    fs.unlinkSync(socketPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

// --- IPC Server ---

export type CommandHandler = (
  command: IpcCommand,
) => Promise<IpcResponse | null>;

export type ConnectionHandler = () => void;

export class IpcServer {
  private server: net.Server;
  private activeConnection: net.Socket | null = null;
  private reader = new MessageReader();
  private commandHandler: CommandHandler;
  private connectionHandler: ConnectionHandler | null = null;
  private closeHandler: (() => void) | null = null;
  private socketPath: string;
  // Per-connection backpressure state. Reset on close/error.
  // FIFO order matters: sync_progress events arrive in temporal order and the
  // UI's progress indicator would jitter if drain re-flushed out-of-order.
  private writeQueue: Buffer[] = [];
  private draining: boolean = false;

  constructor(socketPath: string, commandHandler: CommandHandler) {
    this.socketPath = socketPath;
    this.commandHandler = commandHandler;
    this.server = net.createServer(this.onConnection.bind(this));
  }

  onConnect(handler: ConnectionHandler): void {
    this.connectionHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  async start(): Promise<void> {
    ensureSocketDir(this.socketPath);
    removeStaleSocket(this.socketPath);

    return new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
  }

  private onConnection(socket: net.Socket): void {
    if (this.activeConnection !== null) {
      writeMessage(socket, {
        type: "error",
        payload: { code: "ALREADY_CONNECTED" },
      });
      socket.destroy();
      return;
    }

    this.activeConnection = socket;
    this.reader.reset();

    if (this.connectionHandler) {
      this.connectionHandler();
    }

    socket.on("data", (chunk: Buffer) => {
      this.onData(chunk);
    });

    socket.on("close", () => {
      if (this.activeConnection === socket) {
        this.activeConnection = null;
        this.reader.reset();
        this.writeQueue = [];
        this.draining = false;
      }
    });

    socket.on("error", () => {
      if (this.activeConnection === socket) {
        this.activeConnection = null;
        this.reader.reset();
        this.writeQueue = [];
        this.draining = false;
      }
    });
  }

  /** Write a message respecting socket backpressure.
   *
   * When ``socket.write(frame)`` returns ``false`` the kernel send buffer is
   * full. Continuing to write would inflate Node's internal buffer without
   * bound and eventually drop messages, so subsequent writes are queued and
   * flushed in FIFO order on the socket's ``'drain'`` event.
   */
  private enqueueWrite(message: IpcMessage): void {
    const socket = this.activeConnection;
    if (!socket || socket.destroyed) {
      return;
    }
    const frame = encodeMessage(message);
    if (this.draining) {
      this.writeQueue.push(frame);
      return;
    }
    const ok = socket.write(frame);
    if (!ok) {
      this.draining = true;
      socket.once("drain", () => this.flushQueue());
    }
  }

  private flushQueue(): void {
    const socket = this.activeConnection;
    if (!socket || socket.destroyed) {
      this.writeQueue = [];
      this.draining = false;
      return;
    }
    while (this.writeQueue.length > 0) {
      const frame = this.writeQueue.shift()!;
      const ok = socket.write(frame);
      if (!ok) {
        socket.once("drain", () => this.flushQueue());
        return;
      }
    }
    this.draining = false;
  }

  private onData(chunk: Buffer): void {
    let messages: IpcMessage[];
    try {
      messages = this.reader.feed(chunk);
    } catch (err: unknown) {
      const cause = err instanceof Error ? err : new Error(String(err));
      debugLog("IPC parse error", cause);
      if (this.activeConnection) {
        this.enqueueWrite({
          type: "error",
          payload: { code: "PARSE_ERROR", message: cause.message },
        });
      }
      return;
    }

    for (const msg of messages) {
      const command = msg as IpcCommand;
      this.handleCommand(command).catch((err: unknown) => {
        const cause = err instanceof Error ? err : new Error(String(err));
        debugLog(`IPC command handler error (type=${command.type})`, cause);
        if (this.activeConnection) {
          this.enqueueWrite({
            type: `${command.type}_result`,
            id: command.id,
            payload: { error: cause.message },
          });
        }
      });
    }
  }

  private async handleCommand(command: IpcCommand): Promise<void> {
    if (command.type === "shutdown") {
      this.close();
      return;
    }

    const socket = this.activeConnection;
    const response = await this.commandHandler(command);
    // Only write if the originating connection is still the active one — a
    // close-and-reopen during the await would otherwise mis-route the response.
    if (
      response &&
      socket &&
      socket === this.activeConnection &&
      !socket.destroyed
    ) {
      this.enqueueWrite(response);
    }
  }

  emitEvent(event: IpcPushEvent): void {
    this.enqueueWrite(event);
  }

  close(): void {
    if (this.activeConnection) {
      this.activeConnection.destroy();
      this.activeConnection = null;
    }
    this.server.close(() => {
      if (this.closeHandler) {
        this.closeHandler();
      }
    });
  }

  get connected(): boolean {
    return this.activeConnection !== null;
  }
}
