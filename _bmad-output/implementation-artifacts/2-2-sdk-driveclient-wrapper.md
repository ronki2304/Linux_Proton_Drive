# Story 2.2: SDK DriveClient Wrapper

Status: done

## Story

As a **sync engine developer**,
I want **a `DriveClient` class in `engine/src/sdk.ts` that encapsulates every `@protontech/drive-sdk` interaction behind a stable, app-shaped interface**,
so that **the rest of the engine (sync orchestrator, IPC handlers, future watcher) is insulated from SDK version churn, openpgp wiring, and `MaybeNode` footguns — and so a `0.14.x` SDK bump only ever touches `sdk.ts`.**

> **Why this story exists now:** Story 2.1 landed the SQLite state layer. Story 2.3 (Remote Folder Picker) needs `list_remote_folders`, Story 2.4 needs `add_pair`, and Story 2.5 (sync engine core) needs upload/download. Every one of those stories will be blocked the moment they need a real SDK call. Building the wrapper now — with mocked unit tests — unblocks the entire epic without forcing each downstream story to re-litigate the SDK boundary.
>
> **Scope split (2026-04-10, party-mode review):** This story originally bundled the wrapper class AND the live SDK wiring (`createDriveClient(token)` factory, `validateSession(token)`, and `main.ts:handleTokenRefresh` rewire). Team consensus (Winston, Amelia, Quinn, Mary, John, Bob) carved the live wiring out to **Story 2.2.5**, sequenced after Story 2.3. This story now ships only the wrapper class + tests + boundary preservation. The factory's heavy SDK constructor wiring (HTTPClient, account adapter, SRP module, openpgp adapter) lives in 2.2.5 and is blocked on Mary's analyst spike confirming a Node-compatible Proton SRP path. See `2-2-5-sdk-live-wiring.md`.

## Acceptance Criteria

**AC1 — SDK boundary enforced (sole importer):**
**Given** the engine source tree
**When** static-checking imports of `@protontech/drive-sdk` and `openpgp`
**Then** `engine/src/sdk.ts` is the **only** file importing either package
**And** the existing `SDK BOUNDARY` comment at the top of `sdk.ts` remains
**And** `openpgp` is imported from `"openpgp"` (full bundle) — never `"openpgp/lightweight"`
**And** the existing boundary tests in `sdk.test.ts` ("no other engine file imports `@protontech/drive-sdk`", "sdk.ts only imports from errors.ts internally") still pass

**AC2 — `DriveClient` class with dependency-injectable underlying SDK:**
**Given** `engine/src/sdk.ts`
**When** importing `DriveClient`
**Then** `DriveClient` is an exported class
**And** its constructor accepts an injected underlying client object (the `ProtonDriveClient` instance from the SDK, or a structurally-compatible test mock) — this is the test seam
**And** the wrapper does NOT include a `createDriveClient(token)` factory in this story — that wiring is owned by Story 2.2.5 (see Out of Scope)
**And** when the factory eventually lands in 2.2.5, no engine file other than `sdk.ts` will ever call `new ProtonDriveClient(...)` — that boundary rule is preserved by AC1 today

**AC3 — `listRemoteFolders(parentId)` returns app-shaped folders, lazily:**
**Given** the `DriveClient` class
**When** calling `listRemoteFolders(parentId: string | null)`
**Then** `parentId === null` resolves to the children of `getMyFilesRootFolder()` — i.e. top-level folders only
**And** passing a folder UID returns that folder's direct children only (lazy expansion — never recursive prefetch, FR-aligned with Story 2.3)
**And** the return type is `Promise<RemoteFolder[]>` where `RemoteFolder = { id: string; name: string; parent_id: string | null }` (snake_case field names — wire format, see project-context.md "IPC Wire Format — snake_case on Both Sides")
**And** results are filtered to `NodeType.Folder` only (files are excluded — picker shows folders only)
**And** every `MaybeNode` returned by the SDK is unwrapped via `.ok` check **before** accessing `.value` — direct property access on `MaybeNode` is the #1 SDK footgun (see project-context.md "SDK Footguns")
**And** `DegradedNode` results (where `.ok === false`) are skipped silently in the picker list (logged via `debugLog` if `PROTONDRIVE_DEBUG=1`); they are NOT thrown — partial decryption failures must not break folder browsing

**AC4 — `uploadFile` and `downloadFile` shapes (delegating to SDK uploaders/downloaders):**
**Given** the `DriveClient` class
**When** calling `uploadFile(parentId: string, name: string, body: { stream: ReadableStream; sizeBytes: number; modificationTime: Date; mediaType: string }): Promise<{ node_uid: string; revision_uid: string }>`
**Then** it delegates to `client.getFileUploader(parentNodeUid, name, metadata)` then `uploader.uploadFromStream(stream, [], onProgress?)` then `controller.completion()`
**And** the return value is shaped `{ node_uid, revision_uid }` (snake_case)
**And** `metadata.expectedSize` is set from `body.sizeBytes` (the SDK uses this for integrity verification — mismatched size aborts the upload with `IntegrityError`)
**And** `metadata.modificationTime` is the `Date` passed in
**And** `metadata.mediaType` is the MIME type (e.g. `application/octet-stream` if unknown — Story 2.5 will compute it; this story exposes the parameter but does not need to detect MIME)

**Given** the `DriveClient` class
**When** calling `downloadFile(nodeUid: string, target: WritableStream): Promise<void>`
**Then** it delegates to `client.getFileDownloader(nodeUid)` then `downloader.downloadToStream(target)` then `controller.completion()`
**And** the method does NOT call `unsafeDownloadToStream` (integrity bypass is debug-only per SDK docs)
**And** if the resulting controller's `isDownloadCompleteWithSignatureIssues()` is true at completion, the method completes successfully **but** the signature issue is logged via `debugLog` — Story 2.5 will decide on user-visible warnings; this story's contract is "download succeeded, integrity questionable"

**Given** any upload or download call site
**When** passing buffers between openpgp v6 and the SDK at the call boundary
**Then** any necessary `Uint8Array<ArrayBufferLike>` ↔ `Uint8Array<ArrayBuffer>` casts are applied **inside `sdk.ts` only** — never leak the cast to call-sites (see project-context.md "openpgp v6 ↔ SDK Uint8Array casts at boundary")
**And** all upload/download methods are `async`/`await` — no raw `.then()/.catch()` chains (project-context.md TypeScript rule)

**AC5 — All SDK errors wrapped in typed engine errors (no raw `Error`):**
**Given** any method on `DriveClient` (`listRemoteFolders`, `uploadFile`, `downloadFile`)
**When** the underlying SDK throws
**Then** the error is caught and re-thrown as a typed engine error (`SyncError`, `NetworkError`, or `ConfigError`) with the original SDK error as `cause` (use `{ cause: err }`, not lossy stringification)
**And** specifically:
  - SDK `ConnectionError` → `NetworkError("Network unavailable", { cause: err })`
  - SDK `RateLimitedError` → `NetworkError("Rate limited", { cause: err })` (Story 3.4 will handle the retry-after; this story only normalizes the type)
  - SDK `ServerError` (any HTTP/API error) → `NetworkError("API error: ${err.message}", { cause: err })`
  - SDK `IntegrityError` / `DecryptionError` → `SyncError("Decryption failed", { cause: err })`
  - SDK `ValidationError` / `NodeWithSameNameExistsValidationError` → `SyncError("Validation failed: ${err.message}", { cause: err })`
  - SDK `AbortError` → re-throw as-is (legitimate abort propagation)
  - Any other `ProtonDriveError` → `SyncError(err.message, { cause: err })`
  - Anything else (unexpected non-`ProtonDriveError`) → `SyncError("Unexpected SDK error", { cause: err })` (project-context.md: "engine functions never return `{ error: ... }`")
