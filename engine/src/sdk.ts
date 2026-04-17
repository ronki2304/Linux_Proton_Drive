// SDK BOUNDARY: All @protontech/drive-sdk imports MUST be confined to this file.
// No other engine file may import the SDK directly.
// openpgp imports are also confined here.
//
// DriveClient wraps @protontech/drive-sdk behind a stable, app-shaped
// interface so the rest of the engine (sync orchestrator, IPC handlers, future
// watcher) is insulated from SDK version churn, openpgp wiring, and MaybeNode
// footguns. A 0.14.x SDK bump should only ever touch this file.
//
// The factory `createDriveClient(token)` and `validateSession()` live here
// as of Story 2.2.5 (sdk live wiring).

// ---------------------------------------------------------------------------
// Value imports — classes/enums instantiated or evaluated at runtime
// ---------------------------------------------------------------------------
import {
  AbortError,
  ConnectionError,
  DecryptionError,
  IntegrityError,
  MemoryCache,
  NodeType,
  NodeWithSameNameExistsValidationError,
  NullFeatureFlagProvider,
  OpenPGPCryptoWithCryptoProxy,
  ProtonDriveClient,
  ProtonDriveError,
  RateLimitedError,
  ServerError,
  ValidationError,
} from "@protontech/drive-sdk";

// VERIFICATION_STATUS, SRPModule, PrivateKey, PublicKey are NOT exported from
// the main @protontech/drive-sdk index. They live in the dist/crypto sub-path.
// NodeNext module resolution requires an `exports` map for sub-path imports,
// but this SDK package has none — the JS runtime import works fine because the
// files exist, but TypeScript can't resolve the type path. @ts-ignore suppresses
// the TS2307 "cannot find module" error on both lines.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no exports map; explicit index.js required for Node ESM directory imports
import { VERIFICATION_STATUS } from "@protontech/drive-sdk/dist/crypto/index.js";
// @ts-ignore — no exports map; explicit index.js required for Node ESM directory imports
import type { SRPModule, PrivateKey as SDKPrivateKey, PublicKey as SDKPublicKey } from "@protontech/drive-sdk/dist/crypto/index.js";

// ---------------------------------------------------------------------------
// Type-only imports from the main SDK index
// ---------------------------------------------------------------------------
import type {
  CachedCryptoMaterial,
  MaybeNode,
  NodeEntity,
  OpenPGPCryptoProxy,
  ProtonDriveAccount,
  ProtonDriveAccountAddress,
  ProtonDriveClientContructorParameters,
  ProtonDriveConfig,
  ProtonDriveHTTPClient,
  ProtonDriveHTTPClientBlobRequest,
  ProtonDriveHTTPClientJsonRequest,
  UploadMetadata,
} from "@protontech/drive-sdk";

// Full openpgp bundle (NOT "openpgp/lightweight" — project-context.md hard rule).
// Imported here at the boundary to keep the SDK boundary discipline honest:
// no other engine file may ever import openpgp.
import * as openpgp from "openpgp";

import bcrypt from "bcryptjs";

import { EngineError, NetworkError, RateLimitError, SyncError } from "./errors.js";
import { debugLog } from "./debug-log.js";

// ---------------------------------------------------------------------------
// Boundary types — snake_case wire shape (project-context.md "snake_case on
// Both Sides"). These flow directly into IPC push events; do NOT camelCase
// them on the way out.
// ---------------------------------------------------------------------------

/**
 * Sentinel value for `RemoteFolder.parent_id` indicating "child of MyFiles
 * root". Distinct from a regular Proton node UID (which never starts with
 * `<`), so the folder picker (Story 2.3) and any caller can disambiguate
 * top-level entries from nodes whose `parentUid` happens to be missing.
 */
export const ROOT_PARENT_ID = "<root>";

export interface RemoteFolder {
  /** Node UID. */
  id: string;
  /** Decrypted folder name. */
  name: string;
  /**
   * Parent node UID. Top-level folders (children of MyFiles root) carry
   * the `ROOT_PARENT_ID` sentinel — never `null`. If the SDK ever omits a
   * `parentUid` for a non-root child, the wrapper substitutes the parent
   * UID it was asked to list under (the SDK contract guarantees that match).
   */
  parent_id: string;
}

export interface RemoteFile {
  id: string;
  name: string;
  parent_id: string;
  remote_mtime: string; // ISO 8601
  size: number;
}

export interface UploadBody {
  stream: ReadableStream<Uint8Array>;
  sizeBytes: number;
  modificationTime: Date;
  mediaType: string;
}

/**
 * Account information returned by `DriveClient.validateSession()`.
 * snake_case for wire consistency (project-context.md "snake_case on Both Sides").
 */
export interface AccountInfo {
  display_name: string;
  email: string;
  storage_used: number;
  storage_total: number;
  plan: string;
}

/**
 * Structural type for the underlying SDK client.
 *
 * `ProtonDriveClient` exposes 50+ methods. A test mock that satisfies the
 * entire surface is impractical. `Pick` declares exactly which SDK methods
 * `DriveClient` consumes — and grows naturally as new methods are added by
 * future stories (2.5, 2.6, etc.). Test fakes only need to satisfy this
 * narrow shape.
 */
export type ProtonDriveClientLike = Pick<
  ProtonDriveClient,
  | "getMyFilesRootFolder"
  | "iterateFolderChildren"
  | "getFileUploader"
  | "getFileRevisionUploader"
  | "getFileDownloader"
  | "createFolder"
  | "trashNodes"
>;

// ---------------------------------------------------------------------------
// SDK error mapping
// ---------------------------------------------------------------------------

/**
 * Translate any thrown SDK error into a typed engine error.
 *
 * Order matters: more specific subclasses must be checked before their
 * parents (RateLimitedError extends ServerError;
 * NodeWithSameNameExistsValidationError extends ValidationError).
 *
 * Token safety: SDK error messages are translated user-facing strings
 * (errors.d.ts) and never include tokens. The wrapper never interpolates
 * cause chains via string concat. (project-context.md "Token must never
 * appear in output")
 */
function mapSdkError(err: unknown): never {
  // Pass-through: an error this wrapper itself raised (e.g. degraded root)
  // is already a typed engine error and must not be re-wrapped as
  // "Unexpected SDK error".
  if (err instanceof EngineError) throw err;

  // Re-throw legitimate aborts as-is.
  if (err instanceof AbortError) throw err;

  // Network family.
  // undici throws TypeError('fetch failed') when the TCP connection is
  // refused or the interface is down — classify it as NetworkError so the
  // engine can distinguish it from genuine SDK bugs.
  // undici throws TypeError('fetch failed') on network-level failures. We
  // check `.name` rather than `instanceof TypeError` because Bun's --compile
  // bundler can produce a cross-realm TypeError where instanceof is false.
  if (err instanceof Error && err.name === "TypeError" && err.message === "fetch failed") {
    throw new NetworkError("Network unavailable", { cause: err });
  }
  if (err instanceof ConnectionError) {
    throw new NetworkError("Network unavailable", { cause: err });
  }
  if (err instanceof RateLimitedError) {
    throw new RateLimitError("Rate limited", { cause: err });
  }
  if (err instanceof ServerError) {
    throw new NetworkError(`API error: ${err.message}`, { cause: err });
  }

  // Sync family.
  if (err instanceof IntegrityError) {
    throw new SyncError("Decryption failed", { cause: err });
  }
  if (err instanceof DecryptionError) {
    throw new SyncError("Decryption failed", { cause: err });
  }
  if (err instanceof ValidationError) {
    throw new SyncError(`Validation failed: ${err.message}`, { cause: err });
  }

  // Generic SDK error fallthrough.
  if (err instanceof ProtonDriveError) {
    throw new SyncError(err.message, { cause: err });
  }

  // Anything else: unexpected.
  throw new SyncError("Unexpected SDK error", { cause: err });
}

// ---------------------------------------------------------------------------
// Test-only: factory for constructing real SDK error instances.
//
// The wrapper's `mapSdkError` uses `instanceof` checks against the actual SDK
// error classes. To unit-test that mapping, the test file needs a way to
// throw real instances of those classes without itself importing from
// `@protontech/drive-sdk` (project-context.md keeps the SDK package import to
// `sdk.ts` only). Exposing factories — not the classes themselves — keeps the
// constructors private to this file: no other engine code can do `instanceof
// ConnectionError`. Production callers of `DriveClient` only ever see typed
// engine errors (`SyncError`, `NetworkError`).
//
// This export is consumed only by `sdk.test.ts`. It is intentionally NOT
// declared on the public engine API.
// ---------------------------------------------------------------------------

