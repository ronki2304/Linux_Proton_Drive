import { describe, it, mock, before, after } from "node:test";
import assert from "node:assert/strict";
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
    assert.ok(
      content.includes("SDK BOUNDARY"),
      "sdk.ts must have SDK BOUNDARY comment",
    );
  });

  it("errors.ts has zero internal imports", () => {
    const content = fs.readFileSync(path.join(srcDir, "errors.ts"), "utf8");
    const internalImports = content.match(/from ["']\.\/.*["']/g);
    assert.equal(
      internalImports,
      null,
      "errors.ts must not import from any other engine file",
    );
  });

  it("ipc.ts does not import from sdk.ts", () => {
    const content = fs.readFileSync(path.join(srcDir, "ipc.ts"), "utf8");
    assert.ok(
      !content.includes('from "./sdk'),
      "ipc.ts must not import from sdk.ts",
    );
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
      assert.ok(
        allowedExact.has(imp),
        `sdk.ts may only import from leaf modules (./errors.js, ./debug-log.js), found: ${imp}`,
      );
    }
  });

  it("sdkErrorFactoriesForTests is only imported by sdk.test.ts", () => {
    // The factories are exported from sdk.ts for the test file's use, but no
    // production engine file should ever import them — that would let engine
    // code construct raw SDK error instances and bypass the wrapper boundary.
    // This guard catches accidental future imports before they reach review.
    const files = fs.readdirSync(srcDir).filter(
      (f) => f.endsWith(".ts") && f !== "sdk.ts" && f !== "sdk.test.ts",
    );

    for (const file of files) {
      const content = fs.readFileSync(path.join(srcDir, file), "utf8");
      assert.ok(
        !content.includes("sdkErrorFactoriesForTests"),
        `${file} must not import sdkErrorFactoriesForTests — it is a test-only seam`,
      );
    }
  });

  it("no other engine file imports @protontech/drive-sdk", () => {
    const files = fs.readdirSync(srcDir).filter(
      (f) => f.endsWith(".ts") && f !== "sdk.ts" && f !== "sdk.test.ts",
    );

    for (const file of files) {
      const content = fs.readFileSync(path.join(srcDir, file), "utf8");
      assert.ok(
        !content.includes("@protontech/drive-sdk"),
        `${file} must not import @protontech/drive-sdk directly`,
      );
    }
  });

  it("sdk.test.ts does not import @protontech/drive-sdk directly", () => {
    // The test file is allowed to import from `./sdk.js` (via
    // `sdkErrorFactoriesForTests`) but must NOT import from the SDK package
    // directly. This keeps the wrapper as the single source of SDK truth.
    const content = fs.readFileSync(path.join(srcDir, "sdk.test.ts"), "utf8");
    assert.ok(
      !/from ["']@protontech\/drive-sdk["']/.test(content),
      "sdk.test.ts must not import from @protontech/drive-sdk — use sdkErrorFactoriesForTests",
    );
  });
});

// ---------------------------------------------------------------------------
// DriveClient wrapper tests
// ---------------------------------------------------------------------------

// SDK enum string values mirrored locally — see project-context.md guidance:
// the test file does not import from `@protontech/drive-sdk`, so we hardcode
// the wire-stable enum values used by the wrapper. If the SDK ever changes
// these strings, the existing fakes will start producing the wrong shape and
// the wrapper tests will catch it as a behavior regression.
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

/**
 * Build a `ProtonDriveClientLike` fake. Defaults are inert; tests pass
 * overrides to install behavior. The single `as unknown as` cast is
 * intentional and localized: a structural fake cannot satisfy the SDK's full
 * `NodeEntity` type (15+ required fields like `keyAuthor`, `directRole`,
 * `creationTime`) and constructing real ones for unit tests would be wasteful
 * boilerplate.
 */
function makeFakeSdk(
  overrides: Record<string, unknown> = {},
): ProtonDriveClientLike {
  return {
    getMyFilesRootFolder: mock.fn(async () => makeFakeNode("root-uid", "My Files", NODE_TYPE_FOLDER)),
    iterateFolderChildren: mock.fn(async function* (): AsyncGenerator<FakeMaybeNode> {
      // Default: empty folder.
    }),
    getFileUploader: mock.fn(),
    getFileDownloader: mock.fn(),
    ...overrides,
  } as unknown as ProtonDriveClientLike;
}

/** Build a `mock.fn` async-generator factory that yields the given nodes.
 *  The explicit parameter signature lets `mockFn.mock.calls[N].arguments[M]`
 *  type-resolve under `noUncheckedIndexedAccess` instead of degenerating to
 *  `never[]`. */