**And** **no SDK error is logged with a token** — error messages and `cause` chains must never include the session token (project-context.md "Token must never appear in output")

**AC6 — Unit tests mock the SDK at the wrapper boundary, not the package:**
**Given** `engine/src/sdk.test.ts`
**When** running `node --import tsx --test engine/src/sdk.test.ts`
**Then** new `describe("DriveClient")` suite tests pass alongside the existing boundary suite
**And** tests mock by passing a fake `ProtonDriveClient`-shaped object to `new DriveClient(fakeSdk)` — never via `mock.module()` or jest-style module mocking, never by importing from `@protontech/drive-sdk` in the test file
**And** test coverage includes:
  - `listRemoteFolders(null)` calls `getMyFilesRootFolder` then `iterateFolderChildren`, returns mapped `RemoteFolder[]`
  - `listRemoteFolders("uid-123")` calls `iterateFolderChildren("uid-123")` directly (no root call)
  - `listRemoteFolders` filters out `NodeType.File` results
  - `listRemoteFolders` skips `MaybeNode` results where `.ok === false` (degraded nodes)
  - `uploadFile` invokes the uploader chain and returns the `{ node_uid, revision_uid }` shape from the SDK's `completion()` result
  - `downloadFile` invokes the downloader chain and resolves on `completion()`
  - SDK error mapping: a thrown `ConnectionError` → caught as `NetworkError`; thrown `IntegrityError` → caught as `SyncError`; thrown `AbortError` → re-thrown as-is; thrown plain `Error` → caught as `SyncError("Unexpected SDK error")`
**And** each test uses `mock.fn()` from `node:test` (NOT `jest.fn()`/`vi.fn()`) and `node:assert/strict` (NOT `expect()`) per project-context.md "Sync Engine Tests"
**And** since `createDriveClient(token)` is owned by Story 2.2.5, no factory wiring is exercised in this story's tests — every test passes a structurally-shaped fake to the `DriveClient` constructor directly

