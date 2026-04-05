/**
 * SDK Abstraction Boundary
 *
 * THIS IS THE ONLY FILE IN THE PROJECT THAT MAY IMPORT FROM @protontech/drive-sdk.
 * All other code interacts with ProtonDrive via the DriveClient class exported here.
 *
 * Any SDK version migration only requires changes in this file.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createHash } from "node:crypto";
import {
  ProtonDriveClient,
  MemoryCache,
  OpenPGPCryptoWithCryptoProxy,
  ConnectionError,
  RateLimitedError,
  ServerError,
  ValidationError,
  NodeType,
} from "@protontech/drive-sdk";
import type {
  ProtonDriveHTTPClient,
  NodeEntity,
  MaybeNode,
} from "@protontech/drive-sdk";
import { AuthError, ConfigError, NetworkError, SyncError } from "../errors.js";
import type { SessionToken, DriveItem, DriveItemMetadata } from "../types.js";
import { openPGPCryptoProxy } from "./openpgp-proxy.js";
import { buildAccount } from "./account-service.js";
import { srpModule } from "./srp-module.js";

export interface DriveClientOptions {
  onProgress?: (msg: string) => void;
}

const RETRY_DELAYS_MS = [1000, 2000, 4000];
const PROTON_API = "https://api.proton.me";

function isNonRetryableError(err: unknown): boolean {
  return (
    err instanceof AuthError ||
    err instanceof SyncError ||
    err instanceof ConfigError ||
    err instanceof ValidationError
  );
}

function mapSdkError(err: unknown): never {
  if (
    err instanceof ConnectionError ||
    err instanceof RateLimitedError
  ) {
    throw new NetworkError(
      err instanceof Error ? err.message : "Drive API network error",
      "NETWORK_DRIVE_ERROR",
    );
  }
  if (err instanceof ServerError) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      throw new AuthError(
        "Session token expired or invalid — run 'protondrive auth login'.",
        "AUTH_TOKEN_EXPIRED",
      );
    }
    if (err.statusCode === 404) {
      throw new SyncError(
        err.message ?? "Remote path not found",
        "REMOTE_NOT_FOUND",
      );
    }
    throw new SyncError(err.message ?? String(err), "DRIVE_SERVER_ERROR");
  }
  if (err instanceof ValidationError && err.code === 404) {
    throw new SyncError(
      err instanceof Error ? err.message : "Remote path not found",
      "REMOTE_NOT_FOUND",
    );
  }
  if (err instanceof AuthError) throw err;
  if (err instanceof NetworkError) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  throw new SyncError(`Drive API error: ${msg}`, "DRIVE_API_ERROR");
}

function buildHttpClient(token: SessionToken): ProtonDriveHTTPClient {
  const headers = () =>
    new Headers({
      "Authorization": `Bearer ${token.accessToken}`,
      "x-pm-uid": token.uid,
      "x-pm-appversion": "Other",
      "Content-Type": "application/json",
    });
  return {
    async fetchJson(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        return await fetch(request.url, {
          method: request.method,
          headers: request.headers ?? headers(),
          body: request.json ? JSON.stringify(request.json) : (request.body as string | null | undefined),
          signal: request.signal ?? controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    },
    async fetchBlob(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        return await fetch(request.url, {
          method: request.method,
          headers: request.headers ?? headers(),
          body: request.body as string | null | undefined,
          signal: request.signal ?? controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Resolve a node entity from a MaybeNode result, returning undefined for degraded/missing. */
function resolveNode(maybeNode: MaybeNode): NodeEntity | undefined {
  return maybeNode.ok ? maybeNode.value : undefined;
}

export class DriveClient {
  private readonly sdkClient: ProtonDriveClient;
  private readonly opts: DriveClientOptions;

  constructor(
    _token: SessionToken,
    opts: DriveClientOptions = {},
  ) {
    this.opts = opts;
    // SDK client initialization — full setup requires crypto provider and httpClient.
    // Use createLiveDriveClient() factory for production use.
    // In unit tests this constructor is used; methods are mocked at the DriveClient level.
    this.sdkClient = null as unknown as ProtonDriveClient;
  }

