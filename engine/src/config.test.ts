import { describe, it, beforeEach, afterEach, expect } from "bun:test";
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
    expect(result).toEqual({ pairs: [] });
  });

  it("writeConfigYaml creates file if absent, then appends to existing", async () => {
    const { writeConfigYaml, readConfigYaml } = await import("./config.js");

    writeConfigYaml("pair-1", "/home/user/Docs", "/Documents");
    const after1 = readConfigYaml();
    expect(after1.pairs.length).toBe(1);
    expect(after1.pairs[0]!.pair_id).toBe("pair-1");
    expect(after1.pairs[0]!.local_path).toBe("/home/user/Docs");
    expect(after1.pairs[0]!.remote_path).toBe("/Documents");

    writeConfigYaml("pair-2", "/home/user/Photos", "/Photos");
    const after2 = readConfigYaml();
    expect(after2.pairs.length).toBe(2);
    expect(after2.pairs[1]!.pair_id).toBe("pair-2");
  });

  it("writeConfigYaml uses atomic write (tmp + rename)", async () => {
    const { writeConfigYaml } = await import("./config.js");
    writeConfigYaml("pair-x", "/local", "/remote");
    // .tmp file must NOT remain after write
    const configPath = join(tmpDir, "protondrive", "config.yaml");
    const tmpPath = configPath + ".tmp";
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(configPath)).toBe(true);
  });

  it("written YAML contains correct fields", async () => {
    const { writeConfigYaml } = await import("./config.js");
    writeConfigYaml("uuid-abc", "/sync/folder", "/ProtonFolder");
    const configPath = join(tmpDir, "protondrive", "config.yaml");
    const raw = readFileSync(configPath, "utf8");
    const parsed = yaml.load(raw) as { pairs: Array<Record<string, string>> };
    expect(Array.isArray(parsed.pairs)).toBeTruthy();
    const pair = parsed.pairs[0]!;
    expect(pair["pair_id"]).toBe("uuid-abc");
    expect(pair["local_path"]).toBe("/sync/folder");
    expect(pair["remote_path"]).toBe("/ProtonFolder");
    expect(typeof pair["created_at"]).toBe("string");
    // ISO 8601 format check
    expect(isNaN(Date.parse(pair["created_at"]))).toBe(false);
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
    expect(result).toEqual({ pairs: [] });
  });

  it("listConfigPairs returns pair list", async () => {
    const { writeConfigYaml, listConfigPairs } = await import("./config.js");
    writeConfigYaml("p1", "/a", "/b");
    writeConfigYaml("p2", "/c", "/d");
    const pairs = listConfigPairs();
    expect(pairs.length).toBe(2);
    expect(pairs[0]!.pair_id).toBe("p1");
    expect(pairs[1]!.pair_id).toBe("p2");
  });
});