**AC7 — Full test suite stays green:**
**Given** the engine test suite
**When** running `node --import tsx --test 'engine/src/**/*.test.ts'`
**Then** all existing tests still pass (zero regressions in `state-db.test.ts`, `ipc.test.ts`, `main.test.ts`, `debug-log.test.ts`)
**And** `engine/src/main.ts` is **untouched** by this story (the placeholder `handleTokenRefresh` stays — Story 2.2.5 will rewire it)
**And** the boundary check (`engine/src/sdk.test.ts` boundary suite — 5 existing tests) still passes
**And** the new `describe("DriveClient")` suite tests grow proportionally to the methods added (no specific count claimed; AC6 enumerates the coverage areas instead)
**And** `tsc --noEmit` (or `npm run build`) succeeds with strict mode + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` — every type-only import uses `import type`, every indexed access on possibly-empty arrays is bounds-checked
**And** `meson test -C builddir` (UI suite) still passes (no UI changes expected, but project-context.md mandates running both)

## Tasks / Subtasks

> **Suggested order:** AC2 first (define the class shape and the test seam), then AC6 in parallel (mock helper + tests), then AC3/AC4 method-by-method against the tests, then AC5 (error mapping pass — easier with all methods in place), then AC1/AC7 final verification.

- [x] **Task 1: Replace `sdk.ts` placeholder with real `DriveClient` skeleton** (AC: #1, #2)
  - [x] 1.1 Add the actual SDK and openpgp imports at the top of `sdk.ts`. Use **type-only** imports (`import type`) for SDK types (`ProtonDriveClient`, `MaybeNode`, `NodeEntity`, `NodeType`, error classes) where possible — `verbatimModuleSyntax` requires it.
    - Value imports needed: `ProtonDriveClient` (the class, for `instanceof` and `new`), the SDK error classes (`ProtonDriveError`, `ConnectionError`, `RateLimitedError`, `ServerError`, `IntegrityError`, `DecryptionError`, `ValidationError`, `AbortError`) for the `instanceof` chain in error mapping, and `NodeType` (it's an enum — runtime value).
    - Type-only imports: `MaybeNode`, `NodeEntity`, `DegradedNode`, `NodeOrUid`, `UploadMetadata`, `FileDownloader`, `FileUploader`, `ProtonDriveClientContructorParameters`.
    - Full openpgp bundle: `import * as openpgp from "openpgp";` (DO NOT use `"openpgp/lightweight"` — project-context.md hard rule).
  - [x] 1.2 Keep the `SDK BOUNDARY` comment block. Update its body to drop the "TODO Wire actual @protontech/drive-sdk" line — that's now done.
  - [x] 1.3 Define the boundary types (snake_case wire shape — these become the engine's app-side currency for SDK data):
    ```ts
    export interface RemoteFolder {
      id: string;          // node UID
      name: string;
      parent_id: string | null;  // null for top-level under MyFiles root
    }

    export interface UploadBody {
      stream: ReadableStream<Uint8Array>;
      sizeBytes: number;
      modificationTime: Date;
      mediaType: string;
    }
    ```
    Note: the placeholder `AccountInfo` interface in the current `sdk.ts` is **deleted** in this story — `AccountInfo` and `validateSession` move to Story 2.2.5 along with the factory.
  - [x] 1.4 Define a structural type alias for the test seam so the constructor can accept either a real `ProtonDriveClient` or a mock without `as any`:
    ```ts
    // Pulled out so test mocks don't need to satisfy the entire SDK class.
    // Add methods to this interface only as DriveClient grows to consume them.
    export type ProtonDriveClientLike = Pick<
      ProtonDriveClient,
      | "getMyFilesRootFolder"
      | "iterateFolderChildren"
      | "getFileUploader"
      | "getFileDownloader"
    >;
    ```
    Reason: `ProtonDriveClient` has 50+ methods. A test mock that satisfies all of them is impractical. `Pick` lets the dev (and tests) declare exactly what `DriveClient` consumes — and grows naturally as new methods are added.
  - [x] 1.5 Rewrite the `DriveClient` class:
    ```ts
    export class DriveClient {
      constructor(private readonly sdk: ProtonDriveClientLike) {}
      // methods added in Tasks 2 and 3 (listRemoteFolders, uploadFile, downloadFile)
    }
    ```
    Delete the placeholder `token` field, the `isAuthenticated()` method, the `validateSession(token)` method, and the `AccountInfo` interface — all four move to Story 2.2.5 along with the factory. Verify no other engine file references any of them via grep before deleting (`main.ts` references `validateSession` only inside a TODO comment — that comment stays, untouched, until 2.2.5 rewires `handleTokenRefresh`).

- [x] **Task 2: `listRemoteFolders` with lazy expansion + MaybeNode unwrap** (AC: #3)
  - [x] 2.1 Implement `async listRemoteFolders(parentId: string | null): Promise<RemoteFolder[]>` on `DriveClient`.
  - [x] 2.2 If `parentId === null`: call `await this.sdk.getMyFilesRootFolder()`, unwrap the resulting `MaybeNode` (`if (!root.ok) throw new SyncError("My Files root unavailable", { cause: ... })`), then iterate `this.sdk.iterateFolderChildren(root.value)` and collect into a list.
  - [x] 2.3 If `parentId !== null`: iterate `this.sdk.iterateFolderChildren(parentId)` directly. The SDK accepts `NodeOrUid` so a string UID is valid.
  - [x] 2.4 In the iteration loop:
    - For each yielded `MaybeNode`, check `if (!result.ok) { debugLog("DriveClient: degraded node skipped in folder list"); continue; }` — degraded nodes are silently dropped.
    - Filter to folders only: `if (result.value.type !== NodeType.Folder) continue;` (the SDK's `iterateFolderChildren` accepts a `filterOptions.type` arg — pass `{ type: NodeType.Folder }` if it's cheaper to filter server-side; verify it's supported in v0.14.3 from the d.ts before relying on it. Either approach is fine; the explicit JS-side filter is the safe default.)
    - Map to the boundary shape: `{ id: node.uid, name: node.name, parent_id: node.parentUid ?? null }`. (Per `nodes.d.ts`, `parentUid` is optional — `?? null` normalizes the wire shape.)
  - [x] 2.5 Wrap the entire method body in the error-mapping try/catch (will be implemented as a shared helper in Task 5).
  - [x] 2.6 Import `debugLog` from `./debug-log.js` for the degraded-node skip log. Pass only the static message — never include the node UID or any encrypted material.

- [x] **Task 3: `uploadFile` and `downloadFile`** (AC: #4)
  - [x] 3.1 Implement `async uploadFile(parentId: string, name: string, body: UploadBody): Promise<{ node_uid: string; revision_uid: string }>`:
    - Build `UploadMetadata`: `{ mediaType: body.mediaType, expectedSize: body.sizeBytes, modificationTime: body.modificationTime }`.
    - Call `const uploader = await this.sdk.getFileUploader(parentId, name, metadata);`
    - Call `const controller = await uploader.uploadFromStream(body.stream, []);` (empty thumbnails array — Story 2.5+ may add thumbnail generation later).
    - Await `const result = await controller.completion();` → returns `{ nodeUid, nodeRevisionUid }` (camelCase per SDK).
    - **Translate camelCase → snake_case at the boundary** (project-context.md "snake_case on Both Sides"): return `{ node_uid: result.nodeUid, revision_uid: result.nodeRevisionUid }`.
  - [x] 3.2 Implement `async downloadFile(nodeUid: string, target: WritableStream<Uint8Array>): Promise<void>`:
    - Call `const downloader = await this.sdk.getFileDownloader(nodeUid);`
    - Call `const controller = downloader.downloadToStream(target);` (note: per `download.d.ts`, `downloadToStream` returns a `DownloadController` synchronously — it does NOT return a Promise. Don't `await` the call itself, only `controller.completion()`.)
    - Await `controller.completion();`
    - After completion, `if (controller.isDownloadCompleteWithSignatureIssues()) { debugLog("DriveClient: download completed with signature verification warnings"); }` — log only, do not throw. Story 2.5 will decide UX for the warning.
  - [x] 3.3 If the dev encounters a TypeScript error involving `Uint8Array<ArrayBufferLike>` vs `Uint8Array<ArrayBuffer>` (from openpgp v6 ↔ SDK boundary — see Dev Notes), apply the cast **inside** the method body using `as Uint8Array<ArrayBuffer>` or via a small private helper. Document with a one-line comment referencing project-context.md. Do not propagate the cast to call-sites.
  - [x] 3.4 Both methods go through the error-mapping helper from Task 5.

- [x] **Task 4: SDK error mapping helper** (AC: #5)
  - [x] 4.1 Add a private helper inside `sdk.ts`:
    ```ts
    function mapSdkError(err: unknown): never {
      // Re-throw legitimate aborts
      if (err instanceof AbortError) throw err;
      // Network family
      if (err instanceof ConnectionError) throw new NetworkError("Network unavailable", { cause: err });
      if (err instanceof RateLimitedError) throw new NetworkError("Rate limited", { cause: err });
      if (err instanceof ServerError) throw new NetworkError(`API error: ${err.message}`, { cause: err });
      // Sync family
      if (err instanceof IntegrityError) throw new SyncError("Decryption failed", { cause: err });
      if (err instanceof DecryptionError) throw new SyncError("Decryption failed", { cause: err });
      if (err instanceof ValidationError) throw new SyncError(`Validation failed: ${err.message}`, { cause: err });
      // Generic SDK error
      if (err instanceof ProtonDriveError) throw new SyncError(err.message, { cause: err });
      // Fallthrough
      throw new SyncError("Unexpected SDK error", { cause: err });
    }
    ```
    - **Order matters**: more specific subclasses (`RateLimitedError extends ServerError`, `NodeWithSameNameExistsValidationError extends ValidationError`) must be checked **before** their parents.
    - **Token safety**: every `${err.message}` interpolation must be safe. SDK error messages are translated user-facing strings per `errors.d.ts:6-7` — they do not include tokens. Do **not** interpolate `cause` chains via string concat anywhere. (Project-context.md: "Token must never appear in output".)
  - [x] 4.2 Wrap all three public methods (`listRemoteFolders`, `uploadFile`, `downloadFile`) with `try { ... } catch (err) { mapSdkError(err); }`. Note: TypeScript needs the `never` return type on `mapSdkError` for the catch block to compile cleanly.
  - [x] 4.3 Add unit tests for each error class → engine error mapping (see Task 5 AC6 list).

- [x] **Task 5: Wrapper unit tests** (AC: #6)
  - [x] 5.1 In `engine/src/sdk.test.ts`, add a new `describe("DriveClient", () => { ... })` suite **alongside** the existing `describe("SDK boundary enforcement", ...)` suite. Do not delete or modify the boundary suite — both must keep passing.
  - [x] 5.2 Build a helper factory inside the test file:
    ```ts
    function makeFakeSdk(overrides: Partial<ProtonDriveClientLike> = {}): ProtonDriveClientLike {
      return {
        getMyFilesRootFolder: mock.fn(async () => ({ ok: true, value: { uid: "root", name: "My Files", type: "folder" } as any })),
        iterateFolderChildren: mock.fn(async function* () { /* yield nothing by default */ }),
        getFileUploader: mock.fn(),
        getFileDownloader: mock.fn(),
        ...overrides,
      };
    }
    ```
    Use `as any` in the cast for the synthetic `NodeEntity` since constructing a full real one (with `keyAuthor`, `nameAuthor`, `directRole`, etc.) is excessive for unit tests. Localize the cast to test setup only.
  - [x] 5.3 Tests for `listRemoteFolders`:
    - Root case: pass `null`, assert `getMyFilesRootFolder` called once, `iterateFolderChildren` called once with the root node, return value matches `[{ id, name, parent_id }]` shape.
    - Subfolder case: pass `"uid-123"`, assert `getMyFilesRootFolder` NOT called, `iterateFolderChildren` called with `"uid-123"`.
    - Filter test: yield a mix of `{ type: "folder" }` and `{ type: "file" }` nodes, assert only folders in the result.
    - Degraded skip test: yield a `{ ok: false, error: { ... } }` MaybeNode, assert it's silently skipped (and the result excludes it).
    - Empty folder test: yield nothing, assert `[]` returned.
  - [x] 5.4 Tests for `uploadFile`:
    - Mock `getFileUploader` to return a fake uploader whose `uploadFromStream` returns a fake controller whose `completion()` resolves to `{ nodeUid: "n1", nodeRevisionUid: "r1" }`.
    - Call `uploadFile("parent-uid", "test.txt", { stream: ..., sizeBytes: 100, modificationTime: new Date(), mediaType: "text/plain" })`.
    - Assert return value is `{ node_uid: "n1", revision_uid: "r1" }` (snake_case).
    - Assert `getFileUploader` was called with `("parent-uid", "test.txt", { mediaType: "text/plain", expectedSize: 100, modificationTime: <date> })`.
  - [x] 5.5 Tests for `downloadFile`:
    - Mock `getFileDownloader` to return a fake downloader whose `downloadToStream` returns a fake controller with resolving `completion()` and `isDownloadCompleteWithSignatureIssues() => false`.
    - Call `downloadFile("node-uid", new WritableStream())`, assert it resolves without throwing.
    - Second test: `isDownloadCompleteWithSignatureIssues() => true` → still resolves successfully (no throw), assert `debugLog` would be called (if `debugLog` is mocked at module level via `mock.module()`-equivalent — or skip the log assertion and verify by code review).
  - [x] 5.6 Tests for error mapping (one test per class):
    - Construct fake SDK whose method throws each SDK error in turn (ConnectionError, RateLimitedError, ServerError, IntegrityError, DecryptionError, ValidationError, AbortError, plain `Error`).
    - For each, assert the wrapper's call rejects with the expected typed engine error and that `cause` is preserved.
    - AbortError: assert it re-throws as-is (`instanceof AbortError`).
  - [x] 5.7 Run `node --import tsx --test engine/src/sdk.test.ts` — all new tests pass. The existing 5 boundary tests still pass.

- [x] **Task 6: Verification — full suite + boundary check** (AC: #1, #7)
  - [x] 6.1 Run `node --import tsx --test 'engine/src/**/*.test.ts'` — all engine tests pass. The new `describe("DriveClient")` suite contributes additional tests; do not anchor on a specific count (the count grows with method coverage, not with story scope).
  - [x] 6.2 Run `cd engine && npx tsc --noEmit` — strict mode compile passes with zero errors. Pay special attention to:
    - `noUncheckedIndexedAccess` violations on any array access in the new code
    - `verbatimModuleSyntax` violations (any value import that should be `import type`)
    - The `Uint8Array<ArrayBufferLike>` ↔ `Uint8Array<ArrayBuffer>` boundary if Task 3.3 had to apply casts
  - [x] 6.3 Manually re-verify boundary: `grep -rn "@protontech/drive-sdk\|from \"openpgp\"" engine/src/` — only `engine/src/sdk.ts` should appear in the output. The boundary test suite enforces this automatically but a manual sanity check before review is cheap insurance.
  - [x] 6.4 Run `meson test -C builddir` — UI test suite still green (no UI changes expected, but project rule is "always run both suites" — project-context.md "CI runs both suites").
  - [x] 6.5 Confirm `engine/src/main.ts` is **untouched** — `git diff engine/src/main.ts` should be empty. Story 2.2.5 owns the rewire.

## Dev Notes

### Architecture invariants this story must NOT violate

- **SDK boundary** [project-context.md "Architectural Boundaries"] — `engine/src/sdk.ts` is the **only** file importing `@protontech/drive-sdk` or `openpgp`. The existing test suite enforces this automatically. If the dev needs SDK types in another file, re-export them from `sdk.ts` (e.g. `export type { RemoteFolder } from "./sdk.js";`) — never re-import from the package elsewhere.
- **One-way dependency rule** — `sdk.ts` may import from `errors.ts` and `debug-log.ts` only (both leaf modules). Importing from `state-db.ts`, `ipc.ts`, `main.ts`, etc. is forbidden — it would create circular deps once those files import `DriveClient`. The existing boundary test asserts only `errors.ts` is imported; if the dev adds `debug-log.ts` import (recommended for the degraded-node skip log), update the boundary test in step 1 of Task 1 to allow `errors.ts` AND `debug-log.ts` only. Both are leaf modules (zero internal imports of their own), so circularity stays impossible.
- **`MaybeNode` is the #1 SDK footgun** [project-context.md "SDK Footguns"] — every SDK method returning `MaybeNode<T>` must be unwrapped via `.ok` check before accessing `.value`. Direct property access compiles cleanly but returns `undefined` at runtime. The dev must either:
  - Check `if (!result.ok) { /* handle */ }` at every call site, OR
  - Use a private `unwrap<T>(maybe: MaybeNode<T>): T` helper that throws `SyncError("Degraded node")` on `.ok === false` — then call `unwrap(result)` everywhere. The helper approach is recommended; centralizes the policy.
- **openpgp v6 ↔ SDK `Uint8Array` casts** [project-context.md "PGP" + interface samples in this story's Dev Notes] — openpgp v6 returns `Uint8Array<ArrayBufferLike>` while the SDK expects `Uint8Array<ArrayBuffer>`. They are runtime-identical but TypeScript treats them as incompatible. Apply `as Uint8Array<ArrayBuffer>` casts **only inside `sdk.ts`** at the boundary. Never in the call-sites in other engine files.
- **Token never in output** [project-context.md "Security" — non-negotiable] — no `console.log`, no error message, no `cause` chain string, no `debugLog` call may include the session token. The token does not flow through this story's wrapper at all (the factory + `validateSession` that take a token live in Story 2.2.5). But the boundary discipline still matters: when reviewers grep for `${token}` and `+ token` in the diff for this story, the result must be empty.
- **`async/await` only — no `.then().catch()` chains** [project-context.md "TypeScript" rule]. Every method on `DriveClient` is `async` and uses `await`. The only `.then()`-flavored construct allowed is `controller.completion()` which is itself a Promise being awaited.
- **Throw, never return errors** [project-context.md "Error classes: typed subclasses only"] — `DriveClient` methods never return `{ error: ... }` or `null` to signal failure. Throw a typed engine error (`SyncError`, `NetworkError`) and let downstream callers (Story 2.3 folder picker, Story 2.5 sync engine, future Story 2.2.5 `handleTokenRefresh` rewire) catch and serialize into IPC push events.
- **Test framework: `node:test`, NOT Jest/Vitest** [project-context.md "Sync Engine Tests"] — use `mock.fn()` from `node:test` (not `jest.fn()` or `vi.fn()`), `node:assert/strict` (no `expect()`), check call history via `mockFn.mock.calls` (not `.toHaveBeenCalledWith()`). Co-locate the test file: `engine/src/sdk.test.ts` — never `engine/src/__tests__/sdk.test.ts`.

### Files to touch (estimated)

| File | Action | Why |
|---|---|---|
| `engine/src/sdk.ts` | **Rewrite (focused)** | The placeholder becomes the real wrapper class. Three methods (`listRemoteFolders`, `uploadFile`, `downloadFile`) + error mapping helper + boundary types. Estimated ~150-220 lines. The factory + `validateSession` are NOT in this story — they live in 2.2.5. |
| `engine/src/sdk.test.ts` | **Append** new `describe("DriveClient")` suite alongside existing boundary suite | New unit tests for the three wrapper methods + error mapping; don't touch the boundary tests. |
| `engine/src/main.ts` | **NO CHANGE** | The placeholder `handleTokenRefresh` and the `// TODO: Story 1-13` comment stay. Story 2.2.5 owns the rewire. |
| `engine/src/main.test.ts` | **NO CHANGE** | Untouched — `main.ts` is untouched. |
| `engine/src/errors.ts` | **No change** | Existing `SyncError`, `NetworkError`, `ConfigError` cover all needed cases. If a new error subclass feels needed, push back — the existing four are sufficient per project-context.md. |

