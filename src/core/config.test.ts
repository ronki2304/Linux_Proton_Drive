import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadConfig, getDefaultConfigPath } from "./config.js";
import { ConfigError } from "../errors.js";

const VALID_CONFIG_YAML = `
sync_pairs:
  - id: docs
    local: ~/Documents
    remote: /Documents
  - id: pics
    local: ~/Pictures
    remote: /Pictures
options:
  conflict_strategy: copy
`;

const MINIMAL_CONFIG_YAML = `
sync_pairs:
  - id: test
    local: /tmp/local
    remote: /remote
`;

describe("getDefaultConfigPath", () => {
  test("uses XDG_CONFIG_HOME when set", () => {
    const original = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = "/custom/xdg";
    try {
      expect(getDefaultConfigPath()).toBe("/custom/xdg/protondrive/config.yaml");
    } finally {
      if (original === undefined) {
        delete process.env["XDG_CONFIG_HOME"];
      } else {
        process.env["XDG_CONFIG_HOME"] = original;
      }
    }
  });

  test("falls back to ~/.config when XDG_CONFIG_HOME is not set", () => {
    const original = process.env["XDG_CONFIG_HOME"];
    delete process.env["XDG_CONFIG_HOME"];
    try {
      const expected = path.join(os.homedir(), ".config", "protondrive", "config.yaml");
      expect(getDefaultConfigPath()).toBe(expected);
    } finally {
      if (original !== undefined) {
        process.env["XDG_CONFIG_HOME"] = original;
      }
    }
  });
});

describe("loadConfig", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "protondrive-test-"));
    configPath = path.join(tmpDir, "config.yaml");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("parses valid config with sync_pairs", async () => {
    fs.writeFileSync(configPath, VALID_CONFIG_YAML);
    const config = await loadConfig(configPath);
    expect(config.sync_pairs).toHaveLength(2);
    expect(config.sync_pairs[0]?.id).toBe("docs");
    expect(config.sync_pairs[1]?.id).toBe("pics");
    expect(config.options?.conflict_strategy).toBe("copy");
  });

  test("parses minimal config with only sync_pairs", async () => {
    fs.writeFileSync(configPath, MINIMAL_CONFIG_YAML);
    const config = await loadConfig(configPath);
    expect(config.sync_pairs).toHaveLength(1);
    expect(config.options).toBeUndefined();
  });

  test("throws ConfigError when file does not exist", async () => {
    await expect(loadConfig("/nonexistent/path/config.yaml")).rejects.toThrow(ConfigError);
  });

  test("missing file error has actionable message", async () => {
    try {
      await loadConfig("/nonexistent/path/config.yaml");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("Config file not found");
      expect((err as ConfigError).code).toBe("CONFIG_NOT_FOUND");
    }
  });

  test("throws ConfigError on malformed YAML", async () => {
    fs.writeFileSync(configPath, "sync_pairs: [\n  bad: yaml: [\n");
    await expect(loadConfig(configPath)).rejects.toThrow(ConfigError);
  });

  test("malformed YAML error code is CONFIG_PARSE_ERROR", async () => {
    fs.writeFileSync(configPath, ": invalid: yaml:");
    try {
      await loadConfig(configPath);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("CONFIG_PARSE_ERROR");
    }
  });

  test("throws ConfigError when sync_pairs is missing", async () => {
    fs.writeFileSync(configPath, "options:\n  conflict_strategy: copy\n");
    try {
      await loadConfig(configPath);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("CONFIG_MISSING_SYNC_PAIRS");
    }
  });

  test("strips credential fields from parsed config", async () => {
    const configWithCreds = `
sync_pairs:
  - id: docs
    local: ~/Documents
    remote: /Documents
token: super-secret-token
password: hunter2
`;
    fs.writeFileSync(configPath, configWithCreds);
    const config = await loadConfig(configPath);
    const raw = config as unknown as Record<string, unknown>;
    expect(raw["token"]).toBeUndefined();
    expect(raw["password"]).toBeUndefined();
    expect(config.sync_pairs).toHaveLength(1);
  });

  test("custom --config path overrides default", async () => {
    const customPath = path.join(tmpDir, "custom.yaml");
    fs.writeFileSync(customPath, MINIMAL_CONFIG_YAML);
    const config = await loadConfig(customPath);
    expect(config.sync_pairs).toHaveLength(1);
  });

  test("XDG_CONFIG_HOME affects resolved default path", () => {
    const original = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = tmpDir;
    try {
      const expectedPath = path.join(tmpDir, "protondrive", "config.yaml");
      expect(getDefaultConfigPath()).toBe(expectedPath);
    } finally {
      if (original === undefined) {
        delete process.env["XDG_CONFIG_HOME"];
      } else {
        process.env["XDG_CONFIG_HOME"] = original;
      }
    }
  });
});