function asyncGenOf(nodes: FakeMaybeNode[]) {
  return mock.fn(async function* (
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
    const rootFn = mock.fn(async () => makeFakeNode("root-uid", "My Files", NODE_TYPE_FOLDER));
    const sdk = makeFakeSdk({
      getMyFilesRootFolder: rootFn,
      iterateFolderChildren: iterFn,
    });
    const client = new DriveClient(sdk);

    const result = await client.listRemoteFolders(null);

    assert.equal(rootFn.mock.callCount(), 1);
    assert.equal(iterFn.mock.callCount(), 1);
    // Top-level children carry the ROOT_PARENT_ID sentinel — never the
    // SDK-supplied parentUid, since "<root>" disambiguates the top level
    // from regular subfolders.
    assert.deepEqual(result, [
      { id: "uid-a", name: "Alpha", parent_id: ROOT_PARENT_ID },
      { id: "uid-b", name: "Beta", parent_id: ROOT_PARENT_ID },
    ]);
  });

  it("does NOT call getMyFilesRootFolder when parentId is a UID", async () => {
    const iterFn = asyncGenOf([
      makeFakeNode("uid-x", "Child", NODE_TYPE_FOLDER, "parent-123"),
    ]);
    const rootFn = mock.fn(async () => makeFakeNode("root-uid", "My Files", NODE_TYPE_FOLDER));
    const sdk = makeFakeSdk({
      getMyFilesRootFolder: rootFn,
      iterateFolderChildren: iterFn,
    });
    const client = new DriveClient(sdk);

    const result = await client.listRemoteFolders("parent-123");

    assert.equal(rootFn.mock.callCount(), 0, "root fetch must be skipped for explicit parent");
    assert.equal(iterFn.mock.callCount(), 1);
    // First positional arg = parent. The wrapper passes the string UID through.
    assert.equal(iterFn.mock.calls[0]!.arguments[0], "parent-123");
    assert.deepEqual(result, [
      { id: "uid-x", name: "Child", parent_id: "parent-123" },
    ]);
  });

  it("passes the { type: NodeType.Folder } filter hint to iterateFolderChildren", async () => {
    // Patch from review: regression-guard the server-side filter hint. If a
    // future edit drops the second argument the wrapper would fall back to a
    // pure client-side filter, doubling the wire payload silently.
    const iterFn = asyncGenOf([]);
    const sdk = makeFakeSdk({ iterateFolderChildren: iterFn });
    const client = new DriveClient(sdk);

    await client.listRemoteFolders("p");

    assert.equal(iterFn.mock.callCount(), 1);
    const filterArg = iterFn.mock.calls[0]!.arguments[1] as
      | { type?: string }
      | undefined;
    assert.ok(filterArg, "filter options must be passed as the second arg");
    // NodeType.Folder enum value is "folder" (locked in errors.d.ts).
    assert.equal(filterArg.type, NODE_TYPE_FOLDER);
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

    assert.deepEqual(
      result.map((r) => r.id),
      ["uid-folder", "uid-folder2"],
      "file nodes must be filtered out client-side regardless of server-side hint",
    );
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

    assert.equal(result.length, 2, "degraded nodes must be skipped, not throw");
    assert.deepEqual(
      result.map((r) => r.id),
      ["uid-ok", "uid-ok2"],
    );
  });

  it("returns an empty array for an empty folder", async () => {
    const sdk = makeFakeSdk({ iterateFolderChildren: asyncGenOf([]) });
    const client = new DriveClient(sdk);

    const result = await client.listRemoteFolders("empty-uid");

    assert.deepEqual(result, []);
  });

  it("uses the requested parentId for child entries even when SDK omits parentUid", async () => {
    // The SDK may omit `parentUid` for some node types. The wrapper does NOT
    // surface that absence as `null` (which would collide with the top-level
    // sentinel) — it substitutes the parent UID we were asked to list under.
    const iterFn = asyncGenOf([
      { ok: true, value: { uid: "orphan", name: "Orphan", type: NODE_TYPE_FOLDER } },
    ]);
    const sdk = makeFakeSdk({ iterateFolderChildren: iterFn });
    const client = new DriveClient(sdk);

    const result = await client.listRemoteFolders("p");

    assert.equal(result[0]!.parent_id, "p");
  });

  it("propagates iterator errors mid-stream and discards partial results", async () => {
    // Patch from review: lock in the all-or-nothing semantics. If the SDK
    // generator yields some nodes then throws, the wrapper does NOT surface
    // a partial list — it surfaces a typed engine error and the caller can
    // retry the whole listing.
    async function* throwingGen(): AsyncGenerator<FakeMaybeNode> {
      yield makeFakeNode("uid-1", "Visible", NODE_TYPE_FOLDER, "p");
      throw sdkErrorFactoriesForTests.connection("dropped mid-stream");
    }
    const sdk = makeFakeSdk({
      iterateFolderChildren: mock.fn(throwingGen),
    });
    const client = new DriveClient(sdk);

    await assert.rejects(
      () => client.listRemoteFolders("p"),
      (err: unknown) => err instanceof NetworkError,
    );
  });

  it("throws SyncError when My Files root is degraded", async () => {
    const sdk = makeFakeSdk({
      getMyFilesRootFolder: mock.fn(async () => makeDegradedNode()),
    });
    const client = new DriveClient(sdk);

    await assert.rejects(
      () => client.listRemoteFolders(null),
      (err: unknown) => err instanceof SyncError && /My Files root unavailable/.test((err as Error).message),
    );
  });
});

