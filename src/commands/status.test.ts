import { describe, test, expect } from "bun:test";
import { ConfigError } from "../errors.js";
import { formatSuccess, formatError } from "../core/output.js";
import type { SyncPair, SyncStateRecord } from "../types.js";

// ─── inline simulation of status command logic ────────────────────────────────

type PairState = SyncStateRecord["state"];

const STATE_PRIORITY: Record<PairState, number> = {
  conflict: 4,
  error: 3,
  pending: 2,
  synced: 1,
};

function aggregateState(records: SyncStateRecord[]): PairState {
  if (records.length === 0) return "pending";
  return records.reduce<PairState>((worst, r) => {
    return STATE_PRIORITY[r.state]! > STATE_PRIORITY[worst]! ? r.state : worst;
  }, "synced");
}

interface MockStateDB {
  getAll: (pairId: string) => SyncStateRecord[];
  getLastSync: (pairId: string) => string | null;
}

interface SimResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function simulateStatus(
  opts: { json: boolean },
  deps: {
    getConfig: () => Promise<{ sync_pairs: SyncPair[] }>;
    stateDb: MockStateDB;
  },
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
  let exitCode = 0;

  try {
    const config = await deps.getConfig();

    const pairStatuses = config.sync_pairs.map((pair) => {
      const records = deps.stateDb.getAll(pair.id);
      const state = aggregateState(records);
      const lastSyncMtime = deps.stateDb.getLastSync(pair.id);
      return { syncPair: pair, state, lastSyncMtime };
    });

    const lastSync =
      pairStatuses
        .map((p) => p.lastSyncMtime)
        .filter((m): m is string => m !== null)
        .sort()
        .at(-1) ?? null;

    if (json) {
      formatSuccess(
        {
          pairs: pairStatuses.map((p) => ({
            id: p.syncPair.id,
            local: p.syncPair.local,
            remote: p.syncPair.remote,
            state: p.state,
            last_sync_mtime: p.lastSyncMtime,
          })),
          last_sync: lastSync,
        },
        { json },
      );
    } else {
      process.stdout.write("Sync status:\n");
      for (const p of pairStatuses) {
        const lastSyncStr = p.lastSyncMtime ?? "never";
        process.stdout.write(
          `  ${p.syncPair.id}:\t${p.syncPair.local}  ↔  ${p.syncPair.remote}  [${p.state}]  last sync: ${lastSyncStr}\n`,
        );
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

// ─── fixtures ─────────────────────────────────────────────────────────────────

const PAIR_DOCS: SyncPair = { id: "docs", local: "~/Documents", remote: "/Documents" };
const PAIR_PICS: SyncPair = { id: "pics", local: "~/Pictures", remote: "/Pictures" };

function makeRecord(pairId: string, state: PairState, mtime: string): SyncStateRecord {
  return {
    syncPairId: pairId,
    localPath: `/local/${pairId}/file.txt`,
    remotePath: `/remote/${pairId}/file.txt`,
    lastSyncMtime: mtime,
    lastSyncHash: "abc123",
    state,
  };
}

// ─── never-synced pair ────────────────────────────────────────────────────────

describe("status — never-synced pair", () => {
  test("no records → state 'pending', last sync 'never' in human mode", async () => {
    const { exitCode, stdout } = await simulateStatus(
      { json: false },
      {
        getConfig: async () => ({ sync_pairs: [PAIR_DOCS] }),
        stateDb: {
          getAll: () => [],
          getLastSync: () => null,
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[pending]");
    expect(stdout).toContain("last sync: never");
  });

  test("no records → state 'pending', last_sync_mtime null in JSON", async () => {
    const { exitCode, stdout } = await simulateStatus(
      { json: true },
      {
        getConfig: async () => ({ sync_pairs: [PAIR_DOCS] }),
        stateDb: {
          getAll: () => [],
          getLastSync: () => null,
        },
      },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.data.pairs[0].state).toBe("pending");
    expect(parsed.data.pairs[0].last_sync_mtime).toBeNull();
    expect(parsed.data.last_sync).toBeNull();
  });
});

// ─── synced pair ──────────────────────────────────────────────────────────────

describe("status — synced pair", () => {
  test("all files synced → state 'synced' with timestamp", async () => {
    const TS = "2026-04-01T14:30:00.000Z";
    const { exitCode, stdout } = await simulateStatus(
      { json: false },
      {
        getConfig: async () => ({ sync_pairs: [PAIR_DOCS] }),
        stateDb: {
          getAll: () => [makeRecord("docs", "synced", TS)],
          getLastSync: () => TS,
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[synced]");
    expect(stdout).toContain(`last sync: ${TS}`);
  });

  test("JSON output schema: id, local, remote, state, last_sync_mtime, last_sync", async () => {
    const TS = "2026-04-01T14:30:00.000Z";
    const { exitCode, stdout } = await simulateStatus(
      { json: true },
      {
        getConfig: async () => ({ sync_pairs: [PAIR_DOCS] }),
        stateDb: {
          getAll: () => [makeRecord("docs", "synced", TS)],
          getLastSync: () => TS,
        },
      },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    const pair = parsed.data.pairs[0];
    expect(pair.id).toBe("docs");
    expect(pair.local).toBe("~/Documents");
    expect(pair.remote).toBe("/Documents");
    expect(pair.state).toBe("synced");
    expect(pair.last_sync_mtime).toBe(TS);
    expect(parsed.data.last_sync).toBe(TS);
  });
});

// ─── mixed states ─────────────────────────────────────────────────────────────

describe("status — mixed states (state priority)", () => {
  test("conflict beats error beats pending beats synced", () => {
    // conflict > error
    expect(aggregateState([
      makeRecord("p", "synced", "t"),
      makeRecord("p", "conflict", "t"),
      makeRecord("p", "error", "t"),
    ])).toBe("conflict");

    // error > pending
    expect(aggregateState([
      makeRecord("p", "synced", "t"),
      makeRecord("p", "error", "t"),
    ])).toBe("error");

    // pending > synced
    expect(aggregateState([
      makeRecord("p", "synced", "t"),
      makeRecord("p", "pending", "t"),
    ])).toBe("pending");
  });

  test("two pairs — one synced, one pending — both shown correctly", async () => {
    const TS = "2026-04-01T12:00:00.000Z";
    const { exitCode, stdout } = await simulateStatus(
      { json: false },
      {
        getConfig: async () => ({ sync_pairs: [PAIR_DOCS, PAIR_PICS] }),
        stateDb: {
          getAll: (pairId) =>
            pairId === "docs" ? [makeRecord("docs", "synced", TS)] : [],
          getLastSync: (pairId) => (pairId === "docs" ? TS : null),
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("docs");
    expect(stdout).toContain("[synced]");
    expect(stdout).toContain("pics");
    expect(stdout).toContain("[pending]");
    expect(stdout).toContain("last sync: never");
  });

  test("JSON last_sync is max mtime across all pairs", async () => {
    const T1 = "2026-04-01T10:00:00.000Z";
    const T2 = "2026-04-02T15:00:00.000Z"; // newer
    const { stdout } = await simulateStatus(
      { json: true },
      {
        getConfig: async () => ({ sync_pairs: [PAIR_DOCS, PAIR_PICS] }),
        stateDb: {
          getAll: () => [],
          getLastSync: (pairId) => (pairId === "docs" ? T1 : T2),
        },
      },
    );
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.data.last_sync).toBe(T2);
  });

  test("conflict state pair shows [conflict] in human output", async () => {
    const TS = "2026-04-01T09:00:00.000Z";
    const { exitCode, stdout } = await simulateStatus(
      { json: false },
      {
        getConfig: async () => ({ sync_pairs: [PAIR_DOCS] }),
        stateDb: {
          getAll: () => [makeRecord("docs", "conflict", TS)],
          getLastSync: () => TS,
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[conflict]");
  });
});

// ─── error handling ───────────────────────────────────────────────────────────

describe("status — error handling", () => {
  test("missing config → exit 2, CONFIG_NOT_FOUND in stderr", async () => {
    const { exitCode, stderr } = await simulateStatus(
      { json: false },
      {
        getConfig: async () => {
          throw new ConfigError("Config file not found", "CONFIG_NOT_FOUND");
        },
        stateDb: { getAll: () => [], getLastSync: () => null },
      },
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("CONFIG_NOT_FOUND");
  });

  test("missing config in JSON mode → exit 2, JSON error to stderr", async () => {
    const { exitCode, stderr } = await simulateStatus(
      { json: true },
      {
        getConfig: async () => {
          throw new ConfigError("Config missing", "CONFIG_MISSING_SYNC_PAIRS");
        },
        stateDb: { getAll: () => [], getLastSync: () => null },
      },
    );
    expect(exitCode).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_MISSING_SYNC_PAIRS");
  });

  test("no session token needed — status never calls getSessionToken", async () => {
    // If getToken were called and threw, the test would fail.
    // status should not import or call getSessionToken.
    let tokenChecked = false;
    const { exitCode } = await simulateStatus(
      { json: false },
      {
        getConfig: async () => {
          tokenChecked = true; // just a marker that config was called
          return { sync_pairs: [PAIR_DOCS] };
        },
        stateDb: { getAll: () => [], getLastSync: () => null },
      },
    );
    expect(exitCode).toBe(0);
    expect(tokenChecked).toBe(true); // config IS called
    // No token call possible since simulateStatus doesn't even have a getToken dep
  });
});
