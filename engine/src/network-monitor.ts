import net from "node:net";
import type { IpcPushEvent } from "./ipc.js";

async function defaultOnlineCheck(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "1.1.1.1", port: 443 });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 3000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

export class NetworkMonitor {
  private isOnline = true; // optimistic default — corrected by first runCheck()
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly emitEvent: (e: IpcPushEvent) => void;
  private readonly checkFn: () => Promise<boolean>;

  constructor(
    emitEvent: (e: IpcPushEvent) => void,
    checkFn: () => Promise<boolean> = defaultOnlineCheck,
  ) {
    this.emitEvent = emitEvent;
    this.checkFn = checkFn;
  }

  start(): void {
    void this.runCheck();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  get isCurrentlyOnline(): boolean {
    return this.isOnline;
  }

  /**
   * Cancel the pending poll timer and run a connectivity check immediately.
   * Called when a sync operation fails with a network error so that the
   * offline state is detected and emitted without waiting up to 30 seconds
   * for the next scheduled poll.
   */
  forceCheck(): void {
    if (this.stopped) return;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    void this.runCheck();
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = this.isOnline ? 30_000 : 5_000;
    this.timer = setTimeout(() => void this.runCheck(), delay);
  }

  private async runCheck(): Promise<void> {
    if (this.stopped) return;
    const online = await this.checkFn().catch(() => false);
    if (this.stopped) return;
    if (online !== this.isOnline) {
      this.isOnline = online;
      this.emitEvent({ type: online ? "online" : "offline", payload: {} });
    }
    this.schedule();
  }
}
