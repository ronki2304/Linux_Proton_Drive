import { describe, it, mock, beforeAll, afterAll, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import * as openpgp from "openpgp";

import {
  DriveClient,
  ROOT_PARENT_ID,
  createDriveClient,
  sdkErrorFactoriesForTests,
  type ProtonDriveClientLike,
  type UploadBody,
  type AccountInfo,
} from "./sdk.js";
import { EngineError, NetworkError, SyncError } from "./errors.js";

describe("SDK boundary enforcement", () => {
  const srcDir = path.resolve(import.meta.dirname!, ".");

  it("sdk.ts has boundary comment", () => {
    const content = fs.readFileSync(path.join(srcDir, "sdk.ts"), "utf8");
    expect(content.includes("SDK BOUNDARY")).toBeTruthy();
  });

  it("errors.ts has zero internal imports", () => {
    const content = fs.readFileSync(path.join(srcDir, "errors.ts"), "utf8");
    const internalImports = content.match(/from ["']\.\/.*["']/g);
    expect(internalImports).toBeNull();
  });

  it("ipc.ts does not import from sdk.ts", () => {
    const content = fs.readFileSync(path.join(srcDir, "ipc.ts"), "utf8");
    expect(!content.includes('from "./sdk')).toBeTruthy();
  });

  it("sdk.ts only imports from leaf modules (errors.ts, debug-log.ts) internally", () => {
    const content = fs.readFileSync(path.join(srcDir, "sdk.ts"), "utf8");
    const internalImports = content.match(/from ["']\.\/[^"']+["']/g) ?? [];

    // Both errors.ts and debug-log.ts are leaf modules with zero internal
    // imports — circularity stays impossible. Match exact basenames (with
    // .js extension since we use NodeNext module resolution) so a future
    // sibling like `./errors-helper.js` or `./debug-log-extra.js` would
    // be rejected — substring matching is too loose.
    const allowedExact = new Set(['from "./errors.js"', "from './errors.js'", 'from "./debug-log.js"', "from './debug-log.js'"]);

    for (const imp of internalImports) {
      expect(allowedExact.has(imp)).toBeTruthy();
    }
  });

  it("sdkErrorFactoriesForTests is only imported by sdk.test.ts", () => {
    const files = fs.readdirSync(srcDir).filter(
      (f) => f.endsWith(".ts") && f !== "sdk.ts" && f !== "sdk.test.ts",
    );

    for (const file of files) {
      const content = fs.readFileSync(path.join(srcDir, file), "utf8");
      expect(!content.includes("sdkErrorFactoriesForTests")).toBeTruthy();
    }
  });

  it("no other engine file imports @protontech/drive-sdk", () => {
    const files = fs.readdirSync(srcDir).filter(
      (f) => f.endsWith(".ts") && f !== "sdk.ts" && f !== "sdk.test.ts",
    );

    for (const file of files) {
      const content = fs.readFileSync(path.join(srcDir, file), "utf8");
      expect(!content.includes("@protontech/drive-sdk")).toBeTruthy();
    }
  });

  it("sdk.test.ts does not import @protontech/drive-sdk directly", () => {
    const content = fs.readFileSync(path.join(srcDir, "sdk.test.ts"), "utf8");
    expect(!/from ["']@protontech\/drive-sdk["']/.test(content)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// DriveClient wrapper tests
// ---------------------------------------------------------------------------

const NODE_TYPE_FOLDER = "folder";
const NODE_TYPE_FILE = "file";

interface FakeRevision {
  claimedModificationTime?: Date;
  claimedSize?: number;
}

interface FakeNodeEntity {
  uid: string;
  name: string;
  type: string;
  parentUid?: string;
  modificationTime?: Date;
  totalStorageSize?: number;
  activeRevision?: FakeRevision;
}

type FakeMaybeNode =
  | { ok: true; value: FakeNodeEntity }
  | { ok: false; error: { message: string } };

function makeFakeNode(
  uid: string,
  name: string,
  type: string,
  parentUid?: string,
): FakeMaybeNode {
  return { ok: true, value: { uid, name, type, parentUid } };
}

function makeFakeFileNode(
  uid: string,
  name: string,
  modificationTime: Date,
  size: number,
  activeRevision?: FakeRevision,
): FakeMaybeNode {
  return {
    ok: true,
    value: {
      uid,
      name,
      type: NODE_TYPE_FILE,
      modificationTime,
      totalStorageSize: size,
      activeRevision,
    },
  };
}

function makeDegradedNode(): FakeMaybeNode {
  return { ok: false, error: { message: "decryption failure" } };
}

function makeFakeSdk(
  overrides: Record<string, unknown> = {},
): ProtonDriveClientLike {
  return {
    getMyFilesRootFolder: mock(async () => makeFakeNode("root-uid", "My Files", NODE_TYPE_FOLDER)),
    iterateFolderChildren: mock(async function* (): AsyncGenerator<FakeMaybeNode> {
      // Default: empty folder.
    }),
    getFileUploader: mock(() => {}),
    getFileDownloader: mock(() => {}),
    ...overrides,
  } as unknown as ProtonDriveClientLike;
}

function asyncGenOf(nodes: FakeMaybeNode[]) {
  return mock(async function* (
    _parent: unknown,
    _opts?: unknown,
  ): AsyncGenerator<FakeMaybeNode> {
    for (const n of nodes) {
      yield n;
    }
  });
}

describe("DriveClient.listRemoteFolders", () => {
  it("calls getMyFilesRootFolder when parentId is null and iterates root children", async () => {
    const iterFn = asyncGenOf([
      makeFakeNode("uid-a", "Alpha", NODE_TYPE_FOLDER, "root-uid"),
      makeFakeNode("uid-b", "Beta", NODE_TYPE_FOLDER, "root-uid"),
    ]);
    const rootFn = mock(async () => makeFakeNode("root-uid", "My Files", NODE_TYPE_FOLDER));
    const sdk = makeFakeSdk({
      getMyFilesRootFolder: rootFn,
      iterateFolderChildren: iterFn,
    });
    const client = new DriveClient(sdk);

    const result = await client.listRemoteFolders(null);

    expect(rootFn.mock.calls.length).toBe(1);
    expect(iterFn.mock.calls.length).toBe(1);
    expect(result).toEqual([
      { id: "uid-a", name: "Alpha", parent_id: ROOT_PARENT_ID },
      { id: "uid-b", name: "Beta", parent_id: ROOT_PARENT_ID },
    ]);
  });

  it("does NOT call getMyFilesRootFolder when parentId is a UID", async () => {
    const iterFn = asyncGenOf([
      makeFakeNode("uid-x", "Child", NODE_TYPE_FOLDER, "parent-123"),
    ]);
    const rootFn = mock(async () => makeFakeNode("root-uid", "My Files", NODE_TYPE_FOLDER));
    const sdk = makeFakeSdk({
      getMyFilesRootFolder: rootFn,
      iterateFolderChildren: iterFn,
    });
    const client = new DriveClient(sdk);

    const result = await client.listRemoteFolders("parent-123");

    expect(rootFn.mock.calls.length).toBe(0);
    expect(iterFn.mock.calls.length).toBe(1);
    expect(iterFn.mock.calls[0]![0]).toBe("parent-123");
    expect(result).toEqual([
      { id: "uid-x", name: "Child", parent_id: "parent-123" },
    ]);
  });

  it("passes the { type: NodeType.Folder } filter hint to iterateFolderChildren", async () => {
    const iterFn = asyncGenOf([]);
    const sdk = makeFakeSdk({ iterateFolderChildren: iterFn });
    const client = new DriveClient(sdk);

    await client.listRemoteFolders("p");

    expect(iterFn.mock.calls.length).toBe(1);
    const filterArg = iterFn.mock.calls[0]![1] as { type?: string } | undefined;
    expect(filterArg).toBeTruthy();
    expect(filterArg!.type).toBe(NODE_TYPE_FOLDER);
  });

  it("filters out file nodes (folders only)", async () => {
    const iterFn = asyncGenOf([
      makeFakeNode("uid-folder", "FolderOne", NODE_TYPE_FOLDER, "p"),
      makeFakeNode("uid-file", "file.txt", NODE_TYPE_FILE, "p"),
      makeFakeNode("uid-folder2", "FolderTwo", NODE_TYPE_FOLDER, "p"),
    ]);
    const sdk = makeFakeSdk({ iterateFolderChildren: iterFn });
    const client = new DriveClient(sdk);

    const result = await client.listRemoteFolders("p");

    expect(result.map((r) => r.id)).toEqual(["uid-folder", "uid-folder2"]);
  });

  it("silently skips degraded MaybeNode results", async () => {
    const iterFn = asyncGenOf([
      makeFakeNode("uid-ok", "Visible", NODE_TYPE_FOLDER, "p"),
      makeDegradedNode(),
      makeFakeNode("uid-ok2", "AlsoVisible", NODE_TYPE_FOLDER, "p"),
    ]);
    const sdk = makeFakeSdk({ iterateFolderChildren: iterFn });
    const client = new DriveClient(sdk);

    const result = await client.listRemoteFolders("p");

    expect(result.length).toBe(2);
    expect(result.map((r) => r.id)).toEqual(["uid-ok", "uid-ok2"]);
  });

  it("returns an empty array for an empty folder", async () => {
    const sdk = makeFakeSdk({ iterateFolderChildren: asyncGenOf([]) });
    const client = new DriveClient(sdk);

    const result = await client.listRemoteFolders("empty-uid");

    expect(result).toEqual([]);
  });

  it("uses the requested parentId for child entries even when SDK omits parentUid", async () => {
    const iterFn = asyncGenOf([
      { ok: true, value: { uid: "orphan", name: "Orphan", type: NODE_TYPE_FOLDER } },
    ]);
    const sdk = makeFakeSdk({ iterateFolderChildren: iterFn });
    const client = new DriveClient(sdk);

    const result = await client.listRemoteFolders("p");

    expect(result[0]!.parent_id).toBe("p");
  });

  it("propagates iterator errors mid-stream and discards partial results", async () => {
    async function* throwingGen(): AsyncGenerator<FakeMaybeNode> {
      yield makeFakeNode("uid-1", "Visible", NODE_TYPE_FOLDER, "p");
      throw sdkErrorFactoriesForTests.connection("dropped mid-stream");
    }
    const sdk = makeFakeSdk({
      iterateFolderChildren: mock(throwingGen),
    });
    const client = new DriveClient(sdk);

    await expect(client.listRemoteFolders("p")).rejects.toBeInstanceOf(NetworkError);
  });

  it("throws SyncError when My Files root is degraded", async () => {
    const sdk = makeFakeSdk({
      getMyFilesRootFolder: mock(async () => makeDegradedNode()),
    });
    const client = new DriveClient(sdk);

    let captured: unknown;
    try {
      await client.listRemoteFolders(null);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SyncError);
    expect((captured as Error).message).toMatch(/My Files root unavailable/);
  });
});

describe("DriveClient.uploadFile", () => {
  function makeRejectingUploadSdk(rejectErr: Error) {
    const fakeController = {
      pause: () => {},
      resume: () => {},
      completion: mock(async () => {
        throw rejectErr;
      }),
    };
    const fakeUploader = {
      uploadFromStream: mock(
        async (
          _stream: ReadableStream<Uint8Array>,
          _thumbnails: unknown[],
        ) => fakeController,
      ),
      uploadFromFile: mock(() => {}),
    };
    return makeFakeSdk({
      getFileUploader: mock(
        async (_p: string, _n: string, _m: unknown) => fakeUploader,
      ),
    });
  }

  it("delegates to getFileUploader → uploadFromStream → completion and returns snake_case shape", async () => {
    const fakeController = {
      pause: () => {},
      resume: () => {},
      completion: mock(async () => ({ nodeUid: "node-1", nodeRevisionUid: "rev-1" })),
    };
    const uploadFromStreamFn = mock(
      async (
        _stream: ReadableStream<Uint8Array>,
        _thumbnails: unknown[],
      ) => fakeController,
    );
    const fakeUploader = {
      uploadFromStream: uploadFromStreamFn,
      uploadFromFile: mock(() => {}),
    };
    const getFileUploaderFn = mock(
      async (
        _parentId: string,
        _name: string,
        _metadata: unknown,
      ) => fakeUploader,
    );
    const sdk = makeFakeSdk({ getFileUploader: getFileUploaderFn });
    const client = new DriveClient(sdk);

    const stream = new ReadableStream<Uint8Array>();
    const modTime = new Date("2026-04-10T12:00:00Z");
    const body: UploadBody = {
      stream,
      sizeBytes: 1024,
      modificationTime: modTime,
      mediaType: "text/plain",
    };

    const result = await client.uploadFile("parent-uid", "test.txt", body);

    expect(result).toEqual({ node_uid: "node-1", revision_uid: "rev-1" });

    expect(getFileUploaderFn.mock.calls.length).toBe(1);
    const call = getFileUploaderFn.mock.calls[0]!;
    expect(call[0]).toBe("parent-uid");
    expect(call[1]).toBe("test.txt");
    expect(call[2]).toEqual({
      mediaType: "text/plain",
      expectedSize: 1024,
      modificationTime: modTime,
    });

    expect(uploadFromStreamFn.mock.calls.length).toBe(1);
    expect(uploadFromStreamFn.mock.calls[0]![0]).toBe(stream);
    expect(uploadFromStreamFn.mock.calls[0]![1]).toEqual([]);

    expect(fakeController.completion.mock.calls.length).toBe(1);
  });

  it("re-throws AbortError as-is when upload is aborted", async () => {
    const abortErr = sdkErrorFactoriesForTests.abort("user cancelled upload");
    const sdk = makeRejectingUploadSdk(abortErr);
    const client = new DriveClient(sdk);

    const stream = new ReadableStream<Uint8Array>();
    let captured: unknown;
    try {
      await client.uploadFile("p", "f.txt", {
        stream,
        sizeBytes: 1,
        modificationTime: new Date(),
        mediaType: "text/plain",
      });
      expect(true).toBe(false);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBe(abortErr);
  });

  it("maps a rejecting completion() to the typed engine error", async () => {
    const sdkErr = sdkErrorFactoriesForTests.connection("upload network");
    const sdk = makeRejectingUploadSdk(sdkErr);
    const client = new DriveClient(sdk);

    const stream = new ReadableStream<Uint8Array>();
    let captured: unknown;
    try {
      await client.uploadFile("p", "f.txt", {
        stream,
        sizeBytes: 1,
        modificationTime: new Date(),
        mediaType: "text/plain",
      });
      expect(true).toBe(false);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(NetworkError);
    expect((captured as Error & { cause?: unknown }).cause).toBe(sdkErr);
  });

  it("cancels the body stream when upload fails", async () => {
    const sdk = makeRejectingUploadSdk(
      sdkErrorFactoriesForTests.integrity("size mismatch"),
    );
    const client = new DriveClient(sdk);

    const stream = new ReadableStream<Uint8Array>();
    let cancelledWith: unknown = "<not called>";
    const origCancel = stream.cancel.bind(stream);
    stream.cancel = async (reason?: unknown) => {
      cancelledWith = reason;
      return origCancel(reason);
    };

    await expect(
      client.uploadFile("p", "f.txt", {
        stream,
        sizeBytes: 1,
        modificationTime: new Date(),
        mediaType: "text/plain",
      }),
    ).rejects.toBeInstanceOf(SyncError);
    expect(cancelledWith).not.toBe("<not called>");
  });
});

describe("DriveClient.downloadFile", () => {
  it("delegates to getFileDownloader → downloadToStream → completion", async () => {
    const completionFn = mock(async () => undefined);
    const fakeController = {
      pause: () => {},
      resume: () => {},
      completion: completionFn,
      isDownloadCompleteWithSignatureIssues: mock(() => false),
    };
    const downloadToStreamFn = mock(
      (_target: WritableStream<Uint8Array>) => fakeController,
    );
    const fakeDownloader = {
      getClaimedSizeInBytes: () => undefined,
      downloadToStream: downloadToStreamFn,
      unsafeDownloadToStream: mock(() => {}),
      getSeekableStream: mock(() => {}),
    };
    const getFileDownloaderFn = mock(
      async (_nodeUid: string) => fakeDownloader,
    );
    const sdk = makeFakeSdk({ getFileDownloader: getFileDownloaderFn });
    const client = new DriveClient(sdk);

    const target = new WritableStream<Uint8Array>();
    await client.downloadFile("node-uid", target);

    expect(getFileDownloaderFn.mock.calls.length).toBe(1);
    expect(getFileDownloaderFn.mock.calls[0]![0]).toBe("node-uid");
    expect(downloadToStreamFn.mock.calls.length).toBe(1);
    expect(downloadToStreamFn.mock.calls[0]![0]).toBe(target);
    expect(completionFn.mock.calls.length).toBe(1);
    expect(fakeController.isDownloadCompleteWithSignatureIssues.mock.calls.length).toBe(1);
    expect(fakeDownloader.unsafeDownloadToStream.mock.calls.length).toBe(0);
  });

  it("resolves successfully even when signature verification flags issues", async () => {
    const fakeController = {
      pause: () => {},
      resume: () => {},
      completion: mock(async () => undefined),
      isDownloadCompleteWithSignatureIssues: mock(() => true),
    };
    const fakeDownloader = {
      getClaimedSizeInBytes: () => undefined,
      downloadToStream: mock(() => fakeController),
      unsafeDownloadToStream: mock(() => {}),
      getSeekableStream: mock(() => {}),
    };
    const sdk = makeFakeSdk({
      getFileDownloader: mock(async () => fakeDownloader),
    });
    const client = new DriveClient(sdk);

    // Must NOT throw — Story 2.5 will decide on user-visible warnings.
    await client.downloadFile("node-uid", new WritableStream<Uint8Array>());
    expect(fakeController.isDownloadCompleteWithSignatureIssues.mock.calls.length).toBe(1);
  });

  function makeRejectingDownloadSdk(rejectErr: Error) {
    const fakeController = {
      pause: () => {},
      resume: () => {},
      completion: mock(async () => {
        throw rejectErr;
      }),
      isDownloadCompleteWithSignatureIssues: mock(() => false),
    };
    const fakeDownloader = {
      getClaimedSizeInBytes: () => undefined,
      downloadToStream: mock(
        (_target: WritableStream<Uint8Array>) => fakeController,
      ),
      unsafeDownloadToStream: mock(() => {}),
      getSeekableStream: mock(() => {}),
    };
    return makeFakeSdk({
      getFileDownloader: mock(async (_uid: string) => fakeDownloader),
    });
  }

  it("re-throws AbortError as-is when download is aborted", async () => {
    const abortErr = sdkErrorFactoriesForTests.abort("user cancelled download");
    const sdk = makeRejectingDownloadSdk(abortErr);
    const client = new DriveClient(sdk);

    let captured: unknown;
    try {
      await client.downloadFile("node-uid", new WritableStream<Uint8Array>());
      expect(true).toBe(false);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBe(abortErr);
  });

  it("maps a rejecting completion() to the typed engine error", async () => {
    const sdkErr = sdkErrorFactoriesForTests.server("download server boom");
    const sdk = makeRejectingDownloadSdk(sdkErr);
    const client = new DriveClient(sdk);

    let captured: unknown;
    try {
      await client.downloadFile("node-uid", new WritableStream<Uint8Array>());
      expect(true).toBe(false);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(NetworkError);
    expect((captured as Error & { cause?: unknown }).cause).toBe(sdkErr);
  });

  it("aborts the target writable stream when download fails", async () => {
    const sdk = makeRejectingDownloadSdk(
      sdkErrorFactoriesForTests.integrity("decryption failed"),
    );
    const client = new DriveClient(sdk);

    const target = new WritableStream<Uint8Array>();
    let abortedWith: unknown = "<not called>";
    const origAbort = target.abort.bind(target);
    target.abort = async (reason?: unknown) => {
      abortedWith = reason;
      return origAbort(reason);
    };

    await expect(client.downloadFile("node-uid", target)).rejects.toBeInstanceOf(SyncError);
    expect(abortedWith).not.toBe("<not called>");
  });
});

describe("DriveClient SDK error mapping", () => {
  async function expectMapping(
    throwError: Error,
    expectedClass: typeof SyncError | typeof NetworkError,
    expectedMessageMatcher: RegExp,
  ): Promise<void> {
    const sdk = makeFakeSdk({
      getMyFilesRootFolder: mock(async () => {
        throw throwError;
      }),
    });
    const client = new DriveClient(sdk);

    let captured: unknown;
    try {
      await client.listRemoteFolders(null);
      expect(true).toBe(false);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(expectedClass);
    expect((captured as Error).message).toMatch(expectedMessageMatcher);
    expect((captured as Error & { cause?: unknown }).cause).toBe(throwError);
  }

  it("ConnectionError → NetworkError('Network unavailable')", async () => {
    await expectMapping(sdkErrorFactoriesForTests.connection(), NetworkError, /Network unavailable/);
  });

  it("RateLimitedError → NetworkError('Rate limited') (subclass before parent)", async () => {
    await expectMapping(sdkErrorFactoriesForTests.rateLimited(), NetworkError, /Rate limited/);
  });

  it("ServerError → NetworkError('API error: ...')", async () => {
    await expectMapping(sdkErrorFactoriesForTests.server("boom"), NetworkError, /API error: boom/);
  });

  it("IntegrityError → SyncError('Decryption failed')", async () => {
    await expectMapping(sdkErrorFactoriesForTests.integrity(), SyncError, /Decryption failed/);
  });

  it("DecryptionError → SyncError('Decryption failed')", async () => {
    await expectMapping(sdkErrorFactoriesForTests.decryption(), SyncError, /Decryption failed/);
  });

  it("ValidationError → SyncError('Validation failed: ...')", async () => {
    await expectMapping(sdkErrorFactoriesForTests.validation("bad name"), SyncError, /Validation failed: bad name/);
  });

  it("NodeWithSameNameExistsValidationError → SyncError('Validation failed: ...') via parent branch", async () => {
    await expectMapping(
      sdkErrorFactoriesForTests.nodeWithSameName("file.txt"),
      SyncError,
      /Validation failed: file\.txt/,
    );
  });

  it("Generic ProtonDriveError → SyncError(message)", async () => {
    await expectMapping(sdkErrorFactoriesForTests.protonDrive("oops"), SyncError, /oops/);
  });

  it("Plain Error → SyncError('Unexpected SDK error')", async () => {
    await expectMapping(new Error("not from sdk"), SyncError, /Unexpected SDK error/);
  });

  it("AbortError is re-thrown as-is (not wrapped)", async () => {
    const abortErr = sdkErrorFactoriesForTests.abort("user cancelled");
    const sdk = makeFakeSdk({
      getMyFilesRootFolder: mock(async () => {
        throw abortErr;
      }),
    });
    const client = new DriveClient(sdk);

    let captured: unknown;
    try {
      await client.listRemoteFolders(null);
      expect(true).toBe(false);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBe(abortErr);
    expect(captured instanceof EngineError).toBe(false);
  });

  it("EngineError thrown inside the wrapper is re-thrown as-is (not re-wrapped)", async () => {
    const ourError = new SyncError("synthetic engine error from inside wrapper");
    const sdk = makeFakeSdk({
      getMyFilesRootFolder: mock(async () => {
        throw ourError;
      }),
    });
    const client = new DriveClient(sdk);

    let captured: unknown;
    try {
      await client.listRemoteFolders(null);
      expect(true).toBe(false);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBe(ourError);
    expect((captured as Error).message).toBe("synthetic engine error from inside wrapper");
  });
});

// ===========================================================================
// Story 2.5 — DriveClient.listRemoteFiles (AC9)
// ===========================================================================

describe("DriveClient.listRemoteFiles", () => {
  it("returns RemoteFile entries for two file nodes with correct fields", async () => {
    const mtime1 = new Date("2026-04-10T10:00:00.000Z");
    const mtime2 = new Date("2026-04-10T11:00:00.000Z");
    const iterFn = asyncGenOf([
      makeFakeFileNode("uid-1", "notes.md", mtime1, 1024),
      makeFakeFileNode("uid-2", "photo.jpg", mtime2, 2048, {
        claimedModificationTime: new Date("2026-04-10T12:00:00.000Z"),
        claimedSize: 3000,
      }),
    ]);
    const sdk = makeFakeSdk({ iterateFolderChildren: iterFn });
    const client = new DriveClient(sdk);

    const result = await client.listRemoteFiles("parent-uid");

    expect(result.length).toBe(2);
    expect(result[0]).toEqual({
      id: "uid-1",
      name: "notes.md",
      parent_id: "parent-uid",
      remote_mtime: mtime1.toISOString(),
      size: 1024,
    });
    // Second node has activeRevision — claimedModificationTime and claimedSize take priority
    expect(result[1]).toEqual({
      id: "uid-2",
      name: "photo.jpg",
      parent_id: "parent-uid",
      remote_mtime: new Date("2026-04-10T12:00:00.000Z").toISOString(),
      size: 3000,
    });
  });

  it("skips DegradedNode entries (ok === false)", async () => {
    const mtime = new Date("2026-04-10T10:00:00.000Z");
    const iterFn = asyncGenOf([
      makeFakeFileNode("uid-ok", "file.txt", mtime, 100),
      makeDegradedNode(),
      makeFakeFileNode("uid-ok2", "file2.txt", mtime, 200),
    ]);
    const sdk = makeFakeSdk({ iterateFolderChildren: iterFn });
    const client = new DriveClient(sdk);

    const result = await client.listRemoteFiles("parent-uid");

    expect(result.length).toBe(2);
    expect(result.map((r) => r.id)).toEqual(["uid-ok", "uid-ok2"]);
  });

  it("skips non-File node types (server-side filter is a hint only)", async () => {
    const mtime = new Date("2026-04-10T10:00:00.000Z");
    const iterFn = asyncGenOf([
      makeFakeFileNode("uid-file", "real.txt", mtime, 100),
      makeFakeNode("uid-folder", "subfolder", NODE_TYPE_FOLDER, "parent-uid"),
    ]);
    const sdk = makeFakeSdk({ iterateFolderChildren: iterFn });
    const client = new DriveClient(sdk);

    const result = await client.listRemoteFiles("parent-uid");

    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe("uid-file");
  });

  it("throws NetworkError on SDK ConnectionError", async () => {
    async function* throwingGen(): AsyncGenerator<FakeMaybeNode> {
      throw sdkErrorFactoriesForTests.connection("network failure");
    }
    const sdk = makeFakeSdk({ iterateFolderChildren: mock(throwingGen) });
    const client = new DriveClient(sdk);

    await expect(client.listRemoteFiles("parent-uid")).rejects.toBeInstanceOf(NetworkError);
  });

  it("throws SyncError on SDK IntegrityError", async () => {
    async function* throwingGen(): AsyncGenerator<FakeMaybeNode> {
      throw sdkErrorFactoriesForTests.integrity("decryption failed");
    }
    const sdk = makeFakeSdk({ iterateFolderChildren: mock(throwingGen) });
    const client = new DriveClient(sdk);

    await expect(client.listRemoteFiles("parent-uid")).rejects.toBeInstanceOf(SyncError);
  });

  it("passes { type: NodeType.File } filter hint to iterateFolderChildren", async () => {
    const iterFn = asyncGenOf([]);
    const sdk = makeFakeSdk({ iterateFolderChildren: iterFn });
    const client = new DriveClient(sdk);

    await client.listRemoteFiles("parent-uid");

    expect(iterFn.mock.calls.length).toBe(1);
    const filterArg = iterFn.mock.calls[0]![1] as { type?: string } | undefined;
    expect(filterArg).toBeTruthy();
    expect(filterArg!.type).toBe(NODE_TYPE_FILE);
  });
});

// ===========================================================================
// Story 2.2.5 — SDK live wiring tests (AC11)
// ===========================================================================

describe("createDriveClient factory", () => {
  it("returns a DriveClient instance", () => {
    const client = createDriveClient("fake-bearer-token");
    expect(client instanceof DriveClient).toBeTruthy();
  });
});

describe("ProtonHTTPClient via createDriveClient", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockedFetch: ReturnType<typeof mock>;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
    // validateSession now calls GET /core/v4/users (works with "locked" scope).
    mockedFetch = mock(async () =>
      new Response(
        JSON.stringify({
          User: { Email: "test@proton.me", DisplayName: "Test User" },
          Code: 1000,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    // @ts-expect-error — replacing global fetch for test isolation
    globalThis.fetch = mockedFetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("injects Authorization: Bearer <token> header on validateSession fetch", async () => {
    const token = "test-bearer-xyz";
    const client = createDriveClient(token);

    await client.validateSession();

    expect(mockedFetch.mock.calls.length >= 1).toBeTruthy();
    const call = mockedFetch.mock.calls[0]!;
    const init = call[1] as RequestInit;
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
  });

  it("applies AbortSignal.timeout when no signal is provided", async () => {
    mockedFetch.mockClear();

    const client = createDriveClient("token-timeout-test");
    await client.validateSession();

    expect(mockedFetch.mock.calls.length >= 1).toBeTruthy();
    const init = mockedFetch.mock.calls[0]![1] as RequestInit;
    expect(init.signal !== undefined).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// DriveClient.validateSession (AC11 + Story 2.11: uses GET /core/v4/users)
// ---------------------------------------------------------------------------
describe("DriveClient.validateSession", () => {
  it("returns AccountInfo with correct shape when adapter.getUser() succeeds", async () => {
    const mockAdapter = {
      getUser: mock(async () => ({
        email: "alice@proton.me",
        display_name: "Alice",
      })),
    };

    const sdk = makeFakeSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new DriveClient(sdk, undefined, mockAdapter as any);

    const info = await client.validateSession();

    expect(info.email).toBe("alice@proton.me");
    expect(info.display_name).toBe("Alice");
    expect(info.storage_used).toBe(0);
    expect(info.storage_total).toBe(0);
    expect(info.plan).toBe("");
  });

  it("throws SyncError when account adapter is not wired", async () => {
    const sdk = makeFakeSdk();
    const client = new DriveClient(sdk); // no adapter args

    let captured: unknown;
    try {
      await client.validateSession();
      expect(true).toBe(false);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SyncError);
    expect((captured as Error).message).toMatch(/account adapter not wired/);
  });

  it("wraps adapter errors through mapSdkError", async () => {
    const mockAdapter = {
      getUser: mock(async () => {
        throw sdkErrorFactoriesForTests.connection("users fetch failed");
      }),
    };

    const sdk = makeFakeSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new DriveClient(sdk, undefined, mockAdapter as any);

    await expect(client.validateSession()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// ProtonOpenPGPCryptoProxy round-trip test (AC11)
// ---------------------------------------------------------------------------
describe("ProtonOpenPGPCryptoProxy openpgp round-trip", () => {
  it("generateKey → exportPrivateKey → importPrivateKey round-trip", async () => {
    const result = await openpgp.generateKey({
      type: "ecc",
      curve: "ed25519Legacy",
      userIDs: [{ email: "roundtrip@test.example" }],
      format: "object",
    });
    const privateKey = result.privateKey;
    const originalFingerprint = privateKey.getFingerprint();

    const armored = privateKey.armor();
    expect(armored.startsWith("-----BEGIN PGP PRIVATE KEY BLOCK-----")).toBeTruthy();

    const readBack = await openpgp.readPrivateKey({ armoredKey: armored });
    expect(readBack.getFingerprint()).toBe(originalFingerprint);
    expect(readBack.isDecrypted()).toBeTruthy();
  });

  it("createDriveClient constructs successfully with real openpgp proxy wired", () => {
    const client = createDriveClient("round-trip-token");
    expect(client instanceof DriveClient).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// DriveClient.deriveAndUnlock + applyKeyPassword (Story 2.11, AC1-AC3, AC5)
// ---------------------------------------------------------------------------
describe("DriveClient.deriveAndUnlock", () => {
  // deriveAndUnlock delegates entirely to accountAdapter.fetchAndDecryptAllKeys,
  // which handles salt fetch, bcrypt derivation, and key decryption internally.
  function makeMockAdapter(options: {
    returnValue?: string;
    shouldFail?: boolean;
  }) {
    return {
      fetchAndDecryptAllKeys: mock(async (_password: string, _salts?: unknown) => {
        if (options.shouldFail) throw new Error("wrong passphrase");
        return options.returnValue ?? "";
      }),
      getUser: mock(async () => ({ email: "u@p.me", display_name: "U" })),
    };
  }

  it("throws SyncError when accountAdapter is not wired", async () => {
    const sdk = makeFakeSdk();
    const client = new DriveClient(sdk); // no adapter

    let captured: unknown;
    try {
      await client.deriveAndUnlock("secret");
      expect(true).toBe(false);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SyncError);
    expect((captured as Error).message).toMatch(/account adapter not wired/);
  });

  it("returns empty string keyPassword for SSO account (fetchAndDecryptAllKeys returns '')", async () => {
    const adapter = makeMockAdapter({ returnValue: "" });
    const sdk = makeFakeSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new DriveClient(sdk, undefined, adapter as any);

    const keyPassword = await client.deriveAndUnlock("any-password");

    expect(keyPassword).toBe("");
    expect(adapter.fetchAndDecryptAllKeys.mock.calls.length).toBe(1);
  });

  it("returns the keyPassword from fetchAndDecryptAllKeys for normal accounts", async () => {
    const fakeKeyPassword = "a".repeat(31); // 31-char bcrypt hash suffix shape
    const adapter = makeMockAdapter({ returnValue: fakeKeyPassword });
    const sdk = makeFakeSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new DriveClient(sdk, undefined, adapter as any);

    const keyPassword = await client.deriveAndUnlock("hunter2");

    expect(typeof keyPassword).toBe("string");
    expect(keyPassword.length).toBe(31);
    expect(adapter.fetchAndDecryptAllKeys.mock.calls.length).toBe(1);
    expect(adapter.fetchAndDecryptAllKeys.mock.calls[0]![0]).toBe("hunter2");
  });

  it("propagates error when fetchAndDecryptAllKeys fails (wrong password)", async () => {
    const adapter = makeMockAdapter({ shouldFail: true });
    const sdk = makeFakeSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new DriveClient(sdk, undefined, adapter as any);

    await expect(client.deriveAndUnlock("wrong-password")).rejects.toBeInstanceOf(Error);
  });
});

describe("DriveClient.applyKeyPassword", () => {
  it("throws SyncError when accountAdapter is not wired", async () => {
    const sdk = makeFakeSdk();
    const client = new DriveClient(sdk);

    let captured: unknown;
    try {
      await client.applyKeyPassword("some-key-password");
      expect(true).toBe(false);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SyncError);
    expect((captured as Error).message).toMatch(/account adapter not wired/);
  });

  it("skips fetchAndDecryptKeys for empty keyPassword (SSO account)", async () => {
    const adapter = {
      fetchAndDecryptKeys: mock(async () => {}),
    };
    const sdk = makeFakeSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new DriveClient(sdk, undefined, adapter as any);

    await client.applyKeyPassword("");

    expect(adapter.fetchAndDecryptKeys.mock.calls.length).toBe(0);
  });

  it("calls fetchAndDecryptKeys with the given keyPassword", async () => {
    const adapter = {
      fetchAndDecryptKeys: mock(async () => {}),
    };
    const sdk = makeFakeSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new DriveClient(sdk, undefined, adapter as any);

    await client.applyKeyPassword("$2y$10$somebcrypthash");

    expect(adapter.fetchAndDecryptKeys.mock.calls.length).toBe(1);
    expect(adapter.fetchAndDecryptKeys.mock.calls[0]![0]).toBe("$2y$10$somebcrypthash");
  });

  it("propagates errors from fetchAndDecryptKeys (stored keyPassword invalid)", async () => {
    const adapter = {
      fetchAndDecryptKeys: mock(async () => {
        throw new Error("Key decryption failed");
      }),
    };
    const sdk = makeFakeSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new DriveClient(sdk, undefined, adapter as any);

    await expect(client.applyKeyPassword("$2y$10$stale")).rejects.toBeInstanceOf(Error);
  });
});