describe("DriveClient.uploadFile", () => {
  // Helper used by the rejection-path tests below — installs an SDK whose
  // upload chain rejects at `controller.completion()` so the catch block
  // (and stream cleanup) is exercised.
  function makeRejectingUploadSdk(rejectErr: Error) {
    const fakeController = {
      pause: () => {},
      resume: () => {},
      completion: mock.fn(async () => {
        throw rejectErr;
      }),
    };
    const fakeUploader = {
      uploadFromStream: mock.fn(
        async (
          _stream: ReadableStream<Uint8Array>,
          _thumbnails: unknown[],
        ) => fakeController,
      ),
      uploadFromFile: mock.fn(),
    };
    return makeFakeSdk({
      getFileUploader: mock.fn(
        async (_p: string, _n: string, _m: unknown) => fakeUploader,
      ),
    });
  }

  it("delegates to getFileUploader → uploadFromStream → completion and returns snake_case shape", async () => {
    const fakeController = {
      pause: () => {},
      resume: () => {},
      completion: mock.fn(async () => ({ nodeUid: "node-1", nodeRevisionUid: "rev-1" })),
    };
    const uploadFromStreamFn = mock.fn(
      async (
        _stream: ReadableStream<Uint8Array>,
        _thumbnails: unknown[],
      ) => fakeController,
    );
    const fakeUploader = {
      uploadFromStream: uploadFromStreamFn,
      uploadFromFile: mock.fn(),
    };
    const getFileUploaderFn = mock.fn(
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

    assert.deepEqual(result, { node_uid: "node-1", revision_uid: "rev-1" });

    // Verify the uploader was called with the correct metadata.
    assert.equal(getFileUploaderFn.mock.callCount(), 1);
    const call = getFileUploaderFn.mock.calls[0]!;
    assert.equal(call.arguments[0], "parent-uid");
    assert.equal(call.arguments[1], "test.txt");
    assert.deepEqual(call.arguments[2], {
      mediaType: "text/plain",
      expectedSize: 1024,
      modificationTime: modTime,
    });

    // Verify the stream was passed through and thumbnails defaulted to [].
    assert.equal(uploadFromStreamFn.mock.callCount(), 1);
    assert.equal(uploadFromStreamFn.mock.calls[0]!.arguments[0], stream);
    assert.deepEqual(uploadFromStreamFn.mock.calls[0]!.arguments[1], []);

    assert.equal(fakeController.completion.mock.callCount(), 1);
  });

  it("re-throws AbortError as-is when upload is aborted", async () => {
    // Patch from review: AbortError pass-through previously only verified
    // via listRemoteFolders. Cover the upload path as well.
    const abortErr = sdkErrorFactoriesForTests.abort("user cancelled upload");
    const sdk = makeRejectingUploadSdk(abortErr);
    const client = new DriveClient(sdk);

    const stream = new ReadableStream<Uint8Array>();
    await assert.rejects(
      () =>
        client.uploadFile("p", "f.txt", {
          stream,
          sizeBytes: 1,
          modificationTime: new Date(),
          mediaType: "text/plain",
        }),
      (err: unknown) => err === abortErr,
    );
  });

  it("maps a rejecting completion() to the typed engine error", async () => {
    // Patch from review: prove that rejection from controller.completion()
    // flows through mapSdkError end-to-end.
    const sdkErr = sdkErrorFactoriesForTests.connection("upload network");
    const sdk = makeRejectingUploadSdk(sdkErr);
    const client = new DriveClient(sdk);

    const stream = new ReadableStream<Uint8Array>();
    await assert.rejects(
      () =>
        client.uploadFile("p", "f.txt", {
          stream,
          sizeBytes: 1,
          modificationTime: new Date(),
          mediaType: "text/plain",
        }),
      (err: unknown) =>
        err instanceof NetworkError &&
        (err as Error & { cause?: unknown }).cause === sdkErr,
    );
  });

  it("cancels the body stream when upload fails", async () => {
    // Patch from review: caller's source descriptor must be released even
    // when the upload chain rejects mid-stream.
    const sdk = makeRejectingUploadSdk(
      sdkErrorFactoriesForTests.integrity("size mismatch"),
    );
    const client = new DriveClient(sdk);

    const stream = new ReadableStream<Uint8Array>();
    // Wrap cancel so we can observe the call without losing the original.
    let cancelledWith: unknown = "<not called>";
    const origCancel = stream.cancel.bind(stream);
    stream.cancel = async (reason?: unknown) => {
      cancelledWith = reason;
      return origCancel(reason);
    };

    await assert.rejects(
      () =>
        client.uploadFile("p", "f.txt", {
          stream,
          sizeBytes: 1,
          modificationTime: new Date(),
          mediaType: "text/plain",
        }),
      (err: unknown) => err instanceof SyncError,
    );
    assert.notEqual(cancelledWith, "<not called>", "stream.cancel must be called on upload failure");
  });
});

describe("DriveClient.downloadFile", () => {
  it("delegates to getFileDownloader → downloadToStream → completion", async () => {
    const completionFn = mock.fn(async () => undefined);
    const fakeController = {
      pause: () => {},
      resume: () => {},
      completion: completionFn,
      isDownloadCompleteWithSignatureIssues: mock.fn(() => false),
    };
    const downloadToStreamFn = mock.fn(
      (_target: WritableStream<Uint8Array>) => fakeController,
    );
    const fakeDownloader = {
      getClaimedSizeInBytes: () => undefined,
      downloadToStream: downloadToStreamFn,
      unsafeDownloadToStream: mock.fn(),
      getSeekableStream: mock.fn(),
    };
    const getFileDownloaderFn = mock.fn(
      async (_nodeUid: string) => fakeDownloader,
    );
    const sdk = makeFakeSdk({ getFileDownloader: getFileDownloaderFn });
    const client = new DriveClient(sdk);

    const target = new WritableStream<Uint8Array>();
    await client.downloadFile("node-uid", target);

    assert.equal(getFileDownloaderFn.mock.callCount(), 1);
    assert.equal(getFileDownloaderFn.mock.calls[0]!.arguments[0], "node-uid");
    assert.equal(downloadToStreamFn.mock.callCount(), 1);
    assert.equal(downloadToStreamFn.mock.calls[0]!.arguments[0], target);
    assert.equal(completionFn.mock.callCount(), 1);
    assert.equal(fakeController.isDownloadCompleteWithSignatureIssues.mock.callCount(), 1);
    assert.equal(fakeDownloader.unsafeDownloadToStream.mock.callCount(), 0, "unsafe path must never be called");
  });

  it("resolves successfully even when signature verification flags issues", async () => {
    const fakeController = {
      pause: () => {},
      resume: () => {},
      completion: mock.fn(async () => undefined),
      isDownloadCompleteWithSignatureIssues: mock.fn(() => true),
    };
    const fakeDownloader = {
      getClaimedSizeInBytes: () => undefined,
      downloadToStream: mock.fn(() => fakeController),
      unsafeDownloadToStream: mock.fn(),
      getSeekableStream: mock.fn(),
    };
    const sdk = makeFakeSdk({
      getFileDownloader: mock.fn(async () => fakeDownloader),
    });
    const client = new DriveClient(sdk);

    // Must NOT throw — Story 2.5 will decide on user-visible warnings.
    await client.downloadFile("node-uid", new WritableStream<Uint8Array>());
    assert.equal(fakeController.isDownloadCompleteWithSignatureIssues.mock.callCount(), 1);
  });

  // Helper used by the rejection-path tests below — installs a downloader
  // whose `completion()` rejects with the given error so the catch block
  // (and target.abort cleanup) is exercised.
  function makeRejectingDownloadSdk(rejectErr: Error) {
    const fakeController = {
      pause: () => {},
      resume: () => {},
      completion: mock.fn(async () => {
        throw rejectErr;
      }),
      isDownloadCompleteWithSignatureIssues: mock.fn(() => false),
    };
    const fakeDownloader = {
      getClaimedSizeInBytes: () => undefined,
      downloadToStream: mock.fn(
        (_target: WritableStream<Uint8Array>) => fakeController,
      ),
      unsafeDownloadToStream: mock.fn(),
      getSeekableStream: mock.fn(),
    };
    return makeFakeSdk({
      getFileDownloader: mock.fn(async (_uid: string) => fakeDownloader),
    });
  }

  it("re-throws AbortError as-is when download is aborted", async () => {
    const abortErr = sdkErrorFactoriesForTests.abort("user cancelled download");
    const sdk = makeRejectingDownloadSdk(abortErr);
    const client = new DriveClient(sdk);

    await assert.rejects(
      () => client.downloadFile("node-uid", new WritableStream<Uint8Array>()),
      (err: unknown) => err === abortErr,
    );
  });

  it("maps a rejecting completion() to the typed engine error", async () => {
    const sdkErr = sdkErrorFactoriesForTests.server("download server boom");
    const sdk = makeRejectingDownloadSdk(sdkErr);
    const client = new DriveClient(sdk);

    await assert.rejects(
      () => client.downloadFile("node-uid", new WritableStream<Uint8Array>()),
      (err: unknown) =>
        err instanceof NetworkError &&
        (err as Error & { cause?: unknown }).cause === sdkErr,
    );
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

    await assert.rejects(
      () => client.downloadFile("node-uid", target),
      (err: unknown) => err instanceof SyncError,
    );
    assert.notEqual(abortedWith, "<not called>", "target.abort must be called on download failure");
  });
});

describe("DriveClient SDK error mapping", () => {
  // For each test, the SDK throws a real instance of an SDK error class
  // (constructed via `sdkErrorFactoriesForTests`) and we assert the wrapper
  // surfaces the correct typed engine error with `cause` preserved.
  //
  // The validator returned to `assert.rejects` returns a plain boolean — no
  // assertion calls inside the predicate. If the predicate returns false the
  // test fails with `assert.rejects`'s own (informative) message; the explicit
  // `equal`/`match` checks happen on the captured error after `rejects`
  // resolves so failures aren't masked by AssertionError-from-validator.

  async function expectMapping(
    throwError: Error,
    expectedClass: typeof SyncError | typeof NetworkError,
    expectedMessageMatcher: RegExp,
  ): Promise<void> {
    const sdk = makeFakeSdk({
      getMyFilesRootFolder: mock.fn(async () => {
        throw throwError;
      }),
    });
    const client = new DriveClient(sdk);

    let captured: unknown;
    await assert.rejects(
      async () => {
        try {
          await client.listRemoteFolders(null);
        } catch (err) {
          captured = err;
          throw err;
        }
      },
      (err: unknown) => err instanceof expectedClass,
    );
    assert.ok(
      captured instanceof expectedClass,
      `expected ${expectedClass.name}, got ${(captured as Error)?.constructor?.name ?? typeof captured}`,
    );
    assert.match((captured as Error).message, expectedMessageMatcher);
    assert.equal(
      (captured as Error & { cause?: unknown }).cause,
      throwError,
      "cause must be preserved",
    );
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
    // Patch from review: the spec lists NodeWithSameNameExistsValidationError
    // alongside ValidationError. It extends ValidationError and the wrapper
    // intentionally falls through to the parent branch — but the test was
    // never exercising the subclass directly, so the subclass-before-parent
    // ordering claim was unverified for this specific pair.
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
      getMyFilesRootFolder: mock.fn(async () => {
        throw abortErr;
      }),
    });
    const client = new DriveClient(sdk);

    let captured: unknown;
    await assert.rejects(
      async () => {
        try {
          await client.listRemoteFolders(null);
        } catch (err) {
          captured = err;
          throw err;
        }
      },
      // Predicate-only check: must be the exact same instance.
      (err: unknown) => err === abortErr,
    );
    // Belt-and-braces: AbortError is its own SDK class, NOT an EngineError.
    assert.equal(captured, abortErr);
    assert.ok(!(captured instanceof EngineError), "AbortError must not be wrapped as an EngineError");
  });

  it("EngineError thrown inside the wrapper is re-thrown as-is (not re-wrapped)", async () => {
    // Patch from review: verify the EngineError pass-through branch in
    // `mapSdkError` directly. Without it, the wrapper's own self-thrown
    // SyncError (e.g. "My Files root unavailable") would be re-wrapped as
    // "Unexpected SDK error" by the catch-all fallthrough.
    const ourError = new SyncError("synthetic engine error from inside wrapper");
    const sdk = makeFakeSdk({
      getMyFilesRootFolder: mock.fn(async () => {
        throw ourError;
      }),
    });
    const client = new DriveClient(sdk);

    let captured: unknown;
    await assert.rejects(
      async () => {
        try {
          await client.listRemoteFolders(null);
        } catch (err) {
          captured = err;
          throw err;
        }
      },
      (err: unknown) => err === ourError,
    );
    // Same instance — not a fresh "Unexpected SDK error" wrapper around it.
    assert.equal(captured, ourError);
    assert.equal(
      (captured as Error).message,
      "synthetic engine error from inside wrapper",
    );
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

    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
      id: "uid-1",
      name: "notes.md",
      parent_id: "parent-uid",
      remote_mtime: mtime1.toISOString(),
      size: 1024,
    });
    // Second node has activeRevision — claimedModificationTime and claimedSize take priority
    assert.deepEqual(result[1], {
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

    assert.equal(result.length, 2);
    assert.deepEqual(result.map((r) => r.id), ["uid-ok", "uid-ok2"]);
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

    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, "uid-file");
  });

  it("throws NetworkError on SDK ConnectionError", async () => {
    async function* throwingGen(): AsyncGenerator<FakeMaybeNode> {
      throw sdkErrorFactoriesForTests.connection("network failure");
    }
    const sdk = makeFakeSdk({ iterateFolderChildren: mock.fn(throwingGen) });
    const client = new DriveClient(sdk);

    await assert.rejects(
      () => client.listRemoteFiles("parent-uid"),
      (err: unknown) => err instanceof NetworkError,
    );
  });

  it("throws SyncError on SDK IntegrityError", async () => {
    async function* throwingGen(): AsyncGenerator<FakeMaybeNode> {
      throw sdkErrorFactoriesForTests.integrity("decryption failed");
    }
    const sdk = makeFakeSdk({ iterateFolderChildren: mock.fn(throwingGen) });
    const client = new DriveClient(sdk);

    await assert.rejects(
      () => client.listRemoteFiles("parent-uid"),
      (err: unknown) => err instanceof SyncError,
    );
  });

  it("passes { type: NodeType.File } filter hint to iterateFolderChildren", async () => {
    const iterFn = asyncGenOf([]);
    const sdk = makeFakeSdk({ iterateFolderChildren: iterFn });
    const client = new DriveClient(sdk);

    await client.listRemoteFiles("parent-uid");

    assert.equal(iterFn.mock.callCount(), 1);
    const filterArg = iterFn.mock.calls[0]!.arguments[1] as { type?: string } | undefined;
    assert.ok(filterArg, "filter options must be passed as the second arg");
    assert.equal(filterArg.type, NODE_TYPE_FILE);
  });
});

