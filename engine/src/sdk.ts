// SDK BOUNDARY: All @protontech/drive-sdk imports MUST be confined to this file.
// No other engine file may import the SDK directly.
// openpgp imports are also confined here.
//
// DriveClient wraps @protontech/drive-sdk behind a stable, app-shaped
// interface so the rest of the engine (sync orchestrator, IPC handlers, future
// watcher) is insulated from SDK version churn, openpgp wiring, and MaybeNode
// footguns. A 0.14.x SDK bump should only ever touch this file.
//
// The factory `createDriveClient(token)` and `validateSession(token)` live in
// Story 2.2.5 (sdk live wiring). This story ships only the wrapper class +
// boundary types + error mapping, with mocked unit tests.

import {
  AbortError,
  ConnectionError,
  DecryptionError,
  IntegrityError,
  NodeType,
  NodeWithSameNameExistsValidationError,
  ProtonDriveError,
  RateLimitedError,
  ServerError,
  ValidationError,
} from "@protontech/drive-sdk";
import type {
  MaybeNode,
  NodeEntity,
  ProtonDriveClient,
  UploadMetadata,
} from "@protontech/drive-sdk";
// Full openpgp bundle (NOT "openpgp/lightweight" — project-context.md hard rule).
// Imported here at the boundary to keep the SDK boundary discipline honest:
// no other engine file may ever import openpgp. The actual openpgp adapter
// (OpenPGPCryptoProxy) wiring lives in Story 2.2.5.
import * as openpgp from "openpgp";

import { EngineError, NetworkError, SyncError } from "./errors.js";
import { debugLog } from "./debug-log.js";

// Pin the namespace import so tree-shakers and lints recognize the binding as
// intentional. Removing this `void` would not break runtime — the import is
// already side-effecting — but it documents that the binding is held for the
// boundary contract, not for use in this story.
void openpgp;

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
  constructor(private readonly sdk: ProtonDriveClientLike) {}

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
}