export const sdkErrorFactoriesForTests = {
  connection: (msg = "connection failed") => new ConnectionError(msg),
  rateLimited: (msg = "rate limited") => new RateLimitedError(msg),
  server: (msg = "server boom") => new ServerError(msg),
  integrity: (msg = "integrity") => new IntegrityError(msg),
  decryption: (msg = "decryption") => new DecryptionError(msg),
  validation: (msg = "validation") => new ValidationError(msg),
  nodeWithSameName: (msg = "name collision") =>
    new NodeWithSameNameExistsValidationError(msg, 409),
  abort: (msg = "aborted") => new AbortError(msg),
  protonDrive: (msg = "generic sdk") => new ProtonDriveError(msg),
} as const;

// ---------------------------------------------------------------------------
// DriveClient wrapper
// ---------------------------------------------------------------------------

export class DriveClient {
  constructor(
    private readonly sdk: ProtonDriveClientLike,
    private readonly account?: ProtonDriveAccount,
    private readonly accountAdapter?: ProtonAccountAdapter,
  ) {}

  /**
   * Lazily list immediate folder children.
   *
   * - `parentId === null` resolves children of `getMyFilesRootFolder()` —
   *   i.e. top-level folders only.
   * - A folder UID returns that folder's direct children only (no recursive
   *   prefetch — Story 2.3 folder picker is lazy).
   *
   * Files are filtered out (folder picker shows folders only).
   * `DegradedNode` results (where `.ok === false`) are silently skipped — a
   * partial decryption failure must not break folder browsing. The skip is
   * logged via `debugLog` when `PROTONDRIVE_DEBUG=1`.
   */
  async listRemoteFolders(parentId: string | null): Promise<RemoteFolder[]> {
    try {
      let parent: NodeEntity | string;
      // The wire-shape parent_id we attach to every child of this iteration.
      // For top-level (parentId === null) it is the ROOT_PARENT_ID sentinel;
      // for explicit subfolder iteration it is the parent UID we were asked
      // to list under. We do NOT trust `node.parentUid` from the SDK because
      // it may be undefined for some node types and would otherwise collide
      // with the top-level sentinel — see ROOT_PARENT_ID rationale.
      let childParentId: string;

      if (parentId === null) {
        const root: MaybeNode = await this.sdk.getMyFilesRootFolder();
        if (!root.ok) {
          // Root must always be available; degraded root is unrecoverable.
          throw new SyncError("My Files root unavailable");
        }
        parent = root.value;
        childParentId = ROOT_PARENT_ID;
      } else {
        parent = parentId;
        childParentId = parentId;
      }

      const folders: RemoteFolder[] = [];
      // Server-side filter as a hint; we still re-check NodeType client-side
      // because filterOptions is documented as a hint, not a guarantee.
      for await (const result of this.sdk.iterateFolderChildren(parent, {
        type: NodeType.Folder,
      })) {
        if (!result.ok) {
          debugLog("DriveClient: degraded node skipped in folder list");
          continue;
        }
        const node = result.value;
        if (node.type !== NodeType.Folder) {
          continue;
        }
        folders.push({
          id: node.uid,
          name: node.name,
          parent_id: childParentId,
        });
      }

      return folders;
    } catch (err) {
      mapSdkError(err);
      // Defensive: mapSdkError is typed `never`, but if a future edit ever
      // breaks that contract this throw guarantees the method still rejects
      // instead of silently returning undefined.
      throw err;
    }
  }

