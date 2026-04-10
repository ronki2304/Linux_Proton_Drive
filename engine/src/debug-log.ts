// Debug log writer — leaf module with zero internal imports.
//
// Mirrors errors.ts in being importable by every other engine file without
// creating circular dependencies. ONLY ``node:fs``, ``node:path``, ``node:os``
// are allowed here.
//
// Engine stderr goes to ``/dev/null`` in production. When the user sets
// ``PROTONDRIVE_DEBUG=1`` we append framing/parse error context to a capped
// log file under ``$XDG_CACHE_HOME/protondrive/engine.log`` so that crashes
// in the IPC pipeline can be diagnosed without affecting the production wire
// format. Tokens are NEVER routed through this API — the signature accepts
// only string messages and ``Error``/``unknown`` causes.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB cap, then rotate to .log.1

function isEnabled(): boolean {
  return process.env["PROTONDRIVE_DEBUG"] === "1";
}

function resolveLogPath(): string {
  // Empty string is treated as unset — XDG spec says relative XDG_CACHE_HOME
  // must be ignored, and an empty value would otherwise produce a relative
  // path that lands in cwd.
  const cacheHome =
    process.env["XDG_CACHE_HOME"] || path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "protondrive", "engine.log");
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function rotateIfNeeded(filePath: string): void {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
  if (size >= MAX_LOG_BYTES) {
    const rotated = `${filePath}.1`;
    try {
      fs.unlinkSync(rotated);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    fs.renameSync(filePath, rotated);
  }
}

const MAX_CAUSE_CHAIN_DEPTH = 10;

function formatCause(cause: unknown): string {
  if (cause === undefined || cause === null) {
    return "";
  }
  if (cause instanceof Error) {
    // Walk the cause chain with a seen-set + depth cap so a circular chain
    // (errorA.cause = errorB; errorB.cause = errorA) cannot loop forever.
    const chain: string[] = [];
    const seen = new Set<Error>();
    let current: Error | undefined = cause;
    while (current && !seen.has(current) && chain.length < MAX_CAUSE_CHAIN_DEPTH) {
      seen.add(current);
      chain.push(`${current.name}: ${current.message}`);
      const next: unknown = (current as Error & { cause?: unknown }).cause;
      current = next instanceof Error ? next : undefined;
    }
    return ` cause=${chain.join(" <- ")}`;
  }
  return ` cause=${String(cause)}`;
}

/** Append a debug message when ``PROTONDRIVE_DEBUG=1`` is set.
 *
 * No-op when the env var is unset. The signature only accepts a string
 * message and an optional ``Error`` cause — there is no path to log an
 * arbitrary string payload here, so a token can never accidentally be
 * passed in. Callers in ``catch (err: unknown)`` blocks should narrow with
 * ``err instanceof Error ? err : new Error(String(err))``.
 */
export function debugLog(message: string, cause?: Error): void {
  if (!isEnabled()) {
    return;
  }
  try {
    const filePath = resolveLogPath();
    ensureDir(filePath);
    rotateIfNeeded(filePath);
    const line = `${new Date().toISOString()} ${message}${formatCause(cause)}\n`;
    fs.appendFileSync(filePath, line);
  } catch {
    // Debug logging must never escalate — swallow any FS error silently.
  }
}
