import { pathToFileURL } from "node:url";
import https from "node:https";
import tls from "node:tls";
import { fetch as undiciFetch, setGlobalDispatcher, Agent } from "undici";

// ---------------------------------------------------------------------------
// Flatpak DNS-over-HTTPS workaround
//
// The Flatpak sandbox blocks outbound UDP port 53, so all standard DNS
// resolution fails (dns.resolve4, dns.lookup, libc getaddrinfo).  TCP/443
// (HTTPS) is allowed.
//
// Fix: resolve hostnames via Cloudflare's DoH JSON API at 1.1.1.1:443.
// We connect using the IP directly (no DNS needed for the DoH server itself).
// Resolved IPs are cached for the process lifetime.
//
// Then replace globalThis.fetch with undici's fetch so that sdk.ts's fetch()
// calls go through our custom Agent dispatcher (which uses the DoH lookup),
// instead of Node's built-in fetch (which uses its own bundled undici that
// has already captured dns.lookup at startup).
// ---------------------------------------------------------------------------

const _dohCache = new Map<string, string>();

function _resolveViaDoH(hostname: string): Promise<string> {
  const cached = _dohCache.get(hostname);
  if (cached !== undefined) return Promise.resolve(cached);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "1.1.1.1", // IP — no DNS needed
        port: 443,
        path: `/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
        method: "GET",
        headers: { Accept: "application/dns-json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString();
            process.stderr.write(`[ENGINE] DoH raw: ${body.slice(0, 300)}\n`);
            const parsed = JSON.parse(body) as {
              Status?: number;
              Answer?: Array<{ type: number; data: string }>;
            };
            // type 1 = A record; follow through CNAMEs (type 5)
            const aRecord = parsed.Answer?.find((r) => r.type === 1);
            if (aRecord?.data) {
              _dohCache.set(hostname, aRecord.data);
              resolve(aRecord.data);
            } else {
              reject(new Error(`DoH: no A record for ${hostname} (status=${parsed.Status ?? "?"}, answers=${JSON.stringify(parsed.Answer ?? [])})`));
            }
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

if (process.env["FLATPAK_ID"]) {
  setGlobalDispatcher(
    new Agent({
      // Use the connector function API (not connect.lookup) for full control.
      // undici v8's connect.lookup has an incompatible callback contract that
      // drops our resolved IP.  The connector function receives full TLS options
      // and lets us supply a pre-resolved socket directly.
      connect: (
        opts: Record<string, unknown>,
        callback: (err: Error | null, socket: unknown) => void,
      ) => {
        const hostname = (opts["hostname"] ?? opts["host"] ?? "") as string;
        _resolveViaDoH(hostname)
          .then((ip) => {
            process.stderr.write(`[ENGINE] connect: ${hostname} → ${ip}\n`);
            const port = Number(opts["port"]) || 443;
            const socket = tls.connect({
              host: ip,
              port,
              servername: (opts["servername"] ?? hostname) as string,
              ALPNProtocols: ["http/1.1"],
            });
            socket.once("secureConnect", () => callback(null, socket));
            socket.once("error", (err: Error) => callback(err, null));
          })
          .catch((err: unknown) =>
            callback(err instanceof Error ? err : new Error(String(err)), null),
          );
      },
    }),
  );
  // Replace globalThis.fetch so all fetch() calls in this process go through
  // undici's dispatcher (which uses our DoH lookup) instead of Node's built-in
  // fetch (which uses a separately bundled undici with DNS already captured).
  (globalThis as unknown as Record<string, unknown>).fetch = undiciFetch;
  process.stderr.write("[ENGINE] Flatpak DNS override active (DoH via 1.1.1.1)\n");

  // Smoke tests — remove after confirmed working
  _resolveViaDoH("drive-api.proton.me")
    .then((ip) => {
      process.stderr.write(`[ENGINE] DoH test OK: drive-api.proton.me → ${ip}\n`);
      // Now test actual HTTPS fetch to the resolved IP
      return undiciFetch("https://drive-api.proton.me/core/v4/addresses", { method: "GET" });
    })
    .then((r) => process.stderr.write(`[ENGINE] HTTPS test OK: HTTP ${r.status}\n`))
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      const c1 = e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
      const c2 = e instanceof Error && e.cause instanceof Error && (e.cause as NodeJS.ErrnoException).cause instanceof Error
        ? ((e.cause as NodeJS.ErrnoException).cause as Error).message : "";
      process.stderr.write(`[ENGINE] HTTPS test FAILED: ${msg} | c1: ${c1} | c2: ${c2}\n`);
    });
}

import pkg from "../package.json" with { type: "json" };
import type { IpcCommand, IpcResponse } from "./ipc.js";
import { IpcServer, resolveSocketPath } from "./ipc.js";
import { createDriveClient } from "./sdk.js";
import type { DriveClient } from "./sdk.js";
import { StateDb } from "./state-db.js";
import type { SyncPair } from "./state-db.js";
import { writeConfigYaml } from "./config.js";
import { SyncEngine } from "./sync-engine.js";
import { FileWatcher } from "./watcher.js";

const ENGINE_VERSION: string = pkg.version;
const PROTOCOL_VERSION = 1;

let server: IpcServer;

// Module-level authenticated client. Null until first successful token_refresh.
// Replaced on re-auth (second token_refresh); set to null on token_expired.
// Engine is single-connection (enforced by ipc.ts) → single token → single client.
let driveClient: DriveClient | null = null;

// Module-level state database. Undefined until main() initialises it.
let stateDb: StateDb | undefined;

// Module-level sync engine. Undefined until main() initialises it.
let syncEngine: SyncEngine | undefined;

// Module-level file watcher. Undefined until first successful token_refresh.
let fileWatcher: FileWatcher | undefined;

// Per-key bcrypt salts cached from a locked-scope token.
// GET /core/v4/keys/salts requires "locked" scope (pre-2FA window only).
// We pre-fetch immediately on every token_refresh so salts are available
// even after the scope is upgraded to "full" by completing 2FA.
// undefined = not yet fetched; [] = fetched but empty; non-empty = ready.
let cachedSaltArray: Array<{ ID: string; KeySalt: string | null }> | undefined =
  undefined;

// Test-only: inject a mock DriveClient without hitting real auth.
// Underscore prefix signals test-only usage — never call from production code.
export function _setDriveClientForTests(client: DriveClient | null): void {
  driveClient = client;
}

// Test-only: inject an IpcServer so handleUnlockKeys / handleTokenRefresh can
// call server.emitEvent() in unit tests without running main().
export function _setServerForTests(s: IpcServer): void {
  server = s;
}

// Test-only: inject a StateDb instance for add_pair / get_status tests.
// Underscore prefix signals test-only usage — never call from production code.
export function _setStateDbForTests(db: StateDb | undefined): void {
  stateDb = db;
}

// Test-only: inject a SyncEngine instance for integration tests.
// Underscore prefix signals test-only usage — never call from production code.
export function _setSyncEngineForTests(engine: SyncEngine | undefined): void {
  syncEngine = engine;
}

// Test-only: inject a FileWatcher instance for tests.
// Underscore prefix signals test-only usage — never call from production code.
export function _setFileWatcherForTests(fw: FileWatcher | undefined): void {
  fileWatcher = fw;
}

// ---------------------------------------------------------------------------
// Session setup helper — called after a valid client + unlocked keys exist.
// Starts the file watcher and sync engine, then emits session_ready.
// key_password is included in the payload when it was derived in this session
// so the UI can persist it to the OS keyring (AC4).
// ---------------------------------------------------------------------------
function _activateSession(
  client: DriveClient,
  info: Record<string, unknown>,
  keyPassword?: string,
): void {
  driveClient = client;
  syncEngine?.setDriveClient(client);
  void syncEngine?.startSyncAll();
  fileWatcher?.stop();
  fileWatcher = new FileWatcher(
    stateDb!.listPairs(),
    async (_pairId) => {
      await syncEngine!.startSyncAll();
    },
    (e) => server.emitEvent(e),
  );
  void fileWatcher.initialize();
  const payload: Record<string, unknown> = { ...info };
  if (keyPassword !== undefined) {
    payload["key_password"] = keyPassword;
  }
  server.emitEvent({ type: "session_ready", payload });
}

async function handleTokenRefresh(command: IpcCommand): Promise<void> {
  const raw = command.payload?.["token"] as string | undefined;

  if (!raw) {
    driveClient = null;
    syncEngine?.setDriveClient(null);
    fileWatcher?.stop();
    fileWatcher = undefined;
    server.emitEvent({ type: "token_expired", payload: { queued_changes: 0 } });
    return;
  }

  // Token is encoded as "uid:accesstoken" by auth_window.py (cookie poller path).
  // Split on first colon only — accesstoken itself contains no colons.
  const colonIdx = raw.indexOf(":");
  const uid = colonIdx > 0 ? raw.slice(0, colonIdx) : undefined;
  const token = colonIdx > 0 ? raw.slice(colonIdx + 1) : raw;
  process.stderr.write(
    `[ENGINE] token_refresh: rawLen=${raw.length} hasColon=${colonIdx > 0} uidLen=${uid?.length ?? 0} tokenLen=${token.length}\n`
  );

  // key_password is present when the UI retrieved it from the OS keyring (AC4).
  const storedKeyPassword = command.payload?.["key_password"] as
    | string
    | undefined;

  // login_password + captured_salts are captured from Proton's web UI during
  // browser auth via JS injection. When both are present we can derive and
  // unlock keys without asking the user for a password again.
  const loginPassword = command.payload?.["login_password"] as
    | string
    | undefined;
  const capturedSalts = command.payload?.["captured_salts"] as
    | Array<{ ID: string; KeySalt: string | null }>
    | undefined;

  try {
    const client = createDriveClient(token, uid);
    const info = (await client.validateSession()) as unknown as Record<
      string,
      unknown
    >;
    driveClient = client;

    if (storedKeyPassword !== undefined) {
      // Relaunch with stored keyPassword — try silent unlock.
      try {
        await client.applyKeyPassword(storedKeyPassword);
        _activateSession(client, info);
        return;
      } catch {
        // Stored keyPassword invalid (password changed / key rotation) — fall
        // through to next strategy.
        process.stderr.write(
          "[ENGINE] stored keyPassword failed — trying captured data\n",
        );
      }
    }

    // Try silent unlock using login password + salts captured from browser.
    // This bypasses the locked-scope restriction on GET /core/v4/keys/salts.
    process.stderr.write(
      `[ENGINE] token_refresh: loginPassword=${loginPassword !== undefined ? "yes" : "no"} capturedSalts=${capturedSalts?.length ?? 0}\n`
    );
    if (loginPassword !== undefined && capturedSalts !== undefined && capturedSalts.length > 0) {
      try {
        process.stderr.write(`[ENGINE] attempting silent unlock with ${capturedSalts.length} captured salt(s)\n`);
        const keyPassword = await client.deriveAndUnlock(loginPassword, undefined, capturedSalts);
        _activateSession(client, info, keyPassword);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[ENGINE] silent unlock with captured data failed: ${msg}\n`);
        // Fall through to key_unlock_required.
      }
    }

    // Pre-fetch key salts NOW, while this token may still have locked scope.
    // The locked-scope window is brief (post-password, pre-2FA). If we wait
    // until the user submits the dialog, the token may have been replaced by a
    // full-scope one (which cannot access /core/v4/keys/salts).
    if (cachedSaltArray === undefined) {
      try {
        const salts = await client.fetchKeySalts();
        cachedSaltArray = salts;
        process.stderr.write(`[ENGINE] pre-fetched ${salts.length} key salt(s)\n`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[ENGINE] pre-fetch salts failed (will retry on unlock): ${msg}\n`);
        cachedSaltArray = []; // mark attempted so we don't retry endlessly
      }
    }

    // DEBUG: dump live token to /tmp so probe-key-decrypt.ts can use it.
    // Remove after key-decryption is confirmed working.
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync("/tmp/proton-debug-token.txt", raw, { mode: 0o600 });
      process.stderr.write("[ENGINE] DEBUG token dumped → /tmp/proton-debug-token.txt\n");
    } catch { /* ignore */ }

    // No keyPassword available — request it from the UI.
    server.emitEvent({ type: "key_unlock_required", payload: {} });
  } catch (e) {
    const _cause =
      e instanceof Error
        ? e.cause instanceof Error
          ? e.cause.message
          : String(e.cause ?? "")
        : "";
    process.stderr.write(
      `[ENGINE] validateSession failed: ${e instanceof Error ? e.message : String(e)} | cause: ${_cause}\n`,
    );

    // Token invalid — clear everything and report expiry.
    cachedSaltArray = undefined; // reset so next login gets a fresh pre-fetch
    driveClient = null;
    syncEngine?.setDriveClient(null);
    fileWatcher?.stop();
    fileWatcher = undefined;
    server.emitEvent({ type: "token_expired", payload: { queued_changes: 0 } });
  }
}

// ---------------------------------------------------------------------------
// unlock_keys handler (AC5, Story 2.11)
//
// Receives the user's raw login password, derives keyPassword via bcrypt,
// decrypts private keys, then emits session_ready on success or
// key_unlock_required with an error hint on failure.
//
// SECURITY: password is discarded immediately after deriveAndUnlock returns
// (never stored, never logged, never emitted over IPC). Only keyPassword
// (the bcrypt output) is included in session_ready payload for keyring storage.
// ---------------------------------------------------------------------------
async function handleUnlockKeys(command: IpcCommand): Promise<void> {
  if (!driveClient) {
    // No active client — token_refresh must arrive first
    server.emitEvent({ type: "key_unlock_required", payload: {} });
    return;
  }

  const password = command.payload?.["password"] as string | undefined;
  if (!password) {
    server.emitEvent({ type: "key_unlock_required", payload: {} });
    return;
  }
  process.stderr.write(`[ENGINE] handleUnlockKeys: passwordLen=${password.length} firstCharCode=${password.charCodeAt(0)}\n`);

  try {
    // Use pre-cached salts from the locked-scope window (if available), so the
    // derivation doesn't need to call /core/v4/keys/salts with a full-scope
    // token that would return 403.
    const saltsForUnlock = cachedSaltArray !== undefined && cachedSaltArray.length > 0
      ? cachedSaltArray
      : undefined;
    process.stderr.write(
      `[ENGINE] handleUnlockKeys: cachedSaltArray=${cachedSaltArray === undefined ? "none" : `${cachedSaltArray.length} salt(s)`}\n`,
    );
    const keyPassword = await driveClient.deriveAndUnlock(password, undefined, saltsForUnlock);
    const info = (await driveClient.validateSession()) as unknown as Record<
      string,
      unknown
    >;
    _activateSession(driveClient, info, keyPassword);
  } catch (e) {
    // Wrong password or network error — let user retry.
    // Do NOT log password or keyPassword.
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[ENGINE] handleUnlockKeys failed: ${msg}\n`);
    server.emitEvent({ type: "key_unlock_required", payload: { error: "unlock_failed" } });
  }
}

