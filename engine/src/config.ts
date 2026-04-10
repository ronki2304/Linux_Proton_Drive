import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";

export interface ConfigPair {
  pair_id: string;
  local_path: string;
  remote_path: string;
  created_at: string; // ISO 8601
}

interface ConfigFile {
  pairs: ConfigPair[];
}

function getConfigPath(): string {
  const xdgConfig =
    process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(xdgConfig, "protondrive", "config.yaml");
}

export function readConfigYaml(): ConfigFile {
  try {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) {
      return { pairs: [] };
    }
    const raw = readFileSync(configPath, "utf8");
    const parsed = yaml.load(raw);
    if (
      parsed === null ||
      parsed === undefined ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as Record<string, unknown>)["pairs"])
    ) {
      return { pairs: [] };
    }
    return parsed as ConfigFile;
  } catch {
    return { pairs: [] };
  }
}

export function listConfigPairs(): ConfigPair[] {
  return readConfigYaml().pairs;
}

export function writeConfigYaml(
  pair_id: string,
  local_path: string,
  remote_path: string,
): void {
  const configPath = getConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });

  const existing = readConfigYaml();
  const newPair: ConfigPair = {
    pair_id,
    local_path,
    remote_path,
    created_at: new Date().toISOString(),
  };
  existing.pairs.push(newPair);

  const tmpPath = configPath + ".tmp";
  writeFileSync(tmpPath, yaml.dump(existing), "utf8");
  renameSync(tmpPath, configPath);
}