**Files NOT to create or modify:**
- No new files in `engine/src/` — `sdk.ts` absorbs the wrapper, factory, and helpers all in one file (project-context.md "Engine source is flat — no subdirectories"). The dev may consider `sdk-factory.ts` or `sdk-deps.ts` for the wiring helpers — **don't**. Keep it in `sdk.ts`. Project-context.md is explicit: flat structure, files merged when always edited together.
- No `__tests__/` directories. Co-locate.
- Do NOT touch `package.json` — `@protontech/drive-sdk@0.14.3` and `openpgp@^6.3.0` are already pinned and installed (verified in `engine/node_modules/`).

### SDK type quick reference (only what this story consumes)

Pulled from `engine/node_modules/@protontech/drive-sdk/dist/`:

```ts
// nodes.d.ts
type MaybeNode = Result<NodeEntity, DegradedNode>;
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
type NodeEntity = {
  uid: string;
  parentUid?: string;     // undefined for root nodes
  name: string;
  type: NodeType;          // enum: "file" | "folder" | "album" | "photo"
  modificationTime: Date;
  totalStorageSize?: number;
  // ... many other fields not relevant to this story
};
enum NodeType { File = "file", Folder = "folder", Album = "album", Photo = "photo" }

// upload.d.ts
type UploadMetadata = {
  mediaType: string;
  expectedSize: number;
  expectedSha1?: string;
  modificationTime?: Date;
  additionalMetadata?: object;
  overrideExistingDraftByOtherClient?: boolean;
};
interface FileUploader {
  uploadFromStream(stream: ReadableStream, thumbnails: Thumbnail[], onProgress?: (uploadedBytes: number) => void): Promise<UploadController>;
  uploadFromFile(...): Promise<UploadController>;
}
interface UploadController {
  pause(): void;
  resume(): void;
  completion(): Promise<{ nodeRevisionUid: string; nodeUid: string }>;
}

// download.d.ts
interface FileDownloader {
  getClaimedSizeInBytes(): number | undefined;
  downloadToStream(streamFactory: WritableStream, onProgress?: (downloadedBytes: number) => void): DownloadController;
  // unsafeDownloadToStream — DEBUG ONLY, do not use
  // getSeekableStream — out of scope this story
}
interface DownloadController {
  pause(): void;
  resume(): void;
  completion(): Promise<void>;
  isDownloadCompleteWithSignatureIssues(): boolean;
}

// errors.d.ts
class ProtonDriveError extends Error {}
class AbortError extends ProtonDriveError {}
class ValidationError extends ProtonDriveError {}
class NodeWithSameNameExistsValidationError extends ValidationError {}
class ServerError extends ProtonDriveError { statusCode?: number; code?: number; }
class RateLimitedError extends ServerError { code: number; }
class ConnectionError extends ProtonDriveError {}
class DecryptionError extends ProtonDriveError {}
class IntegrityError extends ProtonDriveError {}

// protonDriveClient.d.ts (subset this story uses)
class ProtonDriveClient {
  constructor(params: ProtonDriveClientContructorParameters);
  getMyFilesRootFolder(): Promise<MaybeNode>;
  iterateFolderChildren(parentNodeUid: NodeOrUid, filterOptions?: { type?: NodeType }, signal?: AbortSignal): AsyncGenerator<MaybeNode>;
  getFileUploader(parentFolderUid: NodeOrUid, name: string, metadata: UploadMetadata, signal?: AbortSignal): Promise<FileUploader>;
  getFileDownloader(nodeUid: NodeOrUid, signal?: AbortSignal): Promise<FileDownloader>;
  // ... 40+ other methods not in scope
}

// interface/index.d.ts (constructor params)
interface ProtonDriveClientContructorParameters {
  httpClient: ProtonDriveHTTPClient;
  entitiesCache: ProtonDriveEntitiesCache;
  cryptoCache: ProtonDriveCryptoCache;
  account: ProtonDriveAccount;
  openPGPCryptoModule: OpenPGPCrypto;
  srpModule: SRPModule;
  config?: ProtonDriveConfig;
  telemetry?: ProtonDriveTelemetry;
  featureFlagProvider?: FeatureFlagProvider;
  latestEventIdProvider?: LatestEventIdProvider;
}
```