  /**
   * Create a folder under the given parent. If `parentId` is null, creates
   * under My Files root. Returns the new folder's node UID.
   *
   * `NodeWithSameNameExistsValidationError` is treated as success — if the
   * folder already exists (race or retry), we list to find its UID.
   */
  async createRemoteFolder(parentId: string | null, name: string): Promise<string> {
    try {
      let parent: string;
      if (parentId === null) {
        const root: MaybeNode = await this.sdk.getMyFilesRootFolder();
        if (!root.ok) throw new SyncError("My Files root unavailable");
        parent = (root.value as { uid: string }).uid;
      } else {
        parent = parentId;
      }
      const result: MaybeNode = await this.sdk.createFolder(parent, name);
      if (!result.ok) throw new SyncError(`Failed to create remote folder "${name}"`);
      return (result.value as { uid: string }).uid;
    } catch (err) {
      // If the folder already exists, find it by listing and return its id.
      if (err instanceof NodeWithSameNameExistsValidationError) {
        const folders = await this.listRemoteFolders(parentId);
        const existing = folders.find((f) => f.name === name);
        if (existing) return existing.id;
        throw new SyncError(`Folder "${name}" exists but could not be found after conflict`);
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      const errType = err instanceof Error ? err.constructor.name : typeof err;
      process.stderr.write(`[ENGINE] createRemoteFolder error type=${errType} msg=${errMsg}\n`);
      if (err instanceof Error && err.cause) {
        process.stderr.write(`[ENGINE] createRemoteFolder cause=${(err.cause as Error).message ?? err.cause}\n`);
      }
      mapSdkError(err);
      throw err;
    }
  }

  /**
   * List all files directly under the given folder UID.
   *
   * `DegradedNode` results (where `.ok === false`) are silently skipped and
   * logged via `debugLog`. Non-file node types are also skipped (the type
   * filter passed to `iterateFolderChildren` is advisory only).
   */
  async listRemoteFiles(parentId: string): Promise<RemoteFile[]> {
    try {
      const files: RemoteFile[] = [];
      for await (const result of this.sdk.iterateFolderChildren(parentId, {
        type: NodeType.File,
      })) {
        if (!result.ok) {
          debugLog("DriveClient: degraded node skipped in file list");
          continue;
        }
        const node = result.value;
        if (node.type !== NodeType.File) continue;
        files.push({
          id: node.uid,
          name: node.name,
          parent_id: parentId,
          remote_mtime: (
            node.activeRevision?.claimedModificationTime ?? node.modificationTime
          ).toISOString(),
          size: node.activeRevision?.claimedSize ?? node.totalStorageSize ?? 0,
        });
      }
      return files;
    } catch (err) {
      mapSdkError(err);
      throw err; // defensive
    }
  }

  /**
   * Upload a file to the given parent folder.
   *
   * Delegates to the SDK uploader chain
   * (`getFileUploader` → `uploadFromStream` → `controller.completion`) and
   * normalizes the camelCase SDK return value to snake_case at the wire
   * boundary (project-context.md "snake_case on Both Sides").
   *
   * `expectedSize` is forwarded to the SDK so it can verify integrity — a
   * mismatched stream length aborts the upload with `IntegrityError`.
   */
  async uploadFile(
    parentId: string,
    name: string,
    body: UploadBody,
  ): Promise<{ node_uid: string; revision_uid: string }> {
    try {
      const metadata: UploadMetadata = {
        mediaType: body.mediaType,
        expectedSize: body.sizeBytes,
        modificationTime: body.modificationTime,
      };
      const uploader = await this.sdk.getFileUploader(parentId, name, metadata);
      // Empty thumbnails array — Story 2.5+ may add thumbnail generation.
      const controller = await uploader.uploadFromStream(body.stream, []);
      const result = await controller.completion();
      return {
        node_uid: result.nodeUid,
        revision_uid: result.nodeRevisionUid,
      };
    } catch (err) {
      // Cancel the source stream defensively so the caller's file descriptor
      // (e.g. `fs.createReadStream` via `Readable.toWeb`) is released even
      // when the SDK aborts mid-stream. Best-effort: a stream that is already
      // closed/locked will reject the cancel — swallow that secondary error.
      try {
        await body.stream.cancel(err);
      } catch {
        /* secondary error: stream already closed/locked — ignore */
      }
      mapSdkError(err);
      throw err; // defensive — see listRemoteFolders catch
    }
  }

  /**
   * Upload a new revision of an existing file identified by nodeUid.
   *
   * Used when a file already exists remotely and has been modified locally.
   * Delegates to `getFileRevisionUploader` instead of `getFileUploader` so
   * the SDK creates a new revision on the existing node rather than a new node.
   */
  async uploadFileRevision(
    nodeUid: string,
    body: UploadBody,
  ): Promise<{ node_uid: string; revision_uid: string }> {
    try {
      const metadata: UploadMetadata = {
        mediaType: body.mediaType,
        expectedSize: body.sizeBytes,
        modificationTime: body.modificationTime,
      };
      const uploader = await this.sdk.getFileRevisionUploader(nodeUid, metadata);
      const controller = await uploader.uploadFromStream(body.stream, []);
      const result = await controller.completion();
      return {
        node_uid: result.nodeUid,
        revision_uid: result.nodeRevisionUid,
      };
    } catch (err) {
      try {
        await body.stream.cancel(err);
      } catch {
        /* secondary error: stream already closed/locked — ignore */
      }
      mapSdkError(err);
      throw err;
    }
  }

  /**
   * Move a single remote node to trash.
   *
   * Delegates to the SDK's `trashNodes` async-generator, which yields one
   * `NodeResult` per uid. We pass a single-element array and drain the
   * single yielded result. SDK iteration errors (network/auth) are
   * translated via `mapSdkError`; a yielded `{ok: false}` result means the
   * server rejected that specific node (rare — stale uid, permission) and
   * is surfaced as a `SyncError` so the per-entry replay catch-all counts
   * it in the `failed` tally.
   */
  async trashNode(nodeUid: string): Promise<void> {
    try {
      const iter = this.sdk.trashNodes([nodeUid]);
      let saw = false;
      for await (const result of iter) {
        saw = true;
        if (!result.ok) {
          throw new SyncError(`trashNode failed for ${nodeUid}: ${result.error}`);
        }
      }
      // Defensive: if the SDK iterator completes without yielding anything
      // for our uid (e.g. node already gone on the server, or a future SDK
      // change drops "already-trashed" uids silently), we cannot confirm the
      // trash actually happened. Treat as a failure so the caller keeps the
      // queue entry and doesn't drop the sync_state row prematurely.
      if (!saw) {
        throw new SyncError(`trashNode produced no result for ${nodeUid}`);
      }
    } catch (err) {
      mapSdkError(err);
    }
  }

  /**
   * Download a file by node UID into the provided writable stream.
   *
   * Uses the verified `downloadToStream` path. `unsafeDownloadToStream` is
   * debug-only per SDK docs and is never called.
   *
   * If the controller reports `isDownloadCompleteWithSignatureIssues()` after
   * completion, the download is considered successful (the bytes are written)
   * but the signature warning is recorded via `debugLog`. Story 2.5 will
   * decide on user-visible warnings.
   */
  async downloadFile(
    nodeUid: string,
    target: WritableStream<Uint8Array>,
  ): Promise<void> {
    try {
      const downloader = await this.sdk.getFileDownloader(nodeUid);
      // Per download.d.ts, `downloadToStream` returns a DownloadController
      // synchronously — do NOT `await` the call itself, only its `completion()`.
      const controller = downloader.downloadToStream(target);
      await controller.completion();
      if (controller.isDownloadCompleteWithSignatureIssues()) {
        debugLog(
          "DriveClient: download completed with signature verification warnings",
        );
      }
    } catch (err) {
      // Abort the target writable so a half-written file is not silently
      // persisted by the caller. Best-effort: a target that is already
      // closed/locked will reject the abort — swallow the secondary error.
      try {
        await target.abort(err);
      } catch {
        /* secondary error: target already closed/locked — ignore */
      }
      mapSdkError(err);
      throw err; // defensive — see listRemoteFolders catch
    }
  }

  /**
   * Derive the Proton keyPassword from a raw login password and unlock the
   * user's private keys.
   *
   * Flow (AC1 → AC2 → AC3):
   * 1. Fetch KeySalt from GET /core/v4/auth/info
   * 2. Derive keyPassword: bcrypt(password, "$2y$10$" + encode(decode64(KeySalt)))
   *    For SSO accounts (KeySalt === null), keyPassword = "" (no private keys)
   * 3. Fetch armored keys from GET /core/v4/keys/user and decrypt each
   *
   * Returns the derived keyPassword so the caller can persist it to the keyring.
   * Throws SyncError / NetworkError on failure.
   *
   * SECURITY: the raw password must not be stored, logged, or passed outside
   * this method scope after derivation is complete (project-context.md NFR6).
   */
  /**
   * Fetch the bcrypt salt for this session's account.
   * Requires "locked" scope — only callable on intermediate (pre-2FA) tokens.
   * Exposed so callers (e.g. main.ts) can cache the salt before the session
   * is upgraded and "locked" scope is lost.
   */
  async fetchKeySalt(): Promise<string | null> {
    if (!this.accountAdapter) {
      throw new SyncError(
        "account adapter not wired — use createDriveClient(token)",
      );
    }
    return this.accountAdapter.fetchKeySalt();
  }

  /**
   * Fetch per-key bcrypt salts from GET /core/v4/keys/salts.
   *
   * Requires a "locked-scope" token (immediately post-password, pre-2FA).
   * Call this as early as possible after receiving a new token so the salts
   * are cached before the scope is upgraded to "full" by 2FA.
   */
  async fetchKeySalts(): Promise<Array<{ ID: string; KeySalt: string | null }>> {
    if (!this.accountAdapter) {
      throw new SyncError("account adapter not wired — use createDriveClient(token)");
    }
    return this.accountAdapter.fetchKeySalts();
  }

  /**
   * Derive keyPassword(s) from login password using per-key bcrypt salts, then
   * decrypt keys. Each Proton user key has its own salt in GET /core/v4/keys/salts;
   * using a single salt for all keys produces wrong keyPasswords for accounts with
   * multiple keys or non-uniform salts.
   *
   * Returns the keyPassword for the primary user key — the caller stores this in
   * the OS keyring for silent unlock on next launch (via applyKeyPassword).
   */
  async deriveAndUnlock(
    password: string,
    _preloadedSalt?: string | null,
    preCapturedSalts?: Array<{ ID: string; KeySalt: string | null }>,
  ): Promise<string> {
    if (!this.accountAdapter) {
      throw new SyncError(
        "account adapter not wired — use createDriveClient(token)",
      );
    }
    return this.accountAdapter.fetchAndDecryptAllKeys(password, preCapturedSalts);
  }

  /**
   * Apply a pre-derived keyPassword (retrieved from the OS keyring on relaunch)
   * directly — skips salt fetch and bcrypt derivation.
   *
   * Throws SyncError if the keyPassword fails to decrypt the keys (password
   * changed, key rotation). The caller should emit `key_unlock_required` in
   * that case so the user can re-enter their password.
   */
  async applyKeyPassword(keyPassword: string): Promise<void> {
    if (!this.accountAdapter) {
      throw new SyncError(
        "account adapter not wired — use createDriveClient(token)",
      );
    }
    if (keyPassword === "") {
      // SSO account — no keys to decrypt
      return;
    }
    await this.accountAdapter.fetchAndDecryptKeys(keyPassword);
  }

  /**
   * Validate the current session by fetching the primary address from Proton.
   *
   * Returns an `AccountInfo` struct with the account's email (and stub fields
   * for storage/plan — these require additional API calls deferred to a
   * follow-up story).
   *
   * Path B note: if the account adapter has `keys: []` (no key decryption),
   * `getOwnPrimaryAddress()` may still work for address lookup (email) but
   * crypto operations will fail downstream. If this method throws, the engine
   * emits `token_expired` — see AC8 + AC12 smoke test guidance in the story
   * file for the silent-failure risk.
   */
  async validateSession(): Promise<AccountInfo> {
    if (!this.accountAdapter) {
      throw new SyncError(
        "account adapter not wired — use createDriveClient(token)",
      );
    }
    try {
      // /core/v4/users works with "locked" scope tokens (does not require "full" scope).
      // /core/v4/addresses requires "full" scope — only available after key unlock.
      const userInfo = await this.accountAdapter.getUser();
      return {
        display_name: userInfo.display_name,
        email: userInfo.email,
        storage_used: 0,
        storage_total: 0,
        plan: "",
      };
    } catch (err) {
      mapSdkError(err);
      throw err;
    }
  }
}

// ===========================================================================
// LIVE SDK WIRING — Story 2.2.5
// All private adapter classes and the createDriveClient factory live below.
// Nothing below this line is exported except createDriveClient (AccountInfo
// is exported above with the boundary types).
// ===========================================================================

// ---------------------------------------------------------------------------
// Uint8Array cast helper
//
// openpgp v6 binary operations return Uint8Array<ArrayBufferLike> internally.
// The drive-sdk OpenPGPCryptoProxy interface requires Uint8Array<ArrayBuffer>.
// This helper performs a safe conversion that copies the underlying buffer only
// when needed (i.e. when the buffer is a SharedArrayBuffer or a sub-view).
// ALL binary-format return paths in ProtonOpenPGPCryptoProxy MUST use this.
// Casts NEVER leak outside sdk.ts.
// ---------------------------------------------------------------------------
function toArrayBuffer(u: Uint8Array): Uint8Array<ArrayBuffer> {
  if (u.buffer instanceof ArrayBuffer) {
    // Fast path: already backed by a plain ArrayBuffer
    return u as unknown as Uint8Array<ArrayBuffer>;
  }
  // Slow path: copy to guarantee we own an ArrayBuffer (not SharedArrayBuffer)
  const copy = new Uint8Array(u.byteLength);
  copy.set(u);
  return copy;
}

// ---------------------------------------------------------------------------
// Helper: encode raw bytes to bcrypt's modified base64 salt format.
//
// Proton's computeKeyPassword (pm-srp/lib/keys.js):
//   full = bcrypt(password, "$2y$10$" + encodeBase64(rawSalt, 16))
//   keyPassword = full.slice(29)   ← strips prefix + salt, keeps 31-char hash
// where rawSalt = base64-decode(KeySalt from GET /core/v4/keys/salts).
//
// bcrypt's modified base64 alphabet differs from standard — same bit order
// (MSB first, 6 bits per char) but different alphabet. 16 raw bytes → 22 chars.
// ---------------------------------------------------------------------------
const BCRYPT_B64 =
  "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function encodeToBcryptBase64(buf: Buffer): string {
  let result = "";
  let c1: number, c2: number;
  let off = 0;