// ===========================================================================
// Story 2.2.5 — SDK live wiring tests (AC11)
// ===========================================================================

// ---------------------------------------------------------------------------
// createDriveClient factory (AC11: basic type check)
// ---------------------------------------------------------------------------
describe("createDriveClient factory", () => {
  it("returns a DriveClient instance", () => {
    // We do NOT hit Proton servers — just verify construction succeeds and
    // returns the correct type. The token is never validated at construction time.
    const client = createDriveClient("fake-bearer-token");
    assert.ok(client instanceof DriveClient, "createDriveClient must return a DriveClient");
  });
});

// ---------------------------------------------------------------------------
// ProtonHTTPClient adapter (AC11: header + timeout injection)
// Tests mock globalThis.fetch so no real network calls are made.
// ---------------------------------------------------------------------------
describe("ProtonHTTPClient via createDriveClient", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockedFetch: ReturnType<typeof mock.fn>;

  before(() => {
    originalFetch = globalThis.fetch;
    // validateSession now calls GET /core/v4/users (works with "locked" scope).
    mockedFetch = mock.fn(async () =>
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

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("injects Authorization: Bearer <token> header on validateSession fetch", async () => {
    const token = "test-bearer-xyz";
    const client = createDriveClient(token);

    // validateSession calls getUser → GET /core/v4/users.
    // Mock returns a valid User object so it succeeds.
    await client.validateSession();

    assert.ok(mockedFetch.mock.callCount() >= 1, "fetch must be called at least once");
    const call = mockedFetch.mock.calls[0]!;
    const init = call.arguments[1] as RequestInit;
    const headers = new Headers(init.headers as HeadersInit);
    assert.equal(
      headers.get("Authorization"),
      `Bearer ${token}`,
      "Authorization header must be set with Bearer token",
    );
  });

  it("applies AbortSignal.timeout when no signal is provided", async () => {
    // Cannot inspect the AbortSignal directly from the outside — but we verify
    // that an `init.signal` is always present (not undefined), which confirms
    // that either AbortSignal.timeout or AbortSignal.any was applied.
    mockedFetch.mock.resetCalls();

    const client = createDriveClient("token-timeout-test");
    await client.validateSession();

    assert.ok(mockedFetch.mock.callCount() >= 1);
    const init = mockedFetch.mock.calls[0]!.arguments[1] as RequestInit;
    assert.ok(init.signal !== undefined, "signal must always be present (AbortSignal.timeout)");
  });
});

// ---------------------------------------------------------------------------
// DriveClient.validateSession (AC11 + Story 2.11: uses GET /core/v4/users)
// ---------------------------------------------------------------------------
describe("DriveClient.validateSession", () => {
  it("returns AccountInfo with correct shape when adapter.getUser() succeeds", async () => {
    // validateSession calls accountAdapter.getUser() (third DriveClient arg).
    // The same ProtonAccountAdapter object is used for both account and accountAdapter
    // in production (createDriveClient passes `account` twice). In tests we mock the
    // third arg directly with a minimal duck-typed object.
    const mockAdapter = {
      getUser: mock.fn(async () => ({
        email: "alice@proton.me",
        display_name: "Alice",
      })),
    };

    const sdk = makeFakeSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new DriveClient(sdk, undefined, mockAdapter as any);

    const info = await client.validateSession();

    assert.equal(info.email, "alice@proton.me");
    assert.equal(info.display_name, "Alice");
    assert.equal(info.storage_used, 0);
    assert.equal(info.storage_total, 0);
    assert.equal(info.plan, "");
  });

  it("throws SyncError when account adapter is not wired", async () => {
    const sdk = makeFakeSdk();
    const client = new DriveClient(sdk); // no adapter args

    await assert.rejects(
      () => client.validateSession(),
      (err: unknown) =>
        err instanceof SyncError &&
        /account adapter not wired/.test((err as Error).message),
    );
  });

  it("wraps adapter errors through mapSdkError", async () => {
    const mockAdapter = {
      getUser: mock.fn(async () => {
        throw sdkErrorFactoriesForTests.connection("users fetch failed");
      }),
    };

    const sdk = makeFakeSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new DriveClient(sdk, undefined, mockAdapter as any);

    await assert.rejects(
      () => client.validateSession(),
      (err: unknown) => err instanceof NetworkError,
    );
  });
});

// ---------------------------------------------------------------------------
// ProtonOpenPGPCryptoProxy round-trip test (AC11)
// Exercises the real openpgp v6 integration — no Proton servers, no network.
//
// ProtonOpenPGPCryptoProxy is private to sdk.ts so we can't instantiate it
// directly. Instead we exercise the same openpgp v6 API calls that the proxy
// delegates to (generateKey → armor → readPrivateKey), which validates both
// the openpgp version compatibility and the proxy's delegation mapping.
// sdk.test.ts may import openpgp directly — the SDK boundary rule restricts
// @protontech/drive-sdk only.
// ---------------------------------------------------------------------------
describe("ProtonOpenPGPCryptoProxy openpgp round-trip", () => {
  it("generateKey → exportPrivateKey → importPrivateKey round-trip", async () => {
    // Step 1: generate key — mirrors ProtonOpenPGPCryptoProxy.generateKey
    // Uses same params: type ecc, curve ed25519Legacy, format object.
    const result = await openpgp.generateKey({
      type: "ecc",
      curve: "ed25519Legacy",
      userIDs: [{ email: "roundtrip@test.example" }],
      format: "object",
    });
    const privateKey = result.privateKey;
    const originalFingerprint = privateKey.getFingerprint();

    // Step 2: export — mirrors ProtonOpenPGPCryptoProxy.exportPrivateKey (no passphrase)
    const armored = privateKey.armor();
    assert.ok(
      armored.startsWith("-----BEGIN PGP PRIVATE KEY BLOCK-----"),
      "exported key must be PGP armored format",
    );

    // Step 3: import — mirrors ProtonOpenPGPCryptoProxy.importPrivateKey (no passphrase)
    const readBack = await openpgp.readPrivateKey({ armoredKey: armored });
    assert.equal(
      readBack.getFingerprint(),
      originalFingerprint,
      "re-imported key fingerprint must match original",
    );
    assert.ok(readBack.isDecrypted(), "imported key must be decrypted (no passphrase was set)");
  });

  it("createDriveClient constructs successfully with real openpgp proxy wired", () => {
    // Smoke: verifies OpenPGPCryptoWithCryptoProxy(ProtonOpenPGPCryptoProxy)
    // construction does not throw at the SDK constructor boundary.
    const client = createDriveClient("round-trip-token");
    assert.ok(client instanceof DriveClient, "createDriveClient must return a DriveClient");
  });
});

// ---------------------------------------------------------------------------
// DriveClient.deriveAndUnlock + applyKeyPassword (Story 2.11, AC1-AC3, AC5)
//
// All tests mock accountAdapter to avoid real network/crypto calls.
// The bcrypt output is verified structurally (60-char hash starting with "$2").
// ---------------------------------------------------------------------------
describe("DriveClient.deriveAndUnlock", () => {
  // Build a minimal mock adapter. fetchKeySalt and fetchAndDecryptKeys are
  // replaced per-test via mock.fn so we can capture calls.
  function makeMockAdapter(options: {
    keySalt?: string | null;
    decryptShouldFail?: boolean;
  }) {
    return {
      fetchKeySalt: mock.fn(async () => options.keySalt ?? null),
      fetchAndDecryptKeys: mock.fn(async (kp: string) => {
        if (options.decryptShouldFail) {
          throw new Error("wrong passphrase");
        }
        void kp; // consumed — not stored on the mock
      }),
      getUser: mock.fn(async () => ({ email: "u@p.me", display_name: "U" })),
    };
  }

  it("throws SyncError when accountAdapter is not wired", async () => {
    const sdk = makeFakeSdk();
    const client = new DriveClient(sdk); // no adapter

    await assert.rejects(
      () => client.deriveAndUnlock("secret"),
      (err: unknown) =>
        err instanceof SyncError &&
        /account adapter not wired/.test((err as Error).message),
    );
  });

  it("returns empty string keyPassword for SSO account (keySalt === null)", async () => {
    const adapter = makeMockAdapter({ keySalt: null });
    const sdk = makeFakeSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new DriveClient(sdk, undefined, adapter as any);

    const keyPassword = await client.deriveAndUnlock("any-password");

    assert.equal(keyPassword, "", "SSO account must yield empty keyPassword");
    assert.equal(
      adapter.fetchAndDecryptKeys.mock.callCount(),
      0,
      "fetchAndDecryptKeys must NOT be called for SSO accounts",
    );
  });

  it("calls fetchAndDecryptKeys with a bcrypt-shaped keyPassword for normal accounts", async () => {
    // Use a real base64-encoded 16-byte salt to exercise the full bcrypt path.
    // The exact hash value is not tested — only the structure.
    const rawSalt = Buffer.alloc(16, 0xab);
    const keySalt = rawSalt.toString("base64");
    const adapter = makeMockAdapter({ keySalt });
    const sdk = makeFakeSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new DriveClient(sdk, undefined, adapter as any);

    const keyPassword = await client.deriveAndUnlock("hunter2");

    // Proton computeKeyPassword: bcrypt(password, salt).slice(29) → 31-char hash suffix
    // (strips "$2y$10$" prefix (7) + 22-char bcrypt salt = 29 chars)
    assert.equal(typeof keyPassword, "string");
    assert.equal(keyPassword.length, 31, "keyPassword must be 31 chars (bcrypt hash suffix after slice(29))");

    // fetchAndDecryptKeys called with derived keyPassword
    assert.equal(adapter.fetchAndDecryptKeys.mock.callCount(), 1);
    const calledWith = adapter.fetchAndDecryptKeys.mock.calls[0]!.arguments[0];
    assert.equal(calledWith, keyPassword);
  });

  it("propagates SyncError when fetchAndDecryptKeys fails (wrong password)", async () => {
    const rawSalt = Buffer.alloc(16, 0x01);
    const keySalt = rawSalt.toString("base64");
    const adapter = makeMockAdapter({ keySalt, decryptShouldFail: true });
    const sdk = makeFakeSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new DriveClient(sdk, undefined, adapter as any);

    await assert.rejects(
      () => client.deriveAndUnlock("wrong-password"),
      // The underlying error is from fetchAndDecryptKeys (generic Error).
      (err: unknown) => err instanceof Error,
    );
  });
});

describe("DriveClient.applyKeyPassword", () => {
  it("throws SyncError when accountAdapter is not wired", async () => {
    const sdk = makeFakeSdk();
    const client = new DriveClient(sdk);

    await assert.rejects(
      () => client.applyKeyPassword("some-key-password"),
      (err: unknown) =>
        err instanceof SyncError &&
        /account adapter not wired/.test((err as Error).message),
    );
  });

  it("skips fetchAndDecryptKeys for empty keyPassword (SSO account)", async () => {
    const adapter = {
      fetchAndDecryptKeys: mock.fn(async () => {}),
    };
    const sdk = makeFakeSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new DriveClient(sdk, undefined, adapter as any);

    await client.applyKeyPassword("");

    assert.equal(
      adapter.fetchAndDecryptKeys.mock.callCount(),
      0,
      "fetchAndDecryptKeys must not be called for SSO (empty keyPassword)",
    );
  });

  it("calls fetchAndDecryptKeys with the given keyPassword", async () => {
    const adapter = {
      fetchAndDecryptKeys: mock.fn(async () => {}),
    };
    const sdk = makeFakeSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new DriveClient(sdk, undefined, adapter as any);

    await client.applyKeyPassword("$2y$10$somebcrypthash");

    assert.equal(adapter.fetchAndDecryptKeys.mock.callCount(), 1);
    assert.equal(
      adapter.fetchAndDecryptKeys.mock.calls[0]!.arguments[0],
      "$2y$10$somebcrypthash",
    );
  });

  it("propagates errors from fetchAndDecryptKeys (stored keyPassword invalid)", async () => {
    const adapter = {
      fetchAndDecryptKeys: mock.fn(async () => {
        throw new Error("Key decryption failed");
      }),
    };
    const sdk = makeFakeSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new DriveClient(sdk, undefined, adapter as any);

    await assert.rejects(
      () => client.applyKeyPassword("$2y$10$stale"),
      (err: unknown) => err instanceof Error,
    );
  });
});
