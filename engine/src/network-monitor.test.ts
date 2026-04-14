import { describe, it, expect, afterEach } from "bun:test";
import type { IpcPushEvent } from "./ipc.js";
import { NetworkMonitor } from "./network-monitor.js";

describe("NetworkMonitor", () => {
  // Flush the micro-task queue so the initial async checkFn resolves
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("isCurrentlyOnline is true before first check resolves (optimistic default)", () => {
    let resolveCheck!: (v: boolean) => void;
    const neverResolves = new Promise<boolean>((resolve) => {
      resolveCheck = resolve;
    });
    const monitor = new NetworkMonitor(() => neverResolves);
    expect(monitor.isCurrentlyOnline).toBe(true);
    monitor.stop();
    resolveCheck(false); // cleanup
  });

  it("emits offline immediately when checkFn returns false", async () => {
    const events: IpcPushEvent[] = [];
    const monitor = new NetworkMonitor(
      (e) => events.push(e),
      async () => false,
    );
    monitor.start();
    await flush();
    expect(events[0]?.type).toBe("offline");
    monitor.stop();
  });

  it("does not emit offline on first check when checkFn returns true", async () => {
    const events: IpcPushEvent[] = [];
    const monitor = new NetworkMonitor(
      (e) => events.push(e),
      async () => true,
    );
    monitor.start();
    await flush();
    expect(events).toHaveLength(0);
    monitor.stop();
  });

  it("emits online after offline state when checkFn resolves true", async () => {
    const events: IpcPushEvent[] = [];
    let callCount = 0;
    const monitor = new NetworkMonitor(
      (e) => events.push(e),
      async () => {
        callCount++;
        // First call: offline; subsequent: online
        return callCount > 1;
      },
    );
    monitor.start();
    await flush();
    expect(events[0]?.type).toBe("offline");

    // Manually trigger a second runCheck by accessing the private method
    // We do this by calling start again after stopping/resetting internally.
    // Instead, we verify by constructing a sequence monitor:
    monitor.stop();

    // Use a second monitor that starts online then goes back online — verify online emits
    const events2: IpcPushEvent[] = [];
    let call2 = 0;
    const monitor2 = new NetworkMonitor(
      (e) => events2.push(e),
      async () => {
        call2++;
        if (call2 === 1) return false; // offline
        return true; // back online
      },
    );
    monitor2.start();
    await flush(); // first check → offline event
    expect(events2[0]?.type).toBe("offline");
    expect((monitor2 as unknown as { isOnline: boolean }).isOnline).toBe(false);

    // Trigger runCheck again by calling start() won't work since it's already running
    // Access private method via cast
    await (monitor2 as unknown as { runCheck(): Promise<void> }).runCheck();
    expect(events2[1]?.type).toBe("online");
    expect(monitor2.isCurrentlyOnline).toBe(true);
    monitor2.stop();
  });

  it("does not re-emit offline on repeated failures", async () => {
    const events: IpcPushEvent[] = [];
    const monitor = new NetworkMonitor(
      (e) => events.push(e),
      async () => false,
    );
    monitor.start();
    await flush();

    // Trigger multiple additional checks manually
    const m = monitor as unknown as { runCheck(): Promise<void> };
    await m.runCheck();
    await m.runCheck();

    const offlineEvents = events.filter((e) => e.type === "offline");
    expect(offlineEvents).toHaveLength(1);
    monitor.stop();
  });

  it("does not re-emit online on repeated successes", async () => {
    const events: IpcPushEvent[] = [];
    // Start in offline state, then repeated online checks
    let call = 0;
    const monitor = new NetworkMonitor(
      (e) => events.push(e),
      async () => {
        call++;
        return call > 1; // first: offline, then: online
      },
    );
    monitor.start();
    await flush(); // emits offline

    const m = monitor as unknown as { runCheck(): Promise<void> };
    await m.runCheck(); // emits online (transition)
    await m.runCheck(); // no event (already online)
    await m.runCheck(); // no event (already online)

    const onlineEvents = events.filter((e) => e.type === "online");
    expect(onlineEvents).toHaveLength(1);
    monitor.stop();
  });

  it("stop() cancels the pending timer and prevents further events", async () => {
    const events: IpcPushEvent[] = [];
    // Monitor that goes offline so we can ensure no further events after stop
    const monitor = new NetworkMonitor(
      (e) => events.push(e),
      async () => false,
    );
    monitor.start();
    await flush();
    const countAfterFirstCheck = events.length;
    monitor.stop();

    // Any pending timers are cleared; calling runCheck after stop emits nothing
    const m = monitor as unknown as { runCheck(): Promise<void> };
    await m.runCheck();
    expect(events.length).toBe(countAfterFirstCheck);
  });

  it("isCurrentlyOnline reflects last known state correctly", async () => {
    const events: IpcPushEvent[] = [];
    let call = 0;
    const monitor = new NetworkMonitor(
      (e) => events.push(e),
      async () => {
        call++;
        return call > 1; // first: offline, then: online
      },
    );
    monitor.start();
    await flush();
    expect(monitor.isCurrentlyOnline).toBe(false);

    const m = monitor as unknown as { runCheck(): Promise<void> };
    await m.runCheck();
    expect(monitor.isCurrentlyOnline).toBe(true);
    monitor.stop();
  });
});
