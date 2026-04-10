import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";

// Each test uses its own temp dir via XDG_CONFIG_HOME override.
let tmpDir: string;
let origXdg: string | undefined;

function setTmpConfig(): void {
  tmpDir = mkdtempSync(join(tmpdir(), "config-test-"));
  origXdg = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = tmpDir;
}

function restoreXdg(): void {
  if (origXdg === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = origXdg;
  }
  rmSync(tmpDir, { recursive: true, force: true });
}

describe("config.ts helpers", () => {
  beforeEach(() => {
    setTmpConfig();
  });

  afterEach(() => {
    restoreXdg();
  });

  it("readConfigYaml returns empty pairs when file absent", async () => {
    // Dynamic import after env is set so getConfigPath() resolves to tmpDir.
    const { readConfigYaml } = await import("./config.js");
    const result = readConfigYaml();
    assert.deepEqual(result, { pairs: [] });
  });

  it("writeConfigYaml creates file if absent, then appends to existing", async () => {
    const { writeConfigYaml, readConfigYaml } = await import("./config.js");

    writeConfigYaml("pair-1", "/home/user/Docs", "/Documents");
    const after1 = readConfigYaml();
    assert.equal(after1.pairs.length, 1);
    assert.equal(after1.pairs[0]!.pair_id, "pair-1");
    assert.equal(after1.pairs[0]!.local_path, "/home/user/Docs");
    assert.equal(after1.pairs[0]!.remote_path, "/Documents");

    writeConfigYaml("pair-2", "/home/user/Photos", "/Photos");
    const after2 = readConfigYaml();
    assert.equal(after2.pairs.length, 2);
    assert.equal(after2.pairs[1]!.pair_id, "pair-2");
  });

  it("writeConfigYaml uses atomic write (tmp + rename)", async () => {
    const { writeConfigYaml } = await import("./config.js");
    writeConfigYaml("pair-x", "/local", "/remote");
    // .tmp file must NOT remain after write
    const configPath = join(tmpDir, "protondrive", "config.yaml");
    const tmpPath = configPath + ".tmp";
    assert.equal(existsSync(tmpPath), false, ".tmp file must not remain");
    assert.equal(existsSync(configPath), true, "config.yaml must exist");
  });

  it("written YAML contains correct fields", async () => {
    const { writeConfigYaml } = await import("./config.js");
    writeConfigYaml("uuid-abc", "/sync/folder", "/ProtonFolder");
    const configPath = join(tmpDir, "protondrive", "config.yaml");
    const raw = readFileSync(configPath, "utf8");
    const parsed = yaml.load(raw) as { pairs: Array<Record<string, string>> };
    assert.ok(Array.isArray(parsed.pairs));
    const pair = parsed.pairs[0]!;
    assert.equal(pair["pair_id"], "uuid-abc");
    assert.equal(pair["local_path"], "/sync/folder");
    assert.equal(pair["remote_path"], "/ProtonFolder");
    assert.ok(typeof pair["created_at"] === "string");
    // ISO 8601 format check
    assert.ok(!isNaN(Date.parse(pair["created_at"])));
  });

  it("readConfigYaml returns empty pairs on corrupt YAML", async () => {
    const { writeConfigYaml, readConfigYaml } = await import("./config.js");
    // Write something valid first to create directory
    writeConfigYaml("p1", "/a", "/b");
    const configPath = join(tmpDir, "protondrive", "config.yaml");
    // Overwrite with garbage
    const { writeFileSync } = await import("node:fs");
    writeFileSync(configPath, "{ invalid yaml: [[[", "utf8");
    const result = readConfigYaml();
    assert.deepEqual(result, { pairs: [] });
  });

  it("listConfigPairs returns pair list", async () => {
    const { writeConfigYaml, listConfigPairs } = await import("./config.js");
    writeConfigYaml("p1", "/a", "/b");
    writeConfigYaml("p2", "/c", "/d");
    const pairs = listConfigPairs();
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0]!.pair_id, "p1");
    assert.equal(pairs[1]!.pair_id, "p2");
  });
});
