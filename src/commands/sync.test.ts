import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AuthError, ConfigError, SyncError } from "../errors.js";
import { formatSuccess, formatError, makeProgressCallback } from "../core/output.js";
import type { SyncPair, SyncResult, ConflictRecord } from "../types.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

interface SyncDeps {
  getToken: () => Promise<{ accessToken: string; uid: string }>;
  getConfig: () => Promise<{ sync_pairs: SyncPair[] }>;
  runEngine: (pairs: SyncPair[]) => Promise<SyncResult>;
}

interface SimResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function simulateSync(
  opts: { json: boolean },
  deps: SyncDeps,
): Promise<SimResult> {
  let stdoutBuf = "";
  let stderrBuf = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c: string | Uint8Array) => {
    stdoutBuf += String(c);
    return true;
  };
  process.stderr.write = (c: string | Uint8Array) => {
    stderrBuf += String(c);
    return true;
  };

  const json = opts.json;
  const onProgress = makeProgressCallback("sync", { json });

  let exitCode = 0;
  try {
    // Config-first, fail-fast
    const config = await deps.getConfig();
    const token = await deps.getToken();
    void token;

    const result = await deps.runEngine(config.sync_pairs);

    if (!json) {
      for (const conflict of result.conflicts) {
        process.stdout.write(
          `[conflict] ${conflict.original} → ${conflict.conflictCopy}\n`,
        );
      }
    }

    if (json) {
      formatSuccess(
        {
          transferred: result.transferred,
          conflicts: result.conflicts.map((c: ConflictRecord) => ({
            original: c.original,
            conflictCopy: c.conflictCopy,
          })),
          errors: result.errors,
        },
        { json },
      );
    } else {
      process.stdout.write(
        `Sync complete: ${result.transferred} file(s) transferred, ${result.conflicts.length} conflict(s) detected.\n`,
      );
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          process.stderr.write(`error: SYNC_ERROR — ${err}\n`);
        }
        exitCode = 1;
      }
    }
  } catch (err) {
    formatError(err, { json });
    exitCode = err instanceof ConfigError ? 2 : 1;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }

  return { exitCode, stdout: stdoutBuf, stderr: stderrBuf };
}

const MOCK_TOKEN = { accessToken: "tok", uid: "uid" };
const PAIR: SyncPair = { id: "p1", local: "/tmp/docs", remote: "/remote/docs" };

function makeEmptyResult(): SyncResult {
  return { transferred: 0, conflicts: [], errors: [] };
}

// ─── human mode ───────────────────────────────────────────────────────────────

