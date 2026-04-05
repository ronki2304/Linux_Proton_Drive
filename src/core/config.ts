import { load as yamlLoad } from "js-yaml";
import * as os from "os";
import * as path from "path";
import { ConfigError } from "../errors.js";
import type { SyncPair } from "../types.js";

export interface ConfigOptions {
  conflict_strategy?: "copy";
}

export interface Config {
  sync_pairs: SyncPair[];
  options?: ConfigOptions;
}

const CREDENTIAL_KEYS = new Set([
  "token",
  "password",
  "session",
  "secret",
  "credential",
  "access_token",
  "refresh_token",
]);

export function getDefaultConfigPath(): string {
  const xdgConfigHome =
    process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
  return path.join(xdgConfigHome, "protondrive", "config.yaml");
}

function stripCredentials(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!CREDENTIAL_KEYS.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

export async function loadConfig(configPath?: string): Promise<Config> {
  const resolvedPath = configPath ?? getDefaultConfigPath();

  let text: string;
  try {
    text = await Bun.file(resolvedPath).text();
  } catch {
    throw new ConfigError(
      `Config file not found: ${resolvedPath}\n` +
        `Create it at ${resolvedPath} with your sync_pairs configuration.`,
      "CONFIG_NOT_FOUND",
    );
  }

  let parsed: unknown;
  try {
    parsed = yamlLoad(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      `Config file parse error in ${resolvedPath}: ${detail}`,
      "CONFIG_PARSE_ERROR",
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(
      `Config file is empty or not a YAML mapping: ${resolvedPath}`,
      "CONFIG_INVALID",
    );
  }

  const raw = stripCredentials(parsed as Record<string, unknown>);

  if (!Array.isArray(raw["sync_pairs"])) {
    throw new ConfigError(
      `Config file missing required 'sync_pairs' array: ${resolvedPath}`,
      "CONFIG_MISSING_SYNC_PAIRS",
    );
  }

  const syncPairs = raw["sync_pairs"] as unknown[];
  for (let i = 0; i < syncPairs.length; i++) {
    const pair = syncPairs[i];
    if (
      pair === null ||
      typeof pair !== "object" ||
      Array.isArray(pair) ||
      typeof (pair as Record<string, unknown>)["id"] !== "string" ||
      typeof (pair as Record<string, unknown>)["local"] !== "string" ||
      typeof (pair as Record<string, unknown>)["remote"] !== "string"
    ) {
      throw new ConfigError(
        `sync_pairs[${i}] is missing required fields (id, local, remote): ${resolvedPath}`,
        "CONFIG_INVALID_PAIR",
      );
    }
  }

  return {
    sync_pairs: syncPairs as SyncPair[],
    options: (raw["options"] as ConfigOptions | undefined) ?? undefined,
  };
}
