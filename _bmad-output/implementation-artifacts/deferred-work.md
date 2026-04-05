# Deferred Work

## Deferred from: code review of stories 1-1 through 1-5 (2026-04-04)

- `DriveClient.sdkClient = null`, `_token` discarded — intentional stub; Story 3.1 will implement real SDK initialization [src/sdk/client.ts]
- `import "./sdk/client.js"` side-effect in `cli.ts` — documented design decision to enforce SDK boundary at bundle time; revisit if causes issues
- `conflict_strategy` option parsed but never consumed — future sync stories will use it
- `DriveItem`/`DriveItemMetadata` structural duplication — refactor candidate (extend or use intersection type)
- `mtime` untyped as plain `string` — no nominal typing; TypeScript branding not applied
- `upsert`/`close()` lifecycle guards (use-after-close, double-close) — defensive programming beyond current spec
- `getLastSync` returns `null`; null-handling is caller responsibility — ensure callers guard this
- `uploadFile` missing local file existence check — Story 3.2 scope
- `JSON.stringify` circular reference protection in `formatSuccess`/`formatError` — caller responsibility
- `ProtonDriveError` empty-code guard — defensive beyond spec
- `getLastSync MAX()` on TEXT column — ISO 8601 lexicographic sort correct if format consistent; add ISO 8601 validation if format ever diverges
- `withRetry` post-loop `isTransientError` includes redundant `NetworkError` check (dead code — raw SDK errors haven't been mapped yet at that point)

## Deferred from: code review of stories 3-1 through 5-1 (2026-04-04)

- `sha256File` uses `fs.readFileSync` — entire file buffered into memory; will OOM on multi-GB files; stream-based hashing is the fix [src/core/sync-engine.ts:21]
- `SyncEngine alreadyHandled` linear scan O(n²) — `[...localToRemote.values()].includes()` per remote file; replace with a `Set<string>` built from localToRemote values [src/core/sync-engine.ts:137-138]
- `FAKE_TOKEN` in sync-engine.test.ts missing `refreshToken` field — diverges from SessionToken type; harmless while SDK is mocked but will surface as a type error once real SDK calls are wired [src/core/sync-engine.test.ts:69]
- `StateDB` rowToRecord casts `state` without runtime validation — corrupt/manually-edited DB row with unknown state produces `undefined` priority in status command aggregate logic; add a runtime guard on state values [src/core/state-db.ts]
- Concurrent downloads to same `localPath` share a `.protondrive-tmp` suffix — two sync pairs with the same local destination will race on the temp file; use a unique temp suffix (e.g. UUID) to prevent collision
- `download.ts` directory detection uses `listFolder returning []` as "single file" signal — fragile once real SDK is wired; remote empty directories will be mis-classified as files
- `handleRemoteOnlyFile` missing SHA-256 hash check — `DriveItem` has no hash field; needs `getFileMetadata()` (currently throws NOT_IMPLEMENTED) to compare remote hash before deciding to download; defer until SDK stub is filled [src/core/sync-engine.ts]

## Deferred from: code review of stories 2-1, 2-2, 2-3 (2026-04-04)

- `expandPassword` silently truncates passwords > 64 UTF-8 bytes [src/auth/srp.ts:93-99] — intentional per Proton SRP spec; no fix needed unless Proton changes their spec
- `createCredentialStore` doesn't handle `FileStore()` constructor throwing (requires HOME-less environment) — extremely unlikely; defensive guard if running in unusual containers
- Only `accessToken` stored; `refreshToken` and `uid` discarded — intentional v1 design decision per Story 2.3 task spec; will need to store full session if token refresh is ever added

## Deferred from: code review of stories 6-1 through 6-3 (2026-04-04)

- `AppRun` missing `${APPDIR:?}` guard — manual extraction without AppImage runtime leaves `$APPDIR` empty, silently executes system binary; add guard for correctness [packaging/appimage/build-appimage.sh:42]
- `packaging/nix/flake.nix` placeholder `sha256-AAAA…` — update with `nix-prefetch-url --unpack <tarball-url>` on first release [packaging/nix/flake.nix:24]
- Release workflow (`release.yml`) missing `bunx tsc --noEmit` step before binary build — type errors can ship via direct tag push bypassing PR CI; add as release gate
- `appimagetool` should be pinned to a specific release tag with a verified SHA rather than the rolling `continuous` tag — deferred pending decision on tooling pinning strategy

## Deferred from: code review of 2-4-totp-2fa-support (2026-04-05)

- Server proof verification optional — `if (auth.ServerProof)` guard means MitM can strip the field and void mutual auth; TODO comment present; defer until Proton API behavior confirmed [src/auth/srp.ts:325]
- bcrypt 72-byte input truncation — `expandPassword` produces ~88 base64 chars but bcrypt silently truncates at 72; last ~16 chars of encoded output ignored; matches known Proton SRP client behavior but worth tracking [src/auth/srp.ts:98-126]
- Password not zeroed in JS strings — `password` param is an immutable JS string; cannot be zeroed before GC; heap/crash dump exposure risk; architectural limitation of JS runtime [src/auth/srp.ts:217]
- `_handle?.setRawMode` uses undocumented internal API — public API is `process.stdin.setRawMode()`; silent failure leaves password echoed to terminal; replace with public API [src/commands/auth-login.ts:27]
- `fetchJson` treats HTTP 422 as success — 422 responses bypass `!response.ok` check and are parsed as `T`; Proton API uses 422 for application errors; callers only see AUTH_FAILED [src/auth/srp.ts:195]
- SRP exponent `(a + u*x) % (N-1n)` — verify this matches Proton's Go/JS SRP clients; incorrect modulus could cause sporadic auth failures [src/auth/srp.ts:269]
- `Modulus` field received but ignored — hardcoded `N_HEX` is used instead; intentional to prevent substitution attack, but needs a security comment for future maintainers [src/auth/srp.ts:231]
- `promptUsername` (readline) + `promptPassword` (raw data listener) use incompatible stdin interfaces — readline may buffer-ahead and cause lost characters for the raw listener; unify stdin approach [src/commands/auth-login.ts:8-73]

## Deferred from: code review of 7-1-cli-binary-smoke-e2e-tests (2026-04-05)

- `run()` spreads full `process.env` into every `spawnSync` call — could forward live credentials (e.g. `PROTON_EMAIL`, tokens) present in developer shell envs; a minimal explicit env would be more hermetic [src/__e2e__/cli.e2e.test.ts:18-21]

## Deferred from: code review of 7-2-live-protondrive-integration-tests (2026-04-05)

- DriveClient constructor `this.sdkClient = null as unknown as ProtonDriveClient` — intended factory design; unit tests never call live SDK methods; safe until createLiveDriveClient is used [src/sdk/client.ts:140]
- `_setSdkClient` is a public method — @internal JSDoc present; accepted trade-off for factory pattern and unit test mock friendliness [src/sdk/client.ts:143]
- Path traversal via unsanitized remote path segments (e.g. `..`) — segments passed to ProtonDrive SDK/API which enforces its own tree boundaries server-side [src/sdk/client.ts:169]
- `importPrivateKey` returns locked key when no passphrase supplied — SDK usage pattern; locked keys produce actionable errors at use time rather than at import [src/sdk/openpgp-proxy.ts:61]
- `encryptMessage` return uses `as never` to bypass TypeScript return type check — type-only workaround for SDK's complex return type overloads; runtime behavior unaffected [src/sdk/openpgp-proxy.ts:116]
- `hasProtonAccount` always returns true — story spec explicitly notes this is not used for file operations; sharing/collaboration features not in scope [src/sdk/account-service.ts:137]
- Partial upload leaves orphaned remote node on mid-stream failure — no `uploader.cancel()` call; SDK may not expose synchronous cancel; ProtonDrive cleans up incomplete uploads eventually [src/sdk/client.ts:265]
- Duplicate folder names at same level silently picks first match — ProtonDrive API prevents duplicate child names within the same parent; defensive dedup not needed [src/sdk/client.ts:184]
- Folder UID cycle detection absent — ProtonDrive API prevents cycles in the node tree by design [src/sdk/client.ts:178]
- `listFolder` returns `size: 0` for all items and epoch mtime for folders — acknowledged pre-existing limitation (see earlier deferred-work entry); blocks conflict detection for affected items [src/sdk/client.ts:242]
- `withRetry` mapSdkError `never` contract is load-bearing but undocumented — if mapSdkError ever returns for a specific error class, withRetry silently returns undefined as T; add a comment noting the never contract is required for control flow [src/sdk/client.ts:153]
- HTTP client drops default auth headers when SDK passes request.headers — `request.headers ?? headers()` means SDK-supplied headers replace auth headers entirely; acceptable if SDK handles its own auth when it overrides headers; assumption should be documented [src/sdk/client.ts:100]
- uploadFile no duplicate-name check on remote — SDK/server behavior on same-name file (overwrite vs. new revision vs. throw) is undefined in the DriveClient layer; ProtonDrive handles versioning server-side [src/sdk/client.ts:257]
- Orphaned .dl-tmp-* files on download retry — failed attempt's tmp cleaned in catch, but on retry success the new attempt creates a fresh tmp; old partial tmp is only deleted if it throws [src/sdk/client.ts:282]
- buildSRPProof passes empty username to computeX/computeClientProof — inconsistent with authenticate which uses real username; getSrp only called by SDK for link-password operations not in v1 scope [src/auth/srp.ts:233]
- Empty PrivateKey string silently skips key — if all addr.Keys have empty PrivateKey strings (Proton API regression), error "Failed to decrypt any address keys" misleads user into thinking password is wrong [src/sdk/account-service.ts:95]

## Deferred from: code review of 7-3-e2e-ci-workflow (2026-04-05)

- `CI_WORKFLOW` read unconditionally in workflow.test.ts without `existsSync` guard — throws ENOENT instead of clean assertion failure if ci.yml is absent [src/__e2e__/workflow.test.ts:112]
- `loadWorkflow` called redundantly inside every test with no `beforeAll` cache — cosmetic inefficiency [src/__e2e__/workflow.test.ts]
- No Dependabot or equivalent configured to refresh pinned action SHAs — project-wide infra gap; all three workflow files affected [.github/workflows/]
- `toContain("push")` condition check in integration step test is slightly loose — would pass for `push_event` pattern too [src/__e2e__/workflow.test.ts:114]
- No cross-workflow Bun version consistency check — e2e.yml, ci.yml, release.yml all pin `bun-version: "1.3.11"` but tests don't enforce parity [src/__e2e__/workflow.test.ts]