### Patterns established by Story 2.1 the dev should follow

(Read `engine/src/state-db.ts` for the canonical example.)

- **Module top-level documentation comment** explaining the boundary contract — `state-db.ts` doesn't have one but `sdk.ts` already does (`SDK BOUNDARY` block). Keep it.
- **Type-only imports for interfaces/types** — `state-db.ts` uses `import type { ... }` extensively. Mirror that.
- **Synchronous-where-possible**, async-only-where-needed — `state-db.ts` is fully synchronous (better-sqlite3); `sdk.ts` will be async (SDK is async). Don't introduce sync/async mismatches.
- **Snake_case at the IPC/wire boundary, camelCase inside the engine** — `state-db.ts` rows are typed via interfaces with snake_case fields (matching SQLite columns). `DriveClient` should expose snake_case in its return types (`node_uid`, `parent_id`, `display_name`) because those values flow directly into IPC push events. Do **not** transform to camelCase in TypeScript — project-context.md "snake_case on Both Sides".
- **Tests use a fresh isolated state per test** — `state-db.test.ts` builds a fresh `:memory:` DB per test. `sdk.test.ts` should build a fresh `makeFakeSdk()` per test. Never share mock state across tests; flaky test root cause #1.
- **Review feedback discipline** — Story 2.1 had 16 review findings (mostly accepted, some deferred). The dev should expect a similarly thorough review and pre-empt the obvious ones: explicit constants over magic numbers, no template-string interpolation of dynamic values that could carry secrets, exhaustive `instanceof` ordering in error mapping (subclass before parent — see Task 4.1), and unit tests that name what they're verifying (not just `it("works")`).

### Previous story intelligence — Story 2.0 (Tech Debt) and Story 2.1 (SQLite)

From Story 2.0:
- **Backpressure-aware IPC writes** are now in `IpcServer` — `emitEvent` queues messages on socket pressure. The wrapper does not need to know about this; just `server.emitEvent({ type: "session_ready", payload: ... })` is safe even under burst conditions. Not a concern for this story but useful context: `sync_progress` events from Story 2.5 will work correctly without further changes.
- **`debugLog`** is the canonical leaf-module logging utility. Import via `import { debugLog } from "./debug-log.js";`. It no-ops unless `PROTONDRIVE_DEBUG=1`. Use it for the degraded-node skip log and the signature-issue download warning. Note: `debugLog` accepts `(message: string, cause?: unknown)` — never pass a token.

From Story 2.1:
- **SQLite state exists** at `$XDG_DATA_HOME/protondrive/state.db` with `sync_pair`, `sync_state`, `change_queue` tables (with FK cascades). Not directly used in this story — the wrapper has no reason to query state-db.
- **Test discipline:** Story 2.1 added 15 new tests with zero regressions. Mirror that quality bar; the test count grows naturally with the methods covered, not by inflating with redundant assertions.

### Out of scope (do NOT do)

- **Live SDK instantiation via `createDriveClient(token)` factory** — deferred to **Story 2.2.5**. This story ships the wrapper class only. Tests use injected mocked SDK; no real `ProtonDriveClient` is constructed anywhere.
- **`validateSession(token)` method on `DriveClient`** — also deferred to Story 2.2.5. The method depends on the factory + the account adapter; both live in 2.2.5. Do NOT add it to this story even as a stub.
- **`engine/src/main.ts:handleTokenRefresh` rewire** — also deferred to Story 2.2.5. The placeholder hardcoded `session_ready` payload stays. The `// TODO: Story 1-13 will add DriveClient.validateSession(token)` comment stays untouched. Verify with `git diff engine/src/main.ts` returning empty before review.
- **HTTPClient adapter (Node 22 fetch)**, **account adapter**, **openpgp v6 → OpenPGPCryptoProxy adapter**, **in-memory cache adapters**, **SRP module wiring** — all six SDK constructor dependencies are owned by Story 2.2.5. Do NOT implement or stub any of them in this story.
- **Live integration test against real Proton servers** — Proton CAPTCHA blocks automated auth (project-context.md "Integration tests"). Manual integration smoke is owned by Story 2.2.5 (not a deliverable here).
- **Persistent caches** — `entitiesCache` and `cryptoCache` are in-memory `Map` adapters for now. Disk-backed cache is V1+, not MVP.
- **Telemetry** — Proton Drive's telemetry is privacy-incompatible with the project's NFR. Pass `undefined` for `telemetry`, never wire it.
- **Thumbnail generation** — `uploadFromStream` accepts a thumbnails array; pass `[]`. Story 2.5+ may add thumbnail support later.
- **Photos / shared / bookmarks / devices** — `ProtonDriveClient` exposes a huge surface (50+ methods) for photos, sharing, devices, public links, etc. This story exposes ZERO of those on `DriveClient`. The wrapper grows method-by-method as future stories need them. **Do not pre-emptively wrap anything not in AC3-AC5.**
- **`getFileRevisionUploader` / `getFileRevisionDownloader`** (re-upload existing file revisions) — Story 2.5 will need these for the modify-then-upload case. Out of scope here; `uploadFile` and `downloadFile` only.
- **`subscribeToTreeEvents` / `subscribeToDriveEvents`** — Server-push events for remote changes. Out of scope; the engine's MVP sync model is poll-based via Story 2.5 + watcher (Story 2.6).

