# Story 8.6: SDK Client Identification — x-pm-appversion Header

Status: done

## Story

As a maintainer,
I want all Proton API requests to carry the correct `x-pm-appversion` header,
so that the app accurately identifies itself and does not spoof another Proton client.

## Background

`ProtonHTTPClient` in `engine/src/sdk.ts` (lines 910–978) currently injects
`"web-drive@5.0.0.0"` — the Proton web client's app identity — into every API
request. Proton's API policy requires external clients to use their own
registered identity in the format `{client-id}@{version}` and prohibits
spoofing or falsifying this value.

**Correct identity:** `ronki230-ProtonDriveLinuxClient@{version}`
where `{version}` is the `"version"` field from `engine/package.json`
(currently `"0.1.0"`).

The `fetchBlob` method already contains correct detection logic for
storage servers (lines 945–950): `x-pm-appversion` is only set when
`isProtonApi` is true (URL contains `protonmail.com`, `proton.me/core`,
or `proton.me/drive`). Storage hosts like `fra-storage.proton.me` do NOT
match, so they already receive no `x-pm-appversion`. The fix is the value
only, not the conditional logic.

## Acceptance Criteria

### AC1 — `fetchJson` sends correct appversion

**Given** any call that routes through `ProtonHTTPClient.fetchJson`
**When** the engine makes an API call
**Then** `x-pm-appversion` is set to `ronki230-ProtonDriveLinuxClient@{version}`
**And** `{version}` matches `"version"` in `engine/package.json`

### AC2 — `fetchBlob` Proton-host path sends correct appversion

**Given** a `fetchBlob` request to a Proton API host (URL contains `protonmail.com`,
`proton.me/core`, or `proton.me/drive`)
**When** `isProtonApi` evaluates true
**Then** `x-pm-appversion` is set to `ronki230-ProtonDriveLinuxClient@{version}`

### AC3 — `fetchBlob` storage-host path has no appversion

**Given** a `fetchBlob` request to a storage host (e.g. `fra-storage.proton.me`)
**When** `isProtonApi` evaluates false
**Then** `x-pm-appversion` is NOT present in the outgoing headers

### AC4 — `"web-drive@5.0.0.0"` removed

**Given** the string `"web-drive@5.0.0.0"` in the codebase
**When** this story is complete
**Then** it does not appear anywhere in `engine/src/`

### AC5 — Tests pass

**When** `bun test 'src/*.test.ts'` runs from `engine/`
**Then** all existing tests pass, zero regressions
**And** new unit tests cover AC1, AC2, and AC3

## Tasks / Subtasks

- [x] **Task 1 — Import version from package.json** (AC1, AC2)
  - [x] 1.1 Add `import pkg from "../package.json" with { type: "json" }` near the top of `engine/src/sdk.ts` — place it with the other non-SDK imports (after the `@protontech/drive-sdk` imports block, before the internal declarations)
  - [x] 1.2 Define two module-level constants immediately after the import:
        ```typescript
        const APP_ID = "ronki230-ProtonDriveLinuxClient";
        const APP_VERSION: string = pkg.version;
        ```

- [x] **Task 2 — Replace both hardcoded appversion occurrences** (AC1, AC2, AC4)
  - [x] 2.1 In `ProtonHTTPClient.fetchJson` (line 917), replace:
        `headers.set("x-pm-appversion", "web-drive@5.0.0.0")`
        with:
        `headers.set("x-pm-appversion", \`${APP_ID}@${APP_VERSION}\`)`
  - [x] 2.2 In `ProtonHTTPClient.fetchBlob` Proton-API branch (line 949), apply the same replacement
  - [x] 2.3 Confirm `grep -r "web-drive@5.0.0.0" engine/src/` returns no matches

- [x] **Task 3 — Expose test-only HTTP client factory** (AC1, AC2, AC3)
  - [x] 3.1 At the very bottom of `engine/src/sdk.ts` (after `createDriveClient`), add:
        ```typescript
        export const _forTesting = {
          createHTTPClient: (token: string, uid?: string) =>
            new ProtonHTTPClient(token, uid),
        };
        ```
        The `_forTesting` prefix signals non-public API; no other engine file may import it.

