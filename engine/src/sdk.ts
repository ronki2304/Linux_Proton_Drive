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

import { EngineError, NetworkError, SyncError } from "./errors.js";
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
  | "getFileDownloader"
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
  if (err instanceof ConnectionError) {
    throw new NetworkError("Network unavailable", { cause: err });
  }
  if (err instanceof RateLimitedError) {
    throw new NetworkError("Rate limited", { cause: err });
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
    if (!this.account) {
      throw new SyncError(
        "account adapter not wired — use createDriveClient(token)",
      );
    }
    try {
      const address = await this.account.getOwnPrimaryAddress();
      return {
        display_name: address.email, // TODO(story-2.x): fetch display name from /core/v4/users
        email: address.email,
        storage_used: 0, // TODO(story-2.x): fetch from /core/v4/users
        storage_total: 0, // TODO(story-2.x): fetch from /core/v4/users
        plan: "", // TODO(story-2.x): fetch from /core/v4/organizations or /payments
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
  constructor(private readonly token: string) {}

  async fetchJson(request: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${this.token}`);

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
    headers.set("Authorization", `Bearer ${this.token}`);

    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
      : AbortSignal.timeout(request.timeoutMs);

    return fetch(request.url, {
      method: request.method,
      headers,
      signal,
      body: request.body,
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

  async encryptMessage(options: Parameters<OpenPGPCryptoProxy["encryptMessage"]>[0]) {
    const fmt = options.format ?? "armored";

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
            config: options.config,
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
          config: options.config,
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
        config: options.config,
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
      config: options.config,
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
  constructor(private readonly httpClient: ProtonHTTPClient) {}

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
      url: "https://core.proton.me/core/v4/addresses",
      method: "GET",
      headers: new Headers(),
      timeoutMs: 10_000,
    });
    if (!response.ok) {
      throw new NetworkError(`Addresses API error: ${response.status}`);
    }
    const json = (await response.json()) as {
      Addresses?: Array<{ ID: string; Email: string; Order: number }>;
    };
    const addresses = json.Addresses ?? [];
    // Sort by Order ascending — lower Order = higher priority (primary first)
    addresses.sort((a, b) => a.Order - b.Order);
    return addresses.map((addr) => ({
      email: addr.Email,
      addressId: addr.ID,
      primaryKeyIndex: 0,
      // TODO(story-2.x): private key decryption requires key password not available
      // in current auth flow — see story 2.2.5 Dev Agent Record for investigation findings
      keys: [],
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
      url: `https://core.proton.me/core/v4/keys?Email=${encodeURIComponent(email)}`,
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
export function createDriveClient(token: string): DriveClient {
  try {
    const httpClient = new ProtonHTTPClient(token);

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
    return new DriveClient(sdkClient, account);
  } catch (err) {
    mapSdkError(err);
    throw err; // defensive
  }
}