describe("sync command — human mode", () => {
  test("success: prints summary with transferred count", async () => {
    const { exitCode, stdout } = await simulateSync(
      { json: false },
      {
        getConfig: async () => ({ sync_pairs: [PAIR] }),
        getToken: async () => MOCK_TOKEN,
        runEngine: async () => ({ transferred: 5, conflicts: [], errors: [] }),
      },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("5 file(s) transferred");
    expect(stdout).toContain("0 conflict(s)");
  });

  test("progress lines written for each file (via onProgress callback)", async () => {
    let progressCb: ((msg: string) => void) | undefined;
    const { exitCode, stdout } = await simulateSync(
      { json: false },
      {
        getConfig: async () => ({ sync_pairs: [PAIR] }),
        getToken: async () => MOCK_TOKEN,
        runEngine: async (_pairs) => {
          // Simulate onProgress being called — test it via makeProgressCallback directly
          const cb = makeProgressCallback("sync", { json: false });
          progressCb = cb;
          cb("Uploading /tmp/docs/file.txt");
          return { transferred: 1, conflicts: [], errors: [] };
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(progressCb).toBeDefined();
    expect(stdout).toContain("[sync] Uploading /tmp/docs/file.txt");
    expect(stdout).toContain("1 file(s) transferred");
  });

  test("conflict notice printed: [conflict] original → conflictCopy", async () => {
    const { exitCode, stdout } = await simulateSync(
      { json: false },
      {
        getConfig: async () => ({ sync_pairs: [PAIR] }),
        getToken: async () => MOCK_TOKEN,
        runEngine: async () => ({
          transferred: 2,
          conflicts: [
            {
              original: "/tmp/docs/notes.md",
              conflictCopy: "/tmp/docs/notes.md.conflict-2026-04-01",
            },
          ],
          errors: [],
        }),
      },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "[conflict] /tmp/docs/notes.md → /tmp/docs/notes.md.conflict-2026-04-01",
    );
    expect(stdout).toContain("1 conflict(s)");
  });

  test("partial errors → exit 1, errors written to stderr", async () => {
    const { exitCode, stderr } = await simulateSync(
      { json: false },
      {
        getConfig: async () => ({ sync_pairs: [PAIR] }),
        getToken: async () => MOCK_TOKEN,
        runEngine: async () => ({
          transferred: 2,
          conflicts: [],
          errors: ["Failed to upload /tmp/docs/big.zip: timeout"],
        }),
      },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("big.zip");
    expect(stderr).toContain("timeout");
  });

  test("no output on empty folder (0 transfers, 0 conflicts)", async () => {
    const { exitCode, stdout } = await simulateSync(
      { json: false },
      {
        getConfig: async () => ({ sync_pairs: [PAIR] }),
        getToken: async () => MOCK_TOKEN,
        runEngine: async () => makeEmptyResult(),
      },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("0 file(s) transferred");
    expect(stdout).toContain("0 conflict(s)");
  });
});

// ─── JSON mode ────────────────────────────────────────────────────────────────

describe("sync command — JSON mode", () => {
  test("success: JSON output with transferred count and empty arrays", async () => {
    const { exitCode, stdout } = await simulateSync(
      { json: true },
      {
        getConfig: async () => ({ sync_pairs: [PAIR] }),
        getToken: async () => MOCK_TOKEN,
        runEngine: async () => ({ transferred: 3, conflicts: [], errors: [] }),
      },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.data.transferred).toBe(3);
    expect(parsed.data.conflicts).toEqual([]);
    expect(parsed.data.errors).toEqual([]);
  });

  test("conflicts included in JSON conflicts array", async () => {
    const { exitCode, stdout } = await simulateSync(
      { json: true },
      {
        getConfig: async () => ({ sync_pairs: [PAIR] }),
        getToken: async () => MOCK_TOKEN,
        runEngine: async () => ({
          transferred: 2,
          conflicts: [
            {
              original: "/tmp/notes.md",
              conflictCopy: "/tmp/notes.md.conflict-2026-04-01",
            },
          ],
          errors: [],
        }),
      },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.data.conflicts).toHaveLength(1);
    expect(parsed.data.conflicts[0].original).toBe("/tmp/notes.md");
    expect(parsed.data.conflicts[0].conflictCopy).toContain("conflict-");
  });

  test("no progress lines in JSON mode — stdout is only final JSON", async () => {
    const { stdout } = await simulateSync(
      { json: true },
      {
        getConfig: async () => ({ sync_pairs: [PAIR] }),
        getToken: async () => MOCK_TOKEN,
        runEngine: async () => {
          const cb = makeProgressCallback("sync", { json: true });
          cb("Uploading something"); // should be suppressed
          return { transferred: 1, conflicts: [], errors: [] };
        },
      },
    );
    // Only one line of output — the JSON
    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });

  test("errors included in JSON errors array", async () => {
    const { stdout } = await simulateSync(
      { json: true },
      {
        getConfig: async () => ({ sync_pairs: [PAIR] }),
        getToken: async () => MOCK_TOKEN,
        runEngine: async () => ({
          transferred: 0,
          conflicts: [],
          errors: ["Failed to download /remote/file.txt: timeout"],
        }),
      },
    );
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.data.errors).toHaveLength(1);
    expect(parsed.data.errors[0]).toContain("timeout");
  });
});

// ─── error handling / exit codes ──────────────────────────────────────────────

describe("sync command — error handling", () => {
  test("ConfigError → exit 2, error to stderr", async () => {
    const { exitCode, stderr } = await simulateSync(
      { json: false },
      {
        getConfig: async () => {
          throw new ConfigError("Config file not found: /no/config.yaml", "CONFIG_NOT_FOUND");
        },
        getToken: async () => MOCK_TOKEN,
        runEngine: async () => makeEmptyResult(),
      },
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("CONFIG_NOT_FOUND");
  });

  test("ConfigError in JSON mode → exit 2, JSON error to stderr", async () => {
    const { exitCode, stderr } = await simulateSync(
      { json: true },
      {
        getConfig: async () => {
          throw new ConfigError("Config missing sync_pairs", "CONFIG_MISSING_SYNC_PAIRS");
        },
        getToken: async () => MOCK_TOKEN,
        runEngine: async () => makeEmptyResult(),
      },
    );
    expect(exitCode).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_MISSING_SYNC_PAIRS");
  });

  test("AuthError → exit 1, NO_SESSION in error output", async () => {
    const { exitCode, stderr } = await simulateSync(
      { json: false },
      {
        getConfig: async () => ({ sync_pairs: [PAIR] }),
        getToken: async () => {
          throw new AuthError(
            "No session found — run 'protondrive auth login'.",
            "NO_SESSION",
          );
        },
        runEngine: async () => makeEmptyResult(),
      },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("NO_SESSION");
  });

  test("SyncEngine throws → exit 1, error to stderr", async () => {
    const { exitCode, stderr } = await simulateSync(
      { json: false },
      {
        getConfig: async () => ({ sync_pairs: [PAIR] }),
        getToken: async () => MOCK_TOKEN,
        runEngine: async () => {
          throw new SyncError("Unexpected engine failure", "SYNC_ENGINE_ERROR");
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("SYNC_ENGINE_ERROR");
  });

  test("ConfigError checked BEFORE getToken — no network call on bad config", async () => {
    let tokenCalled = false;
    const { exitCode } = await simulateSync(
      { json: false },
      {
        getConfig: async () => {
          throw new ConfigError("Bad config", "CONFIG_INVALID");
        },
        getToken: async () => {
          tokenCalled = true;
          return MOCK_TOKEN;
        },
        runEngine: async () => makeEmptyResult(),
      },
    );
    expect(exitCode).toBe(2);
    expect(tokenCalled).toBe(false);
  });
});