### Testing — exact commands

```bash
# Run only sdk.test.ts (during dev)
cd engine && node --import tsx --test src/sdk.test.ts

# Run full engine test suite (before review)
cd engine && node --import tsx --test 'src/**/*.test.ts'

# TypeScript strict-mode compile check (catches noUncheckedIndexedAccess + verbatimModuleSyntax violations)
cd engine && npx tsc --noEmit

# UI test suite (project-context.md mandates running both even for engine-only changes)
meson test -C builddir
```

### Naming conventions (recap from project-context.md)

| Context | Convention | Examples in this story |
|---|---|---|
| TypeScript files | `kebab-case.ts` | `sdk.ts`, `sdk.test.ts` |
| TypeScript classes | `PascalCase` | `DriveClient`, `RemoteFolder` (interface), `UploadBody` |
| TypeScript functions/variables | `camelCase` | `listRemoteFolders`, `uploadFile`, `mapSdkError` |
| TypeScript error classes | `PascalCase` + `Error` suffix | `SyncError`, `NetworkError` (existing) |
| IPC payload fields | `snake_case` | `node_uid`, `revision_uid`, `parent_id`, `display_name`, `storage_used` |
| Timestamps | ISO 8601 | If serializing dates anywhere — but this story passes `Date` objects to the SDK, not strings |

### References

- [Source: `_bmad-output/planning-artifacts/epics.md#Story 2.2`] — Original epic AC list (lines 746-778)
- [Source: `_bmad-output/project-context.md#Critical Implementation Rules`] — Language rules, framework rules, SDK footguns
- [Source: `_bmad-output/planning-artifacts/architecture.md#Project Structure`] — `sdk.ts` is the SDK boundary file (lines 487, 520, 534)
- [Source: `engine/src/sdk.ts`] — Existing placeholder to replace
- [Source: `engine/src/sdk.test.ts`] — Existing 5-test boundary suite to preserve
- [Source: `engine/src/main.ts`] — `handleTokenRefresh` placeholder; **NOT touched in this story** (Story 2.2.5 owns the rewire)
- [Source: `_bmad-output/implementation-artifacts/2-2-5-sdk-live-wiring.md`] — Follow-up story that owns `createDriveClient`, `validateSession`, and the `main.ts` rewire
- [Source: `engine/node_modules/@protontech/drive-sdk/dist/protonDriveClient.d.ts`] — Full `ProtonDriveClient` API
- [Source: `engine/node_modules/@protontech/drive-sdk/dist/interface/nodes.d.ts`] — `MaybeNode`, `NodeEntity`, `NodeType`
- [Source: `engine/node_modules/@protontech/drive-sdk/dist/interface/upload.d.ts`] — `UploadMetadata`, `FileUploader`, `UploadController`
- [Source: `engine/node_modules/@protontech/drive-sdk/dist/interface/download.d.ts`] — `FileDownloader`, `DownloadController`
- [Source: `engine/node_modules/@protontech/drive-sdk/dist/errors.d.ts`] — `ProtonDriveError` hierarchy for the error mapping helper
- [Source: `engine/node_modules/@protontech/drive-sdk/dist/interface/index.d.ts`] — `ProtonDriveClientContructorParameters` (constructor wiring requirements)
- [Source: `engine/node_modules/@protontech/drive-sdk/dist/crypto/openPGPCrypto.d.ts`] — `OpenPGPCryptoProxy` interface for the openpgp adapter
- [Source: `_bmad-output/implementation-artifacts/2-1-sqlite-state-database-and-schema.md`] — Patterns established (review discipline, fresh-state tests, init cleanup on failure)
- [Source: `_bmad-output/implementation-artifacts/2-0-tech-debt-cleanup.md#AC2`] — `debugLog` usage pattern (no tokens, file-cap, env-gated)

### Review Findings

> Code review run 2026-04-10 (Amelia / claude-opus-4-6) — three parallel layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor). 9 patches, 3 decisions, 7 deferrals, ~14 dismissed as noise/false-positives.

**Decision-needed (resolve before patches):**

- [x] [Review][Decision] `sdkErrorFactoriesForTests` is publicly exported from `sdk.ts` — any future engine file could `import { sdkErrorFactoriesForTests }` and instantiate raw SDK error classes, defeating the boundary. The new boundary test only guards against direct package imports, not transitive re-exports. Options: (a) accept and document, (b) add a boundary test asserting no non-test engine file imports the symbol, (c) move factories into a sibling `sdk.test-helpers.ts` file behind a runtime guard. [engine/src/sdk.ts:157-166]
- [x] [Review][Decision] `parent_id: null` is ambiguous — it means both "child of MyFiles root" AND "node where SDK omitted `parentUid`". Folder picker (Story 2.3) will need to disambiguate. Options: (a) accept and let Story 2.3 deal with it via the explicit root call, (b) introduce a sentinel like `parent_id: "<root>"` for top-level, (c) eagerly throw on missing `parentUid` for non-root iterations. [engine/src/sdk.ts:217-221]
- [x] [Review][Decision] `uploadFile` and `downloadFile` do not abort/cancel the caller's `body.stream` or `target` `WritableStream` on failure — caller may leak file descriptors or persist a half-written file. Wrapper-vs-call-site cleanup ownership is unclear. Options: (a) wrapper calls `body.stream.cancel(err)` and `target.abort?.(err)` in the catch (defensive), (b) document call-site responsibility and leave wrapper as-is, (c) defer to Story 2.5 sync engine to own stream lifecycle. [engine/src/sdk.ts:241-294]

**Patch (test/code gaps — fix in this story):**

- [x] [Review][Patch] Add defensive `throw err;` after each `mapSdkError(err);` call so if a future edit accidentally breaks the `never` annotation, the methods still throw instead of silently returning `undefined` [engine/src/sdk.ts:225-228, 260-263, 291-294]
- [x] [Review][Patch] Test gap: no assertion that `iterateFolderChildren` is called with `{ type: NodeType.Folder }` filter hint — a regression dropping the hint would be invisible [engine/src/sdk.test.ts:158-272]
- [x] [Review][Patch] Test gap: `AbortError` re-throw is only verified via `listRemoteFolders` — add coverage for `uploadFile` and `downloadFile` paths [engine/src/sdk.test.ts:454-471]
- [x] [Review][Patch] Test gap: no test for `controller.completion()` rejection in `uploadFile` or `downloadFile` — add one each, asserting the rejection flows through `mapSdkError` [engine/src/sdk.test.ts:274-392]
- [x] [Review][Patch] Test gap: no test for `iterateFolderChildren` throwing mid-iteration (after yielding some nodes) — add one to lock in the all-or-nothing semantics [engine/src/sdk.test.ts:158-272]
- [x] [Review][Patch] `expectMapping` uses `assert.ok` inside the `assert.rejects` validator — when the class check fails, the inner `AssertionError` produces misleading test output. Refactor to return boolean from validator and assert outside [engine/src/sdk.test.ts:399-420]
- [x] [Review][Patch] Add `nodeWithSameName: () => new NodeWithSameNameExistsValidationError(...)` factory and a mapping test that verifies the subclass-before-parent claim — current tests only exercise the base `ValidationError` [engine/src/sdk.ts:157-166, engine/src/sdk.test.ts:394-472]
- [x] [Review][Patch] Add a direct test for the `EngineError` pass-through branch in `mapSdkError` (e.g., wrapper method that internally throws a `SyncError` and confirms it is not re-wrapped as "Unexpected SDK error"). Currently only exercised incidentally via the degraded-root path [engine/src/sdk.ts:101-105, engine/src/sdk.test.ts:394-472]
- [x] [Review][Patch] Tighten boundary test allow-list from substring `.includes("errors")` / `.includes("debug-log")` to exact regex match — current logic would silently allow a future `./errors-helper.ts` or `./debug-log-extra.ts` [engine/src/sdk.test.ts:43-57]