  /** @internal — only for createLiveDriveClient factory */
  _setSdkClient(client: ProtonDriveClient): void {
    (this as unknown as { sdkClient: ProtonDriveClient }).sdkClient = client;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (isNonRetryableError(err)) {
          throw err;
        }
        lastError = err;
        if (attempt < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[attempt]!;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    mapSdkError(lastError);
  }

  /** Navigate from root to the given remote path, returning the final node UID. */
  private async resolveRemotePath(remotePath: string): Promise<string> {
    const rootMaybeNode = await this.sdkClient.getMyFilesRootFolder();
    const root = resolveNode(rootMaybeNode);
    if (!root) throw new SyncError("Cannot access ProtonDrive root folder", "REMOTE_NOT_FOUND");

    const segments = remotePath.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    if (segments.length === 0) return root.uid;

    let currentUid = root.uid;
    for (const segment of segments) {
      let found: NodeEntity | undefined;
      for await (const child of this.sdkClient.iterateFolderChildren(currentUid)) {
        const node = resolveNode(child);
        if (node && node.name === segment) {
          found = node;
          break;
        }
      }
      if (!found) {
        throw new SyncError(`Remote path not found: ${remotePath} (missing: ${segment})`, "REMOTE_NOT_FOUND");
      }
      currentUid = found.uid;
    }
    return currentUid;
  }

  /**
   * Navigate to the parent folder of the given remote path, returning
   * { parentUid, fileName }. Creates missing intermediate folders.
   */
  private async resolveParentPath(remotePath: string): Promise<{ parentUid: string; fileName: string }> {
    const parts = remotePath.replace(/^\/+/, "").split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) throw new SyncError(`Invalid remote path: ${remotePath}`, "DRIVE_API_ERROR");

    const rootMaybeNode = await this.sdkClient.getMyFilesRootFolder();
    const root = resolveNode(rootMaybeNode);
    if (!root) throw new SyncError("Cannot access ProtonDrive root folder", "REMOTE_NOT_FOUND");

    let currentUid = root.uid;
    for (const segment of parts) {
      let found: NodeEntity | undefined;
      for await (const child of this.sdkClient.iterateFolderChildren(currentUid, { type: NodeType.Folder })) {
        const node = resolveNode(child);
        if (node && node.name === segment) {
          found = node;
          break;
        }
      }
      if (!found) {
        // Create missing folder
        const newFolder = resolveNode(await this.sdkClient.createFolder(currentUid, segment));
        if (!newFolder) throw new SyncError(`Failed to create folder: ${segment}`, "DRIVE_API_ERROR");
        found = newFolder;
      }
      currentUid = found.uid;
    }
    return { parentUid: currentUid, fileName };
  }