  while (off < buf.length) {
    c1 = buf[off++]! & 0xff;
    result += BCRYPT_B64[c1 >> 2]!;
    c1 = (c1 & 0x03) << 4;
    if (off >= buf.length) {
      result += BCRYPT_B64[c1]!;
      break;
    }
    c2 = buf[off++]! & 0xff;
    c1 |= c2 >> 4;
    result += BCRYPT_B64[c1]!;
    c1 = (c2 & 0x0f) << 2;
    if (off >= buf.length) {
      result += BCRYPT_B64[c1]!;
      break;
    }
    c2 = buf[off++]! & 0xff;
    c1 |= c2 >> 6;
    result += BCRYPT_B64[c1]!;
    result += BCRYPT_B64[c2 & 0x3f]!;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helper: map openpgp VerificationResult[] to VERIFICATION_STATUS
// ---------------------------------------------------------------------------
async function resolveVerificationStatus(
  signatures: Array<{ verified: Promise<true> }>,
): Promise<VERIFICATION_STATUS> {
  if (signatures.length === 0) return VERIFICATION_STATUS.NOT_SIGNED;
  const results = await Promise.allSettled(signatures.map((s) => s.verified));
  const anyInvalid = results.some((r) => r.status === "rejected");
  return anyInvalid
    ? VERIFICATION_STATUS.SIGNED_AND_INVALID
    : VERIFICATION_STATUS.SIGNED_AND_VALID;
}

// ---------------------------------------------------------------------------
// ProtonHTTPClient — implements ProtonDriveHTTPClient using Node 22 fetch
//
// Injects the Bearer token on every request.
// Token is NEVER logged, NEVER interpolated into error messages, NEVER written
// to disk (project-context.md NFR6 / "Token must never appear in output").
// Private to sdk.ts — NOT exported.
// ---------------------------------------------------------------------------
class ProtonHTTPClient implements ProtonDriveHTTPClient {
  constructor(private readonly token: string, private readonly uid?: string) {}

  async fetchJson(request: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    if (this.uid) headers.set("x-pm-uid", this.uid);
    if (!headers.has("x-pm-appversion")) headers.set("x-pm-appversion", "web-drive@5.0.0.0");
    if (!headers.has("Accept")) headers.set("Accept", "application/vnd.protonmail.v1+json");

    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
      : AbortSignal.timeout(request.timeoutMs);

    const body =
      request.json !== undefined
        ? JSON.stringify(request.json)
        : request.body;

    return fetch(request.url, {
      method: request.method,
      headers,
      signal,
      body,
    });
  }

  async fetchBlob(request: ProtonDriveHTTPClientBlobRequest): Promise<Response> {
    const headers = new Headers(request.headers);

    // Storage servers (e.g. fra-storage.proton.me) use pm-storage-token for auth,
    // not Bearer. They also do not speak the Proton JSON API, so injecting
    // Authorization/Accept/x-pm-* headers causes them to reject the request with
    // "JSON parsing of request body failed" (APICodeError 6001).
    // Only add Proton API headers for requests to the main API host.
    const isProtonApi = request.url.includes("protonmail.com") || request.url.includes("proton.me/core") || request.url.includes("proton.me/drive");
    if (isProtonApi) {
      headers.set("Authorization", `Bearer ${this.token}`);
      if (this.uid) headers.set("x-pm-uid", this.uid);
      if (!headers.has("x-pm-appversion")) headers.set("x-pm-appversion", "web-drive@5.0.0.0");
      if (!headers.has("Accept")) headers.set("Accept", "application/vnd.protonmail.v1+json");
    }

    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
      : AbortSignal.timeout(request.timeoutMs);

    // For storage block uploads the body is FormData. Undici's fetch may not
    // auto-inject Content-Type when an explicit Headers object is provided.
    // Serialize the FormData through a temporary Response to get both the
    // multipart boundary and the raw buffer, then send with explicit
    // Content-Type so the storage server sees a proper multipart/form-data body.
    let body: BodyInit | null | undefined = request.body;
    if (!isProtonApi && request.body instanceof FormData) {
      const tempResp = new Response(request.body as FormData);
      const contentType = tempResp.headers.get("content-type");
      const buffer = await tempResp.arrayBuffer();
      if (contentType) headers.set("Content-Type", contentType);
      body = buffer;
      process.stderr.write(`[FETCH-BLOB] storage upload: ct=${contentType} size=${buffer.byteLength}\n`);
    }

    return fetch(request.url, {
      method: request.method,
      headers,
      signal,
      body,
    });
  }
}

// ---------------------------------------------------------------------------
// ProtonOpenPGPCryptoProxy — implements OpenPGPCryptoProxy via openpgp v6
//
// Key method corrections (from party-mode review 2026-04-10):
//   C1: generateKey uses format:'object', returns result.privateKey directly
//   C2: exportPrivateKey uses encryptKey()+armor(), not non-existent serializeKey()
//   C4: signMessage+decryptMessage binary paths wrap with toArrayBuffer()
//
// All Uint8Array<ArrayBufferLike> ↔ Uint8Array<ArrayBuffer> casts use
// toArrayBuffer(). These casts never leak outside sdk.ts.
//
// Private to sdk.ts — NOT exported.
// ---------------------------------------------------------------------------
// Does NOT declare `implements OpenPGPCryptoProxy` because the interface uses
// generic conditional return types (e.g. `Detached extends true ? ... : ...`)
// that TypeScript's structural checker cannot verify against a concrete
// implementation that branches at runtime. The class is cast to
// `OpenPGPCryptoProxy` at its single call site in `createDriveClient`.
class ProtonOpenPGPCryptoProxy {
  // C1 fix: use format:'object' and return privateKey directly (NOT { privateKey: ... })
  async generateKey(options: Parameters<OpenPGPCryptoProxy["generateKey"]>[0]): Promise<SDKPrivateKey> {
    const result = await openpgp.generateKey({
      type: "ecc",
      curve: "ed25519Legacy",
      userIDs: options.userIDs,
      format: "object",
      config: options.config ? { aeadProtect: options.config.aeadProtect } : undefined,
    });
    return result.privateKey as unknown as SDKPrivateKey;
  }

  // C2 fix: openpgp.serializeKey() does not exist in v6
  async exportPrivateKey(options: Parameters<OpenPGPCryptoProxy["exportPrivateKey"]>[0]): Promise<string> {
    if (options.passphrase !== null) {
      const encrypted = await openpgp.encryptKey({
        privateKey: options.privateKey as unknown as openpgp.PrivateKey,
        passphrase: options.passphrase,
      });
      return encrypted.armor();
    }
    return (options.privateKey as unknown as openpgp.PrivateKey).armor();
  }

  async importPrivateKey(options: Parameters<OpenPGPCryptoProxy["importPrivateKey"]>[0]): Promise<SDKPrivateKey> {
    const privateKey = await openpgp.readPrivateKey({ armoredKey: options.armoredKey });
    const decrypted = await openpgp.decryptKey({
      privateKey,
      passphrase: options.passphrase ?? undefined,
    });
    return decrypted as unknown as SDKPrivateKey;
  }

  async generateSessionKey(options: Parameters<OpenPGPCryptoProxy["generateSessionKey"]>[0]): ReturnType<OpenPGPCryptoProxy["generateSessionKey"]> {
    const result = await openpgp.generateSessionKey({
      encryptionKeys: options.recipientKeys as unknown as openpgp.PublicKey[],
    });
    return {
      data: toArrayBuffer(result.data),
      algorithm: result.algorithm as string,
      aeadAlgorithm: (result.aeadAlgorithm as string | undefined) ?? null,
    };
  }

  async encryptSessionKey(options: Parameters<OpenPGPCryptoProxy["encryptSessionKey"]>[0]): Promise<Uint8Array<ArrayBuffer>> {
    const result = await openpgp.encryptSessionKey({
      data: options.data as unknown as Uint8Array,
      algorithm: options.algorithm as unknown as openpgp.enums.symmetricNames,
      encryptionKeys: options.encryptionKeys as unknown as openpgp.PublicKey | openpgp.PublicKey[],
      passwords: options.passwords,
      format: "binary",
    });
    return toArrayBuffer(result as Uint8Array);
  }

  async decryptSessionKey(options: Parameters<OpenPGPCryptoProxy["decryptSessionKey"]>[0]): ReturnType<OpenPGPCryptoProxy["decryptSessionKey"]> {
    const message = options.binaryMessage
      ? await openpgp.readMessage({ binaryMessage: options.binaryMessage as unknown as Uint8Array })
      : await openpgp.readMessage({ armoredMessage: options.armoredMessage! });

    const keys = await openpgp.decryptSessionKeys({
      message,
      decryptionKeys: options.decryptionKeys as unknown as openpgp.PrivateKey | openpgp.PrivateKey[],
    });

    if (!keys[0]) return undefined;
    return {
      data: toArrayBuffer(keys[0].data),
      algorithm: keys[0].algorithm as string | null,
      aeadAlgorithm: null,
    };
  }

  /**
   * Strip config keys that openpgp 6.3.0 doesn't know.
   * The SDK was written against a newer openpgp that added `ignoreSEIPDv2FeatureFlag`
   * (controls AEAD/SEIPD-v2 key preference). openpgp 6.3.0 rejects unknown keys;
   * removing it is safe because 6.3.0 already defaults to SEIPD-v1 behaviour.
   */
  private _sanitizeOpenpgpConfig(cfg: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!cfg) return cfg;
    const { ignoreSEIPDv2FeatureFlag: _drop, ...rest } = cfg;
    return Object.keys(rest).length ? rest : undefined;
  }

  async encryptMessage(options: Parameters<OpenPGPCryptoProxy["encryptMessage"]>[0]) {
    const fmt = options.format ?? "armored";
    const cfg = this._sanitizeOpenpgpConfig(options.config as Record<string, unknown> | undefined);

    if (options.detached) {
      // Detached: sign the plaintext separately, then encrypt
      const [plainMsg, encMsg] = await Promise.all([
        openpgp.createMessage({ binary: options.binaryData as unknown as Uint8Array }),
        openpgp.createMessage({ binary: options.binaryData as unknown as Uint8Array }),
      ]);

      if (fmt === "binary") {
        const [sigResult, encResult] = await Promise.all([
          openpgp.sign({
            message: plainMsg,
            signingKeys: options.signingKeys as unknown as openpgp.PrivateKey,
            detached: true,
            format: "binary",
          }),
          openpgp.encrypt({
            message: encMsg,
            encryptionKeys: options.encryptionKeys as unknown as openpgp.PublicKey[],
            sessionKey: options.sessionKey as unknown as openpgp.SessionKey,
            format: "binary",
            config: cfg,
          }),
        ]);
        return {
          message: toArrayBuffer(encResult as unknown as Uint8Array),
          signature: toArrayBuffer(sigResult as unknown as Uint8Array),
        };
      }

      // armored detached
      const [sigResult, encResult] = await Promise.all([
        openpgp.sign({
          message: plainMsg,
          signingKeys: options.signingKeys as unknown as openpgp.PrivateKey,
          detached: true,
          format: "armored",
        }),
        openpgp.encrypt({
          message: encMsg,
          encryptionKeys: options.encryptionKeys as unknown as openpgp.PublicKey[],
          sessionKey: options.sessionKey as unknown as openpgp.SessionKey,
          format: "armored",
          config: cfg,
        }),
      ]);
      return {
        message: encResult as string,
        signature: sigResult as string,
      };
    }

    // Non-detached: inline signing
    const msg = await openpgp.createMessage({ binary: options.binaryData as unknown as Uint8Array });

    if (fmt === "binary") {
      const encResult = await openpgp.encrypt({
        message: msg,
        encryptionKeys: options.encryptionKeys as unknown as openpgp.PublicKey[],
        signingKeys: options.signingKeys as unknown as openpgp.PrivateKey | undefined,
        sessionKey: options.sessionKey as unknown as openpgp.SessionKey,
        format: "binary",
        config: cfg,
      });
      return {
        message: toArrayBuffer(encResult as unknown as Uint8Array),
      };
    }

    const encResult = await openpgp.encrypt({
      message: msg,
      encryptionKeys: options.encryptionKeys as unknown as openpgp.PublicKey[],
      signingKeys: options.signingKeys as unknown as openpgp.PrivateKey | undefined,
      sessionKey: options.sessionKey as unknown as openpgp.SessionKey,
      format: "armored",
      config: cfg,
    });
    return {
      message: encResult as string,
    };
  }

  async decryptMessage(options: Parameters<OpenPGPCryptoProxy["decryptMessage"]>[0]) {
    const message = options.binaryMessage
      ? await openpgp.readMessage({ binaryMessage: options.binaryMessage as unknown as Uint8Array })
      : await openpgp.readMessage({ armoredMessage: options.armoredMessage! });

    let detachedSig: openpgp.Signature | undefined;
    if (options.binarySignature) {
      detachedSig = await openpgp.readSignature({
        binarySignature: options.binarySignature as unknown as Uint8Array,
      });
    } else if (options.armoredSignature) {
      detachedSig = await openpgp.readSignature({ armoredSignature: options.armoredSignature });
    }

    if (options.format === "binary") {
      const result = await openpgp.decrypt({
        message,
        sessionKeys: options.sessionKeys as unknown as openpgp.SessionKey,
        decryptionKeys: options.decryptionKeys as unknown as openpgp.PrivateKey | openpgp.PrivateKey[],
        verificationKeys: options.verificationKeys as unknown as openpgp.PublicKey | openpgp.PublicKey[],
        passwords: options.passwords,
        format: "binary",
        signature: detachedSig,
      });
      const verificationStatus = await resolveVerificationStatus(result.signatures);
      const settled = await Promise.allSettled(result.signatures.map((s) => s.verified));
      const verificationErrors = settled
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason as Error);
      return {
        data: toArrayBuffer(result.data as unknown as Uint8Array),
        verificationStatus,
        verificationErrors: verificationErrors.length > 0 ? verificationErrors : undefined,
      };
    }

    const result = await openpgp.decrypt({
      message,
      sessionKeys: options.sessionKeys as unknown as openpgp.SessionKey,
      decryptionKeys: options.decryptionKeys as unknown as openpgp.PrivateKey | openpgp.PrivateKey[],
      verificationKeys: options.verificationKeys as unknown as openpgp.PublicKey | openpgp.PublicKey[],
      passwords: options.passwords,
      format: "utf8",
      signature: detachedSig,
    });
    const verificationStatus = await resolveVerificationStatus(result.signatures);
    const settled = await Promise.allSettled(result.signatures.map((s) => s.verified));
    const verificationErrors = settled
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason as Error);
    return {
      data: result.data as string,
      verificationStatus,
      verificationErrors: verificationErrors.length > 0 ? verificationErrors : undefined,
    };
  }

  // C4 fix: binary format must wrap result with toArrayBuffer()
  async signMessage(options: Parameters<OpenPGPCryptoProxy["signMessage"]>[0]) {
    const msg = await openpgp.createMessage({ binary: options.binaryData as unknown as Uint8Array });

    if (options.format === "binary") {
      const result = await openpgp.sign({
        message: msg,
        signingKeys: options.signingKeys as unknown as openpgp.PrivateKey | openpgp.PrivateKey[],
        detached: options.detached,
        format: "binary",
      });
      return toArrayBuffer(result as unknown as Uint8Array);
    }

    const result = await openpgp.sign({
      message: msg,
      signingKeys: options.signingKeys as unknown as openpgp.PrivateKey | openpgp.PrivateKey[],
      detached: options.detached,
      format: "armored",
    });
    return result;
  }

  async verifyMessage(
    options: Parameters<OpenPGPCryptoProxy["verifyMessage"]>[0],
  ): ReturnType<OpenPGPCryptoProxy["verifyMessage"]> {
    const msg = await openpgp.createMessage({ binary: options.binaryData as unknown as Uint8Array });

    const sig = options.binarySignature
      ? await openpgp.readSignature({ binarySignature: options.binarySignature as unknown as Uint8Array })
      : await openpgp.readSignature({ armoredSignature: options.armoredSignature! });

    const result = await openpgp.verify({
      message: msg,
      verificationKeys: options.verificationKeys as unknown as openpgp.PublicKey | openpgp.PublicKey[],
      signature: sig,
      format: "binary",
    });

    const verificationStatus = await resolveVerificationStatus(result.signatures);
    const settled = await Promise.allSettled(result.signatures.map((s) => s.verified));
    const errors = settled
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason as Error);

    return {
      verificationStatus,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// SRP STUB
//
// getSrp/getSrpVerifier/computeKeyPassword are only invoked for
// password-protected public links (not for token-authenticated folder listing).
// All three throw until a public-links story adds proper SRP.
// See engine/node_modules/@protontech/drive-sdk/dist/crypto/driveCrypto.js:169,186
// and sharingPublic/session/session.js:35 for the three call sites.
// ---------------------------------------------------------------------------
const srpStub: SRPModule = {
  getSrp: async () => {
    throw new SyncError("SRP public-link auth not available in MVP");
  },
  getSrpVerifier: async () => {
    throw new SyncError("SRP public-link creation not available in MVP");
  },
  computeKeyPassword: async () => {
    throw new SyncError("SRP key derivation not available in MVP");
  },
};

// ---------------------------------------------------------------------------
// ProtonAccountAdapter — Path B implementation
//
// Auth callback investigation (Task 1, 2026-04-10): token is a plain Bearer
// string (Case A). Key password is NOT available in the current auth flow.
// Therefore addresses are returned with keys: [] (no private key decryption).
// Consequence: listRemoteFolders will return [] for encrypted nodes (all nodes
// degrade due to missing private keys). A follow-up story or arch correction
// is required to source the key password.
//
// getPublicKeys IS fully implemented — public keys do not require decryption.
// Private to sdk.ts — NOT exported.
// ---------------------------------------------------------------------------
class ProtonAccountAdapter implements ProtonDriveAccount {
  // Decrypted user private keys — populated by fetchAndDecryptKeys().
  // Empty until deriveAndUnlock / applyKeyPassword succeeds.
  private _decryptedKeys: { id: string; key: openpgp.PrivateKey }[] = [];

  constructor(private readonly httpClient: ProtonHTTPClient) {}

  // /core/v4/users — requires "settings" scope (full auth).
  // Falls back to /core/v4/addresses (accessible with "user"/"locked" scope)
  // so validateSession succeeds even when the token lacks settings scope (e.g.
  // when 2FA was not completed in-browser before the cookie was captured).
  async getUser(): Promise<{ email: string; display_name: string }> {
    const response = await this.httpClient.fetchJson({
      url: "https://drive-api.proton.me/core/v4/users",
      method: "GET",
      headers: new Headers(),
      timeoutMs: 10_000,
    });
    if (response.ok) {
      const json = (await response.json()) as {
        User?: { Email?: string; Name?: string; DisplayName?: string };
      };
      const email = json.User?.Email ?? "";
      const display_name = json.User?.DisplayName ?? json.User?.Name ?? email;
      return { email, display_name };
    }

    // On 403 (missing "settings" scope) fall back to /core/v4/addresses which
    // is accessible with "user"/"locked" scope tokens.
    let body = "";
    try { body = await response.text(); } catch { /* ignore */ }
    process.stderr.write(
      `[ENGINE] Users API ${response.status}: ${body.slice(0, 200)} — falling back to /addresses\n`,
    );

    const addrResp = await this.httpClient.fetchJson({
      url: "https://drive-api.proton.me/core/v4/addresses",
      method: "GET",
      headers: new Headers(),
      timeoutMs: 10_000,
    });
    if (!addrResp.ok) {
      let addrBody = "";
      try { addrBody = await addrResp.text(); } catch { /* ignore */ }
      process.stderr.write(`[ENGINE] Addresses API ${addrResp.status}: ${addrBody.slice(0, 200)}\n`);
      throw new NetworkError(`Addresses API error: ${addrResp.status}`);
    }
    const addrJson = (await addrResp.json()) as {
      Addresses?: Array<{ Email: string; Order: number }>;
    };
    const addresses = (addrJson.Addresses ?? []).slice().sort((a, b) => a.Order - b.Order);
    const email = addresses[0]?.Email ?? "";
    return { email, display_name: email };
  }

  async getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
    const addresses = await this.getOwnAddresses();
    const primary = addresses[0];
    if (!primary) {
      throw new SyncError("No primary Proton address found");
    }
    return primary;
  }

  async getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
    const response = await this.httpClient.fetchJson({
      url: "https://drive-api.proton.me/core/v4/addresses",
      method: "GET",
      headers: new Headers(),
      timeoutMs: 10_000,
    });
    if (!response.ok) {
      let body = "";
      try { body = await response.text(); } catch { /* ignore */ }
      process.stderr.write(`[ENGINE] Addresses API ${response.status}: ${body.slice(0, 300)}\n`);
      throw new NetworkError(`Addresses API error: ${response.status}`);
    }
    const json = (await response.json()) as {
      Addresses?: Array<{ ID: string; Email: string; Order: number }>;
    };
    const addresses = json.Addresses ?? [];
    // Sort by Order ascending — lower Order = higher priority (primary first)
    addresses.sort((a, b) => a.Order - b.Order);
    // Decrypted user keys injected after deriveAndUnlock / applyKeyPassword.
    // Returns [] until key unlock completes — share decryption fails until then.
    return addresses.map((addr) => ({
      email: addr.Email,
      addressId: addr.ID,
      primaryKeyIndex: 0,
      keys: this._decryptedKeys as unknown as { id: string; key: SDKPrivateKey }[],
    }));
  }

  async getOwnAddress(emailOrAddressId: string): Promise<ProtonDriveAccountAddress> {
    const addresses = await this.getOwnAddresses();
    const found = addresses.find(
      (a) => a.email === emailOrAddressId || a.addressId === emailOrAddressId,
    );
    if (!found) {
      throw new SyncError(`Address not found: ${emailOrAddressId}`);
    }
    return found;
  }

  async getPublicKeys(email: string): Promise<SDKPublicKey[]> {
    const response = await this.httpClient.fetchJson({
      url: `https://drive-api.proton.me/core/v4/keys?Email=${encodeURIComponent(email)}`,
      method: "GET",
      headers: new Headers(),
      timeoutMs: 10_000,
    });
    if (!response.ok) {
      throw new NetworkError(`Public keys API error: ${response.status}`);
    }
    const json = (await response.json()) as { Keys?: Array<{ PublicKey: string }> };
    const results = await Promise.allSettled(
      (json.Keys ?? []).map((k) => openpgp.readKey({ armoredKey: k.PublicKey })),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<openpgp.Key> => r.status === "fulfilled")
      .map((r) => r.value as unknown as SDKPublicKey);
  }

  async hasProtonAccount(email: string): Promise<boolean> {
    return (await this.getPublicKeys(email)).length > 0;
  }

  // ---------------------------------------------------------------------------
  // Key derivation (Story 2.11)
  // ---------------------------------------------------------------------------

  /**
   * Fetch the bcrypt salt for the current account from GET /core/v4/auth/info.
   *
   * Returns `null` for SSO-only accounts (KeySalt field is absent or null).
   * Throws NetworkError on any API failure.
   */
  async fetchKeySalt(): Promise<string | null> {
    // Authenticated endpoint — returns per-key salts for the current user.
    // POST /core/v4/auth/info is pre-auth only (SRP modulus); after login use
    // GET /core/v4/keys/salts instead.
    const response = await this.httpClient.fetchJson({
      url: "https://drive-api.proton.me/core/v4/keys/salts",
      method: "GET",
      headers: new Headers(),
      timeoutMs: 10_000,
    });
    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        /* ignore */
      }
      process.stderr.write(
        `[ENGINE] keys/salts API ${response.status}: ${body.slice(0, 200)}\n`,
      );
      throw new NetworkError(`keys/salts API error: ${response.status}`);
    }
    const json = (await response.json()) as {
      KeySalts?: Array<{ ID: string; KeySalt: string | null }>;
    };
    // Return the first non-null salt — all user keys share the same derived keyPassword.
    // SSO-only accounts have no salt; return null so caller skips bcrypt derivation.
    for (const entry of json.KeySalts ?? []) {
      if (entry.KeySalt) {
        return entry.KeySalt;
      }
    }
    return null;
  }

  /**
   * Fetch and decrypt private keys, storing them in _decryptedKeys.
   *
   * Primary path: GET /core/v4/users (User.Keys[]) — requires "settings" scope.
   * Fallback path: GET /core/v4/addresses (Address[].Keys[]) — accessible with
   * "user"/"locked" scope. Address keys where Token===null are v2 keys encrypted
   * directly with keyPassword and can be decrypted without user private keys.
   *
   * After this call getOwnAddresses() returns addresses with populated keys[].
   * Throws SyncError if all keys fail to decrypt (wrong keyPassword or empty
   * key list after attempting both paths).
   */
  async fetchAndDecryptKeys(keyPassword: string): Promise<void> {
    type ArmoredKey = { ID: string; PrivateKey: string };

    // --- Primary path: user keys from /core/v4/users ---
    const usersResp = await this.httpClient.fetchJson({
      url: "https://drive-api.proton.me/core/v4/users",
      method: "GET",
      headers: new Headers(),
      timeoutMs: 10_000,
    });

    if (usersResp.ok) {
      const json = (await usersResp.json()) as {
        User?: { Keys?: Array<{ ID: string; PrivateKey: string; Primary?: number }> };
      };
      const armoredKeys: ArmoredKey[] = json.User?.Keys ?? [];
      await this._decryptArmoredKeys(armoredKeys, keyPassword, "user keys");
      return;
    }

    // --- Fallback path: address keys from /core/v4/addresses ---
    let usersBody = "";
    try { usersBody = await usersResp.text(); } catch { /* ignore */ }
    process.stderr.write(
      `[ENGINE] users API (keys) ${usersResp.status}: ${usersBody.slice(0, 200)} — falling back to address keys\n`,
    );

    const addrResp = await this.httpClient.fetchJson({
      url: "https://drive-api.proton.me/core/v4/addresses",
      method: "GET",
      headers: new Headers(),
      timeoutMs: 10_000,
    });
    if (!addrResp.ok) {
      let addrBody = "";
      try { addrBody = await addrResp.text(); } catch { /* ignore */ }
      process.stderr.write(`[ENGINE] Addresses API (keys) ${addrResp.status}: ${addrBody.slice(0, 200)}\n`);
      throw new NetworkError(`Addresses API error: ${addrResp.status}`);
    }
    const addrJson = (await addrResp.json()) as {
      Addresses?: Array<{
        Keys?: Array<{ ID: string; PrivateKey: string; Token: string | null }>;
      }>;
    };
    // Collect v2 address keys (Token===null → encrypted directly with keyPassword).
    // v3 keys (Token present) require the user private key to unwrap — skip them
    // when we lack settings scope to fetch user keys.
    const v2Keys: ArmoredKey[] = [];
    for (const addr of addrJson.Addresses ?? []) {
      for (const k of addr.Keys ?? []) {
        if (k.Token === null) {
          v2Keys.push({ ID: k.ID, PrivateKey: k.PrivateKey });
        }
      }
    }
    process.stderr.write(`[ENGINE] address key fallback: found ${v2Keys.length} v2 key(s)\n`);
    await this._decryptArmoredKeys(v2Keys, keyPassword, "address keys");
  }

  /** Decrypt an array of armored keys with keyPassword and store results. */
  private async _decryptArmoredKeys(
    armoredKeys: Array<{ ID: string; PrivateKey: string }>,
    keyPassword: string,
    label: string,
  ): Promise<void> {
    const results = await Promise.allSettled(
      armoredKeys.map(async (k) => {
        const privateKey = await openpgp.readPrivateKey({ armoredKey: k.PrivateKey });
        return openpgp.decryptKey({ privateKey, passphrase: keyPassword });
      }),
    );

    // Log failures so we can distinguish wrong-passphrase from format errors.
    for (const r of results) {
      if (r.status === "rejected") {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        process.stderr.write(`[ENGINE] key decrypt failure (${label}): ${msg}\n`);
      }
    }

    const decrypted = results
      .filter(
        (r): r is PromiseFulfilledResult<openpgp.PrivateKey> =>
          r.status === "fulfilled",
      )
      .map((r) => ({ id: r.value.getFingerprint(), key: r.value }));

    if (decrypted.length === 0 && armoredKeys.length > 0) {
      throw new SyncError(
        `Key decryption failed (${label}) — incorrect keyPassword or unsupported key format`,
      );
    }
    process.stderr.write(`[ENGINE] decrypted ${decrypted.length}/${armoredKeys.length} ${label}\n`);

    this._decryptedKeys = decrypted;
  }

  /**
   * Fetch per-key bcrypt salts from GET /core/v4/keys/salts and return them
   * as a plain array.  Requires a locked-scope token.
   */
  async fetchKeySalts(): Promise<Array<{ ID: string; KeySalt: string | null }>> {
    const resp = await this.httpClient.fetchJson({
      url: "https://drive-api.proton.me/core/v4/keys/salts",
      method: "GET",
      headers: new Headers(),
      timeoutMs: 10_000,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`keys/salts ${resp.status}: ${body.slice(0, 100)}`);
    }
    const json = (await resp.json()) as { KeySalts?: Array<{ ID: string; KeySalt: string | null }> };
    return json.KeySalts ?? [];
  }

  /**
   * Per-key derivation: fetch the salt map from GET /core/v4/keys/salts, fetch
   * user keys from GET /core/v4/users (or /addresses fallback), derive a separate
   * keyPassword for each key using its specific salt, and decrypt.
   *
   * Returns the keyPassword for the PRIMARY user key (Primary===1, or first
   * successful) so the caller can store it in the OS keyring for silent relaunch.
   *
   * This is the correct implementation of Proton's key derivation: each user key
   * has its own bcrypt salt. Using a single global salt for all keys fails for
   * accounts where keys were created at different times or have been rotated.
   */
  async fetchAndDecryptAllKeys(
    loginPassword: string,
    preCapturedSalts?: Array<{ ID: string; KeySalt: string | null }>,
  ): Promise<string> {
    // ── Step 1: build salt map ──────────────────────────────────────────────
    const saltMap = new Map<string, string | null>();

    if (preCapturedSalts !== undefined && preCapturedSalts.length > 0) {
      // Use salts captured from the browser during auth (bypasses locked-scope
      // restriction on GET /core/v4/keys/salts).
      for (const s of preCapturedSalts) {
        saltMap.set(s.ID, s.KeySalt);
      }
      process.stderr.write(`[ENGINE] fetchAndDecryptAllKeys: ${saltMap.size} salt(s) from browser capture\n`);
    } else {
      const saltsResp = await this.httpClient.fetchJson({
        url: "https://drive-api.proton.me/core/v4/keys/salts",
        method: "GET",
        headers: new Headers(),
        timeoutMs: 10_000,
      });
      if (saltsResp.ok) {
        const saltsJson = (await saltsResp.json()) as {
          KeySalts?: Array<{ ID: string; KeySalt: string | null }>;
        };
        for (const s of saltsJson.KeySalts ?? []) {
          saltMap.set(s.ID, s.KeySalt);
        }
        process.stderr.write(`[ENGINE] fetchAndDecryptAllKeys: ${saltMap.size} salt(s) from API\n`);
      } else {
        let body = "";
        try { body = await saltsResp.text(); } catch { /* ignore */ }
        process.stderr.write(`[ENGINE] keys/salts ${saltsResp.status}: ${body.slice(0, 200)}\n`);
        // Fallback: /core/v4/keys/salts requires "locked" scope which post-auth
        // browser tokens don't have. Try /core/v4/auth/info for the session-level
        // KeySalt instead and apply it to all keys.
        const infoResp = await this.httpClient.fetchJson({
          url: "https://drive-api.proton.me/core/v4/auth/info",
          method: "GET",
          headers: new Headers(),
          timeoutMs: 10_000,
        });
        if (infoResp.ok) {
          const infoJson = (await infoResp.json()) as { KeySalt?: string | null };
          const sessionKeySalt = infoJson.KeySalt ?? null;
          process.stderr.write(`[ENGINE] auth/info fallback: KeySalt=${sessionKeySalt ? `"${sessionKeySalt.slice(0, 8)}..."` : "null"}\n`);
          // Store under sentinel key "_session_" — applied to any key missing from map
          if (sessionKeySalt !== undefined) {
            saltMap.set("_session_", sessionKeySalt);
          }
        } else {
          let body2 = "";
          try { body2 = await infoResp.text(); } catch { /* ignore */ }
          process.stderr.write(`[ENGINE] auth/info ${infoResp.status}: ${body2.slice(0, 200)}\n`);
        }
      }
    }

    // ── Step 2: fetch user keys (primary path) ──────────────────────────────
    type RawKey = { ID: string; PrivateKey: string; Primary?: number };
    let rawKeys: RawKey[] = [];
    let usedPath = "users";
    const usersResp = await this.httpClient.fetchJson({
      url: "https://drive-api.proton.me/core/v4/users",
      method: "GET",
      headers: new Headers(),
      timeoutMs: 10_000,
    });
    if (usersResp.ok) {
      const json = (await usersResp.json()) as {
        User?: { Keys?: Array<{ ID: string; PrivateKey: string; Primary?: number }> };
      };
      rawKeys = json.User?.Keys ?? [];
    } else {
      // Fallback to address keys (v2 only — Token===null).
      let body = "";
      try { body = await usersResp.text(); } catch { /* ignore */ }
      process.stderr.write(
        `[ENGINE] users API (all-keys) ${usersResp.status}: ${body.slice(0, 200)} — falling back to address keys\n`,
      );
      usedPath = "addresses";
      const addrResp = await this.httpClient.fetchJson({
        url: "https://drive-api.proton.me/core/v4/addresses",
        method: "GET",
        headers: new Headers(),
        timeoutMs: 10_000,
      });
      if (addrResp.ok) {
        const addrJson = (await addrResp.json()) as {
          Addresses?: Array<{
            Keys?: Array<{ ID: string; PrivateKey: string; Token: string | null }>;
          }>;
        };
        for (const addr of addrJson.Addresses ?? []) {
          for (const k of addr.Keys ?? []) {
            if (k.Token === null) rawKeys.push({ ID: k.ID, PrivateKey: k.PrivateKey });
          }
        }
      } else {
        let ab = ""; try { ab = await addrResp.text(); } catch { /* ignore */ }
        throw new NetworkError(`Addresses API error: ${addrResp.status} — ${ab.slice(0, 100)}`);
      }
    }
    process.stderr.write(`[ENGINE] fetchAndDecryptAllKeys: ${rawKeys.length} key(s) from ${usedPath}\n`);

    // ── Step 3: per-key bcrypt derivation + decryption ──────────────────────
    const decrypted: Array<{ id: string; key: openpgp.PrivateKey }> = [];
    let primaryKeyPassword = "";

    process.stderr.write(`[ENGINE] saltMap IDs (last 8): ${[...saltMap.keys()].map(id => id.slice(-8)).join(", ")}\n`);

    for (const k of rawKeys) {
      // Prefer per-key salt; fall back to session-level salt from auth/info fallback
      let keySalt = saltMap.has(k.ID) ? saltMap.get(k.ID)! : undefined;
      // "_session_" = API auth/info fallback; "__auth__" = browser-captured from POST /auth/v4
      if (keySalt === undefined && (saltMap.has("_session_") || saltMap.has("__auth__"))) {
        keySalt = saltMap.get("_session_") ?? saltMap.get("__auth__")!;
        process.stderr.write(`[ENGINE] key ${k.ID.slice(-8)}: using fallback session KeySalt\n`);
      } else {
        process.stderr.write(`[ENGINE] key ${k.ID.slice(-8)}: saltFound=${keySalt !== undefined} saltNull=${keySalt === null}\n`);
      }

      let keyPassword: string;
      if (keySalt === null) {
        // SSO / no-key account — key is not encrypted.
        keyPassword = "";
      } else if (keySalt === undefined) {
        // Salt not in map — try loginPassword directly as last resort.
        keyPassword = loginPassword;
      } else {
        const rawSalt = Buffer.from(keySalt, "base64");
        const bcryptSaltSuffix = encodeToBcryptBase64(rawSalt);
        // Proton's computeKeyPassword: bcrypt(password, "$2y$10$" + encode(rawSalt))
        // then strip the first 29 chars (prefix + salt) — only the 31-char hash
        // suffix is used as the actual passphrase. See pm-srp/lib/keys.js.
        const bcryptSaltStr = `$2y$10$${bcryptSaltSuffix}`;
        keyPassword = (await bcrypt.hash(loginPassword, bcryptSaltStr)).slice(29);
      }

      try {
        // Log first line of armored key to verify it's a valid PGP private key block
        const firstLine = k.PrivateKey.split("\n")[0] ?? "";
        process.stderr.write(`[ENGINE] key ${k.ID.slice(-8)}: armoredFirstLine="${firstLine}"\n`);
        const privateKey = await openpgp.readPrivateKey({ armoredKey: k.PrivateKey });
        // Log key version and S2K info
        const kp = privateKey.keyPacket as unknown as {
          s2k?: { type?: string; algorithm?: number; c?: number; count?: number };
          symmetric?: number;
          version?: number;
        };
        process.stderr.write(
          `[ENGINE] key ${k.ID.slice(-8)}: v=${kp.version} s2kType="${kp.s2k?.type}" s2kAlgo=${kp.s2k?.algorithm} s2kCount=${kp.s2k?.count ?? kp.s2k?.c} sym=${kp.symmetric}\n`
        );

        let decryptedKey: openpgp.PrivateKey | null = null;

        if (keyPassword === "") {
          decryptedKey = privateKey;
        } else {
          try {
            decryptedKey = await openpgp.decryptKey({ privateKey, passphrase: keyPassword });
            process.stderr.write(`[ENGINE] key ${k.ID.slice(-8)} DECRYPTED\n`);
          } catch (e1) {
            const e1msg = e1 instanceof Error ? e1.message : String(e1);
            process.stderr.write(`[ENGINE] key ${k.ID.slice(-8)}: decrypt failed: ${e1msg}\n`);
          }
        }

        if (decryptedKey !== null) {
          decrypted.push({ id: decryptedKey.getFingerprint(), key: decryptedKey });
          process.stderr.write(`[ENGINE] key ${k.ID.slice(-8)} decrypted OK (Primary=${k.Primary ?? 0})\n`);
          if (k.Primary === 1 || primaryKeyPassword === "") {
            primaryKeyPassword = keyPassword;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[ENGINE] key ${k.ID.slice(-8)} outer error: ${msg}\n`);
      }
    }

    if (decrypted.length === 0 && rawKeys.length > 0) {
      throw new SyncError(
        "All keys failed to decrypt — incorrect password or unsupported key format",
      );
    }
    process.stderr.write(`[ENGINE] fetchAndDecryptAllKeys: ${decrypted.length}/${rawKeys.length} decrypted\n`);
    this._decryptedKeys = decrypted;
    return primaryKeyPassword;
  }

  /** Return stored decrypted private keys (empty until fetchAndDecryptKeys succeeds). */
  getPrivateKeys(): { id: string; key: openpgp.PrivateKey }[] {
    return this._decryptedKeys;
  }
}

// ---------------------------------------------------------------------------
// createDriveClient(token) — factory function
//
// Assembles all adapters and constructs a real ProtonDriveClient, then wraps
// it in the engine's DriveClient. All SDK construction is confined to this
// function — ProtonDriveClient is NEVER constructed outside sdk.ts.
//
// The account adapter is injected into both ProtonDriveClient (for SDK crypto
// operations) and DriveClient (for validateSession).
// ---------------------------------------------------------------------------
export function createDriveClient(token: string, uid?: string): DriveClient {
  try {
    const httpClient = new ProtonHTTPClient(token, uid);

    const entitiesCache = new MemoryCache<string>();
    const cryptoCache = new MemoryCache<CachedCryptoMaterial>();

    const openPGPCryptoModule = new OpenPGPCryptoWithCryptoProxy(
      // Cast required because interface uses generic conditional return types
      // (Format/Detached) that TypeScript can't verify structurally against a
      // concrete branching implementation. Runtime behaviour is correct.
      new ProtonOpenPGPCryptoProxy() as unknown as OpenPGPCryptoProxy,
    );

    const account = new ProtonAccountAdapter(httpClient);

    const config: ProtonDriveConfig = {
      baseUrl: "drive-api.proton.me",
      clientUid: "io.github.ronki2304.ProtonDriveLinuxClient",
    };

    const params: ProtonDriveClientContructorParameters = {
      httpClient,
      entitiesCache,
      cryptoCache,
      account,
      openPGPCryptoModule,
      srpModule: srpStub,
      config,
      featureFlagProvider: new NullFeatureFlagProvider(),
      telemetry: undefined,
      latestEventIdProvider: undefined,
    };

    const sdkClient = new ProtonDriveClient(params);
    return new DriveClient(sdkClient, account, account);
  } catch (err) {
    mapSdkError(err);
    throw err; // defensive
  }
}