**Deferred (acknowledged, out-of-scope or owned by future story):**

- [x] [Review][Defer] `NodeWithSameNameExistsValidationError` metadata (`existingNodeUid`, `availableName`, `isUnfinishedUpload`) discarded by generic `ValidationError` mapping — Story 2.5 (sync engine) will need to extract this for rename-on-conflict and resume-unfinished-upload flows [engine/src/sdk.ts:128-130] — deferred, downstream story
- [x] [Review][Defer] `RateLimitedError` retry-after / backoff hint dropped — spec explicitly assigns this to Story 3.4 ("this story only normalizes the type") [engine/src/sdk.ts:114-116] — deferred per spec
- [x] [Review][Defer] Empty / whitespace `node.name` accepted verbatim — folder picker UI display concern, not wrapper validation responsibility [engine/src/sdk.ts:217-221] — deferred to Story 2.3 picker
- [x] [Review][Defer] Partial folder list dropped when `iterateFolderChildren` throws mid-iteration — current "all-or-nothing" semantics intentional; degraded-mode partial-list browsing not in scope [engine/src/sdk.ts:206-224] — deferred, semantics intentional
- [x] [Review][Defer] `getClaimedSizeInBytes` not consulted for download verification — out of AC4 scope; Story 2.5 may want it for progress UI / size validation [engine/src/sdk.ts:276-294] — deferred to Story 2.5
- [x] [Review][Defer] Pre-existing `tsc --noEmit` failures (`state-db.ts:1` missing `better-sqlite3`, `main.test.ts:97,144` cast errors, `debug-log.ts:76` implicit-any) — acknowledged in Dev Agent Record; AC7 literal violation but zero new errors introduced [engine/src/state-db.ts:1, engine/src/main.test.ts:97,144, engine/src/debug-log.ts:76] — deferred, pre-existing
- [x] [Review][Defer] `state-db.test.ts` blocked on missing `better-sqlite3` native module (no C toolchain in dev env) — acknowledged in Dev Agent Record; recommend follow-up to install build tools or migrate to `bun:sqlite` per project CLAUDE.md before Story 2.5 [engine/src/state-db.test.ts] — deferred, pre-existing infra gap

## Dev Agent Record

### Agent Model Used

claude-opus-4-6 (Amelia / bmad-agent-dev)

### Implementation Plan

Built the wrapper class in a single sweep — class skeleton, three methods, and the error mapper landed in `engine/src/sdk.ts` together because they're tightly coupled (every method uses `mapSdkError`, and the error mapper needs the SDK error class value imports already at the top of the file). Test suite was authored after implementation rather than strict TDD because the structural fakes (`makeFakeSdk`, `asyncGenOf`) needed the final boundary types (`RemoteFolder`, `UploadBody`, `ProtonDriveClientLike`) to compile.

Key technical choices:

- **JS-side folder filtering** (Task 2.4 ambiguity): the wrapper passes `{ type: NodeType.Folder }` to `iterateFolderChildren` as a server-side hint **and** re-checks `node.type !== NodeType.Folder` client-side. The d.ts comments treat the filter as a hint, not a guarantee, so the redundant client-side check is the cheap belt-and-braces. The filter test uses a fake that yields a mix of file/folder nodes and asserts only folders survive.
- **`Uint8Array<ArrayBufferLike>` cast (Task 3.3)**: not needed in this story. The wrapper passes `ReadableStream<Uint8Array>` straight through to `uploadFromStream` and `WritableStream<Uint8Array>` straight through to `downloadToStream`. TypeScript was happy without any cast because openpgp byte buffers don't flow through the wrapper at all yet — that boundary lights up in Story 2.2.5 / 2.5.
- **`mapSdkError` engine-error pass-through**: caught a self-introduced bug during the test run — when `listRemoteFolders` throws `SyncError("My Files root unavailable")` from inside its own try-block, the catch was passing it to `mapSdkError` which didn't recognize `SyncError` as an SDK error class and re-wrapped it as "Unexpected SDK error". Fixed by adding `if (err instanceof EngineError) throw err;` as the first branch of `mapSdkError` (test caught this — `throws SyncError when My Files root is degraded` was failing on the first run and now passes).
- **Test mock annotations under `noUncheckedIndexedAccess`**: `mock.fn(impl)` infers `arguments` as `never[]` when the impl is a no-arg function, so `mockFn.mock.calls[0]!.arguments[0]` failed `tsc --noEmit`. Fixed by giving the mock implementations explicit parameter signatures (e.g. `mock.fn(async (_parentId: string, _name: string, _metadata: unknown) => fakeUploader)`). The leading underscores mark the params as intentionally unused.
- **Test-only error factories**: To avoid importing `@protontech/drive-sdk` in the test file (project-context.md guidance), added `sdkErrorFactoriesForTests` to `sdk.ts` — a single test-only export that hands out real SDK error instances via factory functions. This is preferable to re-exporting the SDK error classes themselves, which would let other engine code accidentally start checking `instanceof ConnectionError` and bypass the wrapper. Added a new boundary test (`sdk.test.ts does not import @protontech/drive-sdk directly`) that fails if the test file ever tries to.
- **`debug-log.ts` boundary expansion (Task 1 footnote / Dev Notes)**: updated the existing `sdk.ts only imports from errors.ts internally` boundary test to allow `debug-log.ts` as well. Both `errors.ts` and `debug-log.ts` are leaf modules with zero internal imports, so circularity stays impossible. Renamed the test to `sdk.ts only imports from leaf modules (errors.ts, debug-log.ts) internally` and parameterized the allow-list.

Out-of-scope items confirmed deferred to Story 2.2.5 (NOT touched here):
- `createDriveClient(token)` factory
- `validateSession(token)` method
- `engine/src/main.ts:handleTokenRefresh` rewire (`git diff engine/src/main.ts` empty — verified)
- `AccountInfo` interface, `isAuthenticated()` method, internal `token` field — all deleted from `sdk.ts` since they were placeholders that the factory in 2.2.5 will reintroduce in their proper form

### Debug Log

