import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { CredentialStore } from "../auth/credentials.js";

// Simulate the auth-logout action logic
async function runLogoutAction(
  credStore: CredentialStore,
  json: boolean,
  stdoutFn: (s: string) => void,
): Promise<number> {
  const { formatSuccess, formatError } =
    await import("../core/output.js");

  const stdoutWrites: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    stdoutWrites.push(String(chunk));
    stdoutFn(String(chunk));
    return true;
  };

  try {
    const existing = await credStore.get("session");
    if (!existing) {
      formatSuccess("No active session.", { json });
      return 0;
    }
    await credStore.delete("session");
    formatSuccess("Logged out successfully.", { json });
    return 0;
  } catch (err) {
    formatError(err, { json });
    return 1;
  } finally {
    process.stdout.write = originalStdout;
  }
}

describe("auth logout", () => {
  let outputLines: string[];

  beforeEach(() => {
    outputLines = [];
  });

  test("exits 0 with 'No active session' when no token cached", async () => {
    const store: CredentialStore = {
      get: mock(async () => null),
      set: mock(async () => {}),
      delete: mock(async () => {}),
    };
    const code = await runLogoutAction(store, false, (s) => outputLines.push(s));
    expect(code).toBe(0);
    expect(outputLines.some((l) => l.includes("No active session"))).toBe(true);
  });

  test("deletes session token and outputs success message", async () => {
    const stored: Record<string, string | null> = { session: "tok" };
    const store: CredentialStore = {
      get: mock(async (k) => stored[k] ?? null),
      set: mock(async (k, v) => { stored[k] = v; }),
      delete: mock(async (k) => { stored[k] = null; }),
    };
    const code = await runLogoutAction(store, false, (s) => outputLines.push(s));
    expect(code).toBe(0);
    expect(store.delete).toHaveBeenCalledWith("session");
    expect(outputLines.some((l) => l.includes("Logged out successfully"))).toBe(true);
  });

  test("JSON mode outputs { ok: true } on no-session", async () => {
    const store: CredentialStore = {
      get: mock(async () => null),
      set: mock(async () => {}),
      delete: mock(async () => {}),
    };
    const code = await runLogoutAction(store, true, (s) => outputLines.push(s));
    expect(code).toBe(0);
    const parsed = JSON.parse(outputLines[0]!);
    expect(parsed.ok).toBe(true);
  });

  test("JSON mode outputs { ok: true } on successful logout", async () => {
    const store: CredentialStore = {
      get: mock(async () => "tok"),
      set: mock(async () => {}),
      delete: mock(async () => {}),
    };
    const code = await runLogoutAction(store, true, (s) => outputLines.push(s));
    expect(code).toBe(0);
    const parsed = JSON.parse(outputLines[0]!);
    expect(parsed.ok).toBe(true);
  });
});