export async function handleCommand(
  command: IpcCommand,
): Promise<IpcResponse | null> {
  // token_refresh responds via push events, not _result
  if (command.type === "token_refresh") {
    await handleTokenRefresh(command);
    return null;
  }

  // unlock_keys responds via push events (session_ready or key_unlock_required)
  if (command.type === "unlock_keys") {
    await handleUnlockKeys(command);
    return null;
  }

  if (command.type === "list_remote_folders") {
    if (!driveClient) {
      return {
        type: "list_remote_folders_result",
        id: command.id,
        payload: { error: "engine_not_ready" },
      };
    }
    const parentId = (command.payload?.["parent_id"] ?? null) as string | null;
    try {
      const folders = await driveClient.listRemoteFolders(parentId);
      return {
        type: "list_remote_folders_result",
        id: command.id,
        payload: { folders },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown_error";
      return {
        type: "list_remote_folders_result",
        id: command.id,
        payload: { error: message },
      };
    }
  }

  if (command.type === "add_pair") {
    if (!driveClient || !stateDb) {
      return {
        type: "add_pair_result",
        id: command.id,
        payload: { error: "engine_not_ready" },
      };
    }

    const localPath = command.payload?.["local_path"] as string | undefined;
    const remotePath = command.payload?.["remote_path"] as string | undefined;

    if (!localPath || !remotePath) {
      return {
        type: "add_pair_result",
        id: command.id,
        payload: { error: "invalid_payload" },
      };
    }

    // Resolve remote_id: best-effort match of first path segment against root folders.
    // Falls back to "" on any error — Story 2.5 resolves on first sync.
    let remoteId = "";
    try {
      const rootFolders = await driveClient.listRemoteFolders(null);
      const firstSegment = remotePath.replace(/^\//, "").split("/")[0] ?? "";
      const match = rootFolders.find((f) => f.name === firstSegment);
      if (match !== undefined) {
        remoteId = match.id;
      }
    } catch {
      // network / SDK error — fall back to ""
      // TODO(story-2.5): resolve remote_id for unresolved/nested paths
    }

    const pairId = crypto.randomUUID();
    const pair: SyncPair = {
      pair_id: pairId,
      local_path: localPath,
      remote_path: remotePath,
      remote_id: remoteId,
      created_at: new Date().toISOString(),
      last_synced_at: null,
    };

    try {
      stateDb.insertPair(pair);
    } catch {
      return {
        type: "add_pair_result",
        id: command.id,
        payload: { error: "db_write_failed" },
      };
    }

    try {
      writeConfigYaml(pairId, localPath, remotePath);
    } catch {
      // YAML write failed — attempt rollback of DB insert
      try {
        stateDb.deletePair(pairId);
      } catch (rollbackErr) {
        console.error(`add_pair: rollback deletePair failed: ${rollbackErr}`);
      }
      return {
        type: "add_pair_result",
        id: command.id,
        payload: { error: "config_write_failed" },
      };
    }

    // Restart FileWatcher to include the new pair's directory, then kick off
    // an initial sync so files already in the local folder are uploaded.
    if (driveClient) {
      fileWatcher?.stop();
      fileWatcher = new FileWatcher(
        stateDb.listPairs(),
        async (_pairId) => {
          await syncEngine!.startSyncAll();
        },
        (e) => server.emitEvent(e),
      );
      void fileWatcher.initialize();
      void syncEngine?.startSyncAll();
    }

    return {
      type: "add_pair_result",
      id: command.id,
      payload: { pair_id: pairId },
    };
  }

  if (command.type === "get_status") {
    if (!stateDb) {
      return {
        type: "get_status_result",
        id: command.id,
        payload: { error: "engine_not_ready" },
      };
    }
    const pairs = stateDb.listPairs().map((p) => ({
      pair_id: p.pair_id,
      local_path: p.local_path,
      remote_path: p.remote_path,
      last_synced_at: p.last_synced_at ?? null,
    }));
    return {
      type: "get_status_result",
      id: command.id,
      payload: { pairs, online: true },
    };
  }

  return {
    type: `${command.type}_result`,
    id: command.id,
    payload: { error: "unknown_command" },
  };
}

async function main(): Promise<void> {
  stateDb = new StateDb();
  syncEngine = new SyncEngine(stateDb, (e) => server.emitEvent(e));
  const socketPath = resolveSocketPath();
  server = new IpcServer(socketPath, handleCommand);

  server.onConnect(() => {
    server.emitEvent({
      type: "ready",
      payload: {
        version: ENGINE_VERSION,
        protocol_version: PROTOCOL_VERSION,
      },
    });
  });

  server.onClose(() => {
    process.exit(0);
  });

  await server.start();

  process.on("SIGTERM", () => {
    server.close();
  });

  process.on("SIGINT", () => {
    server.close();
  });
}

// Only run main() when this file is executed directly, not when imported by
// tests. Use pathToFileURL so paths with spaces, symlinks, or characters that
// require URL encoding are compared correctly against import.meta.url.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