  async listFolder(remotePath: string): Promise<DriveItem[]> {
    this.opts.onProgress?.(`Listing folder: ${remotePath}`);
    return this.withRetry(async () => {
      if (!this.sdkClient) return [];
      const folderUid = await this.resolveRemotePath(remotePath);
      const items: DriveItem[] = [];
      for await (const child of this.sdkClient.iterateFolderChildren(folderUid)) {
        const node = resolveNode(child);
        if (!node) continue;
        items.push({
          id: node.uid,
          name: node.name,
          remotePath: remotePath.replace(/\/$/, "") + "/" + node.name,
          isFolder: node.type === NodeType.Folder,
          mtime: node.type !== NodeType.Folder
            ? ((node as unknown as { modificationTime?: Date }).modificationTime?.toISOString() ?? new Date(0).toISOString())
            : new Date(0).toISOString(),
          size: 0,
        });
      }
      return items;
    });
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    this.opts.onProgress?.(`Uploading: ${localPath} → ${remotePath}`);
    return this.withRetry(async () => {
      if (!this.sdkClient) return;
      if (!fs.existsSync(localPath)) {
        throw new SyncError(`Local file not found: ${localPath}`, "LOCAL_NOT_FOUND");
      }
      const stat = fs.statSync(localPath);
      const { parentUid, fileName } = await this.resolveParentPath(remotePath);
      const metadata = {
        mediaType: "application/octet-stream",
        expectedSize: stat.size,
        modificationTime: stat.mtime,
      };
      const uploader = await this.sdkClient.getFileUploader(parentUid, fileName, metadata);
      const fileStream = Bun.file(localPath).stream() as ReadableStream;
      const controller = await uploader.uploadFromStream(fileStream, []);
      await controller.completion();
    });
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    this.opts.onProgress?.(`Downloading: ${remotePath} → ${localPath}`);
    return this.withRetry(async () => {
      if (!this.sdkClient) return;
      const nodeUid = await this.resolveRemotePath(remotePath);
      const downloader = await this.sdkClient.getFileDownloader(nodeUid);
      const tmpPath = localPath + ".dl-tmp-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      const dir = path.dirname(localPath);
      fs.mkdirSync(dir, { recursive: true });
      const writableStream = new WritableStream<Uint8Array>({
        write(chunk, controller) {
          try {
            fs.appendFileSync(tmpPath, chunk);
          } catch (err) {
            controller.error(err);
          }
        },
      });
      const controller = downloader.downloadToStream(writableStream);
      try {
        await controller.completion();
        fs.renameSync(tmpPath, localPath);
      } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup failure */ }
        throw err;
      }
    });
  }

  async getFileMetadata(remotePath: string): Promise<DriveItemMetadata> {
    this.opts.onProgress?.(`Getting metadata: ${remotePath}`);
    return this.withRetry(async () => {
      if (!this.sdkClient) {
        throw new SyncError(
          `getFileMetadata requires live DriveClient: ${remotePath}`,
          "NOT_IMPLEMENTED",
        );
      }
      const nodeUid = await this.resolveRemotePath(remotePath);
      const maybeNode = await this.sdkClient.getNode(nodeUid);
      const node = resolveNode(maybeNode);
      if (!node) throw new SyncError(`Remote path not found: ${remotePath}`, "REMOTE_NOT_FOUND");
      const n = node as unknown as {
        modificationTime?: Date;
        size?: number;
        sha1?: string;
      };
      // SHA-256 hash is not available from metadata alone; use empty string as placeholder
      return {
        id: node.uid,
        name: node.name,
        remotePath,
        isFolder: node.type === NodeType.Folder,
        mtime: n.modificationTime?.toISOString() ?? new Date(0).toISOString(),
        size: n.size ?? 0,
        hash: "",
      };
    });
  }

  /** Delete a node (file or folder and all its contents) by remote path. */
  async deleteNode(remotePath: string): Promise<void> {
    if (!this.sdkClient) return;
    try {
      const nodeUid = await this.resolveRemotePath(remotePath);
      for await (const _ of this.sdkClient.trashNodes([nodeUid])) { void _; }
    } catch (err) {
      if (err instanceof AuthError) throw err;
      // Ignore other errors during cleanup (e.g., node already deleted)
    }
  }

  /** Create a folder at the given remote path, returning its UID. */
  async createFolder(remotePath: string): Promise<string> {
    if (!this.sdkClient) throw new SyncError("Live DriveClient required", "NOT_IMPLEMENTED");
    const { parentUid, fileName } = await this.resolveParentPath(remotePath);
    const newFolder = resolveNode(await this.sdkClient.createFolder(parentUid, fileName));
    if (!newFolder) throw new SyncError(`Failed to create folder: ${remotePath}`, "DRIVE_API_ERROR");
    return newFolder.uid;
  }
}

/**
 * Create a DriveClient backed by the real ProtonDrive SDK.
 *
 * @param token - Session token from srp.authenticate()
 * @param password - User's login password (needed to decrypt PGP account keys)
 * @param opts - Optional progress callback
 */
export async function createLiveDriveClient(
  token: SessionToken,
  password: string,
  opts: DriveClientOptions = {},
): Promise<DriveClient> {
  const httpClient = buildHttpClient(token);
  const account = await buildAccount(password, httpClient);

  const sdkClient = new ProtonDriveClient({
    httpClient,
    entitiesCache: new MemoryCache(),
    cryptoCache: new MemoryCache(),
    account,
    openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(openPGPCryptoProxy),
    srpModule,
  });

  const client = new DriveClient(token, opts);
  client._setSdkClient(sdkClient);
  return client;
}