- Initial test run: 24/25 passing. The "throws SyncError when My Files root is degraded" test failed because `mapSdkError` re-wrapped the engine error as "Unexpected SDK error" — fixed with the `EngineError` pass-through branch.
- `tsc --noEmit` flagged 8 `noUncheckedIndexedAccess` errors in `sdk.test.ts` from `mockFn.mock.calls[0]!.arguments[0]` accesses where the mock impls had no parameter types. Fixed by annotating the mock implementations.
- Pre-existing tech debt (NOT introduced by this story; verified via `git stash` then re-run on stashed tree — same errors before and after my changes):
  - `engine/src/state-db.ts:1` — Cannot find module 'better-sqlite3'. The package is in `engine/package.json` but never installed (`npm install` fails because there's no C build toolchain — `make`/`gcc` missing in this dev environment). Story 2.1 was marked done with this hidden dependency miss. Cannot install in scope — story rules forbid touching `package.json`, and the install fails on environment grounds anyway.
  - `engine/src/main.test.ts:97,144` — TS2352 cast errors on `IpcMessage` payloads. Pre-existing; pre-dates this story.
  - `engine/src/debug-log.ts:76` — TS7022 implicit-any on `next` parameter in cause-chain walk. Pre-existing from Story 2.0 area; not in scope.
- `state-db.test.ts` cannot run for the same reason (`better-sqlite3` native module missing). Skipped this single file in the regression run; all other 49 engine tests pass, all 152 UI tests pass. AC7 "no regressions" interpretation: the wrapper change introduces zero new failures — the state-db gap was already broken before this story started.

### Completion Notes

**Story 2.2 — DriveClient SDK wrapper — implementation complete, ready for review.**

What shipped:
- `DriveClient` class in `engine/src/sdk.ts` with three public methods (`listRemoteFolders`, `uploadFile`, `downloadFile`)
- `mapSdkError` private helper covering 8 SDK error classes with subclass-before-parent ordering (`EngineError` pass-through → `AbortError` re-throw → network family → sync family → generic `ProtonDriveError` → unknown fallthrough)
- `RemoteFolder` and `UploadBody` boundary types (snake_case wire shape)
- `ProtonDriveClientLike` test seam type (`Pick<ProtonDriveClient, ...>` over the four consumed methods)
- `sdkErrorFactoriesForTests` — single test-only export for constructing real SDK error instances without importing from `@protontech/drive-sdk` in the test file
- 20 new DriveClient unit tests in `engine/src/sdk.test.ts` (alongside the existing 5 boundary tests + 1 new boundary test = 6 boundary tests total)

What did NOT change (out-of-scope confirmed):
- `engine/src/main.ts` — empty diff (Story 2.2.5 owns the rewire)
- `engine/src/main.test.ts` — empty diff
- `engine/src/errors.ts` — empty diff
- `engine/src/debug-log.ts` — empty diff
- `engine/package.json` — empty diff
- `engine/src/state-db.ts` — empty diff

Validation:
- ✅ `node --import tsx --test src/sdk.test.ts` — 25/25 pass (5 boundary + 1 new boundary + 19 DriveClient suite tests + signature-issues edge case)
- ✅ `node --import tsx --test` for sdk + main + ipc + debug-log — 49/49 pass (all engine tests except state-db.test.ts which is blocked on pre-existing missing native dep)
- ✅ `tsc --noEmit` — zero new errors in `sdk.ts` and `sdk.test.ts`. The 4 remaining errors are all pre-existing in untouched files.
- ✅ `pytest tests/` (UI) — 152/152 pass
- ✅ Boundary grep — only `sdk.ts` imports `@protontech/drive-sdk` and `openpgp` as values; only `sdk.test.ts` mentions `@protontech/drive-sdk` (inside boundary-test string literals)
- ✅ `git diff engine/src/main.ts` — empty

⚠️ Pre-existing tech debt surfaced but NOT in scope:
- `better-sqlite3` is in `engine/package.json` but never installed in this dev environment because the system lacks a C build toolchain (`make`, `gcc` missing). Consequence: `state-db.test.ts` cannot run, and `tsc` flags `state-db.ts:1` as "Cannot find module 'better-sqlite3'". Story 2.1 was marked done with this gap. Recommend a follow-up task: either install build tools (`sudo dnf install gcc gcc-c++ make`) or switch to `bun:sqlite` (per project CLAUDE.md guidance to default to Bun) before Story 2.5 (which will need state-db).
- 2 pre-existing `tsc` cast errors in `main.test.ts` (lines 97, 144) and 1 in `debug-log.ts` (line 76) — all unrelated to this story.

### File List

- `engine/src/sdk.ts` — **rewritten + review patches**: full DriveClient wrapper class, boundary types (`RemoteFolder`, `UploadBody`, `ProtonDriveClientLike`), new `ROOT_PARENT_ID` sentinel for top-level `parent_id`, `mapSdkError` private helper with EngineError pass-through and AbortError re-throw, `sdkErrorFactoriesForTests` test-only export (now includes `nodeWithSameName` factory), type-only SDK type imports, value SDK error class imports (for `instanceof`), `NodeType` and `NodeWithSameNameExistsValidationError` value imports, openpgp namespace import held with `void openpgp` for boundary contract. Review patches: defensive `throw err;` after each `mapSdkError(err);`, defensive `body.stream.cancel(err)` in `uploadFile` catch, defensive `target.abort(err)` in `downloadFile` catch.
- `engine/src/sdk.test.ts` — **rewritten + expanded after review**: 36 tests total across 5 `describe` suites. Boundary suite (×6 — added `sdkErrorFactoriesForTests is only imported by sdk.test.ts`, tightened leaf-module allow-list to exact basenames). `DriveClient.listRemoteFolders` (×9 — added filter-hint assertion, mid-iteration throw, sentinel update for top-level/orphan parent_id). `DriveClient.uploadFile` (×4 — added AbortError, completion-rejection, stream-cancel-on-failure). `DriveClient.downloadFile` (×5 — added AbortError, completion-rejection, target-abort-on-failure). `DriveClient SDK error mapping` (×11 — added `NodeWithSameNameExistsValidationError`, direct `EngineError` pass-through; refactored `expectMapping` so the validator no longer wraps `assert.ok` inside `assert.rejects`).

## Change Log

- 2026-04-10: Story drafted by Bob (SM) — comprehensive context including SDK type reference, error mapping table, dependency wiring guidance, and explicit out-of-scope list.
- 2026-04-10: **Scope cut via party-mode review** (Winston, Amelia, Quinn, Mary, John, Bob — option A approved by Jeremy as lead dev). Carved out `createDriveClient(token)` factory, `validateSession(token)` method, `main.ts:handleTokenRefresh` rewire, all SDK constructor dependencies (HTTPClient, account, openpgp adapter, caches, SRP) into new **Story 2.2.5** (`2-2-5-sdk-live-wiring.md`). This story now ships only the `DriveClient` wrapper class with three methods (`listRemoteFolders`, `uploadFile`, `downloadFile`) + error mapping helper + mocked unit tests + boundary preservation. AC8 → AC7 renumbered, AC5 deleted, Task 4 deleted, Tasks 5-7 renumbered to 4-6. Estimated complexity drop ~40%. Story 2.2.5 is sequenced after Story 2.3 and blocked on Mary's analyst SRP spike (Task 1 of 2.2.5).
- 2026-04-10: Implementation complete (Amelia / claude-opus-4-6). DriveClient wrapper class shipped in `engine/src/sdk.ts` with `listRemoteFolders` / `uploadFile` / `downloadFile` + `mapSdkError` helper + `sdkErrorFactoriesForTests` test seam. 20 new DriveClient unit tests + 1 new boundary test added to `sdk.test.ts`; existing boundary test renamed to allow `debug-log.ts` import. 25/25 sdk tests pass, 49/49 engine tests excluding pre-existing state-db gap, 152/152 UI tests, zero new tsc errors, `engine/src/main.ts` empty diff. Status → review.
- 2026-04-10: **Code review** (Amelia / claude-opus-4-6) — three parallel layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor). 9 patches + 3 decisions + 7 deferrals + ~14 dismissed. All decisions and patches applied: (1) `ROOT_PARENT_ID` sentinel `"<root>"` replaces ambiguous `null` for top-level `parent_id`; (2) defensive `body.stream.cancel(err)` / `target.abort(err)` added to upload/download error paths; (3) defensive `throw err;` after `mapSdkError(err);` in all three methods; (4) new boundary test guards `sdkErrorFactoriesForTests` from non-test engine imports; (5) leaf-module boundary test tightened from substring to exact basename match; (6) `expectMapping` helper refactored — no more `assert.ok` inside `assert.rejects` validator; (7) added test coverage for filter hint, mid-iteration throw, AbortError via upload/download, completion() rejection via upload/download, NodeWithSameNameExistsValidationError mapping, and direct EngineError pass-through. 36/36 sdk tests pass (was 25), 60/60 engine tests across sdk + main + ipc + debug-log, zero new tsc errors. Status → done.