- [x] **Task 4 — Add unit tests** (AC1, AC2, AC3, AC5)
  - [x] 4.1 In `engine/src/sdk.test.ts`, add a new describe block (after the existing
        `ProtonHTTPClient via createDriveClient` block at line 1235):
        ```
        describe("ProtonHTTPClient appversion header", () => { ... })
        ```
  - [x] 4.2 Import `_forTesting` from `./sdk.js` at the top of the test file
  - [x] 4.3 Write test: `fetchJson` sets correct appversion (AC1)
        — create instance via `_forTesting.createHTTPClient("token")`
        — mock `globalThis.fetch` to return a 200 JSON response
        — call `httpClient.fetchJson({ url: "https://api.protonmail.ch/core/v4/users", method: "GET", headers: new Headers(), timeoutMs: 5000 })`
        — assert captured headers contain `x-pm-appversion` equal to `` `ronki230-ProtonDriveLinuxClient@${pkg.version}` ``
  - [x] 4.4 Write test: `fetchBlob` Proton-host sets correct appversion (AC2)
        — URL changed to `"https://api.proton.me/drive/v2/shares"` (matches `proton.me/drive` pattern in isProtonApi; story used `.ch` which doesn't match)
        — assert `x-pm-appversion` is `` `ronki230-ProtonDriveLinuxClient@${pkg.version}` ``
  - [x] 4.5 Write test: `fetchBlob` storage-host has no appversion (AC3)
        — call with URL `"https://fra-storage.proton.me/upload/block"`
        — assert `x-pm-appversion` header is `null` (absent)
  - [x] 4.6 Run `bun test src/sdk.test.ts` from `engine/` — 84 pass, 0 fail

- [x] **Task 5 — Full test suite validation** (AC5)
  - [x] 5.1 Run `bun test ./src/*.test.ts` from `engine/` — 403 pass, 0 fail, zero regressions
  - [x] 5.2 Run `.venv/bin/pytest ui/tests/` — 696 pass (story does not touch UI; no meson build dir present, pytest ran directly without issue)
  - [x] 5.3 Set story status to `review`

## Dev Notes

### Exact lines to edit in `engine/src/sdk.ts`

```
Line 917 (fetchJson):
  BEFORE: if (!headers.has("x-pm-appversion")) headers.set("x-pm-appversion", "web-drive@5.0.0.0");
  AFTER:  if (!headers.has("x-pm-appversion")) headers.set("x-pm-appversion", `${APP_ID}@${APP_VERSION}`);

Line 949 (fetchBlob, isProtonApi branch):
  BEFORE: if (!headers.has("x-pm-appversion")) headers.set("x-pm-appversion", "web-drive@5.0.0.0");
  AFTER:  if (!headers.has("x-pm-appversion")) headers.set("x-pm-appversion", `${APP_ID}@${APP_VERSION}`);
```

Both lines use `if (!headers.has(...))` to allow the SDK to override — keep that guard; only change the value string.

### JSON import syntax (project rule)

Per `project-context.md` "JSON imports require assertion":
```typescript
import pkg from "../package.json" with { type: "json" };
```
Path is relative to `engine/src/sdk.ts` → `engine/package.json` is one directory up: `"../package.json"`.

### `_forTesting` placement and restriction

Place it at the very end of `sdk.ts`, after `createDriveClient`. It must never be imported by `sync-engine.ts`, `ipc.ts`, `state-db.ts`, or any other engine file. The `_` prefix and the comment are the enforcement signals.

### `isProtonApi` — do NOT change

The storage-host detection logic at line 945 is correct and must remain untouched:
```typescript
const isProtonApi = request.url.includes("protonmail.com")
  || request.url.includes("proton.me/core")
  || request.url.includes("proton.me/drive");
```
Storage servers like `fra-storage.proton.me` do NOT contain these substrings, so they never receive `x-pm-appversion`. AC3 is already architecturally satisfied; only the value in the `isProtonApi` branch changes.

### Test fetch mock pattern (match existing style)

The existing `ProtonHTTPClient via createDriveClient` describe block (line 1185) shows the pattern: replace `globalThis.fetch` in `beforeAll`, restore in `afterAll`, call `mockedFetch.mockClear()` between tests. The new describe block uses the same pattern with `_forTesting.createHTTPClient()` instead of `createDriveClient()`.

For the storage-host test (AC3), assert that `headers.get("x-pm-appversion")` is `null` — `Headers.get()` returns `null` for absent headers.

### `pkg.version` in tests

Import `pkg` the same way in `sdk.test.ts`:
```typescript
import pkg from "../package.json" with { type: "json" };
```
Then assert: `expect(headers.get("x-pm-appversion")).toBe(\`ronki230-ProtonDriveLinuxClient@${pkg.version}\`)`.
This keeps the expected value DRY — if version bumps, tests still pass without edits.

### Files touched

- `engine/src/sdk.ts` — 4 changes: add import, add 2 constants, replace 2 header values, add `_forTesting` export
- `engine/src/sdk.test.ts` — add import of `_forTesting` and `pkg`; add new describe block with 3 tests

No Python, Blueprint, Meson, or UI files are touched.

### Project Structure Notes

- Engine source is flat: `engine/src/*.ts` — no subdirectories. Do NOT create `engine/src/version.ts` or similar. The 2-constant approach in `sdk.ts` is sufficient.
- `pkg.version` is a `string` at runtime; the `const APP_VERSION: string = pkg.version` annotation prevents TypeScript narrowing to a literal type that could cause surprises.
- `errors.ts` has zero internal imports — this story does not touch errors.ts.

### References

- `ProtonHTTPClient` class: `engine/src/sdk.ts:910-978`
- Line 917 (fetchJson appversion): `engine/src/sdk.ts:917`
- Line 949 (fetchBlob appversion): `engine/src/sdk.ts:949`
- isProtonApi logic: `engine/src/sdk.ts:945`
- Existing HTTP client tests: `engine/src/sdk.test.ts:1185-1235`
- engine version: `engine/package.json` — `"version": "0.1.0"`
- JSON import rule: `_bmad-output/project-context.md` — "JSON imports require assertion"
- Story 8-5 file list: `_bmad-output/implementation-artifacts/8-5-license-alignment.md` — confirms `"version"` in package.json is managed by `bump-version.sh` (do not touch it)

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- Added `import pkg from "../package.json" with { type: "json" }` plus `APP_ID` and `APP_VERSION` constants to `engine/src/sdk.ts` after the internal engine imports.
- Replaced both `"web-drive@5.0.0.0"` occurrences in `fetchJson` (line 917) and `fetchBlob` Proton-API branch (line 949) with `` `${APP_ID}@${APP_VERSION}` ``. Zero occurrences remain in `engine/src/`.
- Added `export const _forTesting` at end of `engine/src/sdk.ts` to expose `ProtonHTTPClient` constructor for unit testing without a full SDK setup.
- Added `describe("ProtonHTTPClient appversion header")` block in `engine/src/sdk.test.ts` with 3 tests covering AC1, AC2, AC3. Note: AC2 test URL changed from `api.protonmail.ch` (story spec) to `api.proton.me/drive/v2/shares` — the `.ch` domain does not match the `isProtonApi` pattern (`protonmail.com | proton.me/core | proton.me/drive`); `.com` or `proton.me` paths are required.
- Engine: 403 pass, 0 fail. UI: 696 pass.

### File List

- `engine/src/sdk.ts`
- `engine/src/sdk.test.ts`

### Review Findings

- [x] [Review][Defer] `subscribeToRemoteEvents` `as EventSubscription` cast — SDK provides no public subscription type; interface defined locally from dist/internal; if SDK renames `dispose()` the runtime will throw `TypeError` with no engine error wrapping [`engine/src/sdk.ts:802`] — deferred, pre-existing design constraint from Story 8-1
- [x] [Review][Defer] `capturedHeaders` shared mutable state in appversion test suite — starts `undefined`; any future test inserted before a mock-firing call would throw `TypeError` reading `capturedHeaders.get(...)` [`engine/src/sdk.test.ts:~1245`] — deferred, minor test quality concern, not a correctness bug
- [x] [Review][Defer] `isProtonApi` misses `proton.me/[other-service]` paths — e.g. `proton.me/auth/...` or `proton.me/calendar/...` fall through to storage-host branch and receive no auth headers; pre-existing, not changed by 8-6 [`engine/src/sdk.ts:~949`] — deferred, pre-existing

## Change Log

- 2026-04-25: Replaced `web-drive@5.0.0.0` with `ronki230-ProtonDriveLinuxClient@{version}` in both `fetchJson` and `fetchBlob`; added `_forTesting` export and 3 unit tests for AC1/AC2/AC3. (claude-sonnet-4-6)
