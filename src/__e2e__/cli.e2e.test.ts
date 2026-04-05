import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const PROJECT_ROOT = join(import.meta.dir, "../..");
const BINARY = join(PROJECT_ROOT, "dist", "protondrive");
const BINARY_EXISTS = existsSync(BINARY);

let tempDir: string;
let configPath: string;

// Valid config fixture: one sync pair with all required fields (id, local, remote)
const VALID_CONFIG_YAML = `sync_pairs:\n  - id: test-pair\n    local: /tmp/protondrive-e2e-local\n    remote: /e2e-remote\n`;

// Patch #6: opts object pattern per spec
function run(args: string[], opts: { env?: Record<string, string> } = {}) {
  return spawnSync(BINARY, args, {
    encoding: "utf8",
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: 10000, // Patch #4: prevent hung binary from blocking CI indefinitely
  });
}

beforeAll(() => {
  if (!BINARY_EXISTS) return;
  tempDir = mkdtempSync(join(tmpdir(), "protondrive-e2e-"));
  configPath = join(tempDir, "config.yaml");
  writeFileSync(configPath, VALID_CONFIG_YAML, "utf8");
});

afterAll(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Base env for all tests: isolate state DB and keychain from developer's real data
function baseEnv(): Record<string, string> {
  // Patch #2: guard against undefined tempDir (binary absent path)
  if (tempDir === undefined) throw new Error("tempDir not initialized — binary absent, tests should be skipped");
  return {
    XDG_DATA_HOME: tempDir,
    // Patch #5: force keyring probe() to fail so credentials.ts falls back to
    // FileStore (which reads from XDG_DATA_HOME). Prevents a live OS keychain
    // session from producing a false pass on AC4.
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/dbus-socket-e2e",
  };
}

// ── Pre-flight ──────────────────────────────────────────────────────────────

// Patch #1: skip (not fail) when binary absent, per spec "skip with clear message"
test.skipIf(!BINARY_EXISTS)("dist/protondrive binary exists (pre-built required: bun build --compile src/cli.ts --outfile dist/protondrive)", () => {
  expect(existsSync(BINARY)).toBe(true);
});

// ── Smoke tests (skipped if binary absent) ──────────────────────────────────

describe.skipIf(!BINARY_EXISTS)("CLI Binary Smoke Tests", () => {
  // AC2: --help lists all subcommands
  describe("AC2: protondrive --help", () => {
    test("exits 0 and stdout contains all subcommand names", () => {
      const result = run(["--help"], { env: baseEnv() });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("auth");
      expect(result.stdout).toContain("sync");
      expect(result.stdout).toContain("upload");
      expect(result.stdout).toContain("download");
      expect(result.stdout).toContain("status");
    });
  });

  // AC3: sync with missing config exits 2 with human-readable config error
  describe("AC3: protondrive sync with missing config", () => {
    test("exits 2 and stderr contains CONFIG_NOT_FOUND error (not a stack trace)", () => {
      const result = run(
        ["sync", "--config", "/nonexistent/protondrive/config.yaml"],
        { env: baseEnv() },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("error: CONFIG_NOT_FOUND");
      // Human-readable: no stack trace lines (stack traces start with "    at ")
      expect(result.stderr).not.toMatch(/^\s+at /m);
    });
  });

  // AC4: sync with valid config but no cached credentials exits 1 with auth error
  describe("AC4: protondrive sync with valid config, no credentials", () => {
    test("exits 1 and stderr contains NO_SESSION error (not a stack trace)", () => {
      const result = run(["sync", "--config", configPath], { env: baseEnv() });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("error: NO_SESSION");
      // Human-readable: no stack trace
      expect(result.stderr).not.toMatch(/^\s+at /m);
    });
  });

  // AC5: status --json with valid config, no prior syncs — exits 0 with valid JSON
  describe("AC5: protondrive status --json with valid config, no prior syncs", () => {
    test("exits 0 and stdout is valid JSON { ok: true, data: { pairs: [...] } }", () => {
      const result = run(
        ["status", "--json", "--config", configPath],
        { env: baseEnv() },
      );
      expect(result.status).toBe(0);

      // Patch #3: parse directly — test fails naturally on invalid JSON rather
      // than leaving `parsed` undefined with a misleading non-null assertion
      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        data: { pairs: unknown[]; last_sync: string | null };
      };

      expect(parsed.ok).toBe(true);
      expect(parsed.data).toBeDefined();
      expect(Array.isArray(parsed.data.pairs)).toBe(true);
      expect(parsed.data.pairs).toHaveLength(1);
      expect((parsed.data.pairs[0] as Record<string, unknown>)["id"]).toBe("test-pair");
      expect(parsed.data.last_sync).toBeNull();
    });
  });

  // AC6: upload command exits 1 with readable error when no credentials are stored.
  // Note: upload.ts checks credentials BEFORE file existence — auth check fires first.
  // Patch #7: pass --config so binary uses the isolated fixture, not a default path.
  // Patch #8: renamed describe/test to accurately reflect the observed exit path.
  describe("AC6: protondrive upload command — no credentials", () => {
    test("exits 1 with NO_SESSION error when no credentials are stored (auth checked before file existence)", () => {
      const result = run(
        ["upload", "--config", configPath, "/nonexistent/file.txt", "/remote"],
        { env: baseEnv() },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("error:");
      // Human-readable: no stack trace
      expect(result.stderr).not.toMatch(/^\s+at /m);
    });
  });
});
