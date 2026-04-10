# Story 2.2.5: SDK Live Wiring — Factory, validateSession & main.ts Rewire

Status: backlog

> **Why this story exists:** Story 2.2 (SDK DriveClient Wrapper) was carved by party-mode consensus on 2026-04-10 to ship the wrapper class + tests + boundary only. The live SDK wiring — constructor dependencies, openpgp adapter, HTTPClient, account adapter, SRP module, `validateSession`, and the `main.ts:handleTokenRefresh` rewire — was extracted into this story so the wrapper API stays clean and the live-wiring concerns (which span Proton's auth protocol and require manual integration smoke) get their own dedicated focus.
>
> **Sequence in epic:** Story 2.2 → 2.3 (Folder Picker, mocked DriveClient OK) → **this story** → 2.4 (Setup Wizard) → 2.5 (Sync Engine Core). This places live SDK validation directly before the first story that depends on it under load.
>
> **Critical pre-work:** Mary's SRP spike (Task 1 below) MUST land before any dev work. If the spike concludes "no Node-compatible Proton SRP module exists," this story stalls and the team has a bigger architectural conversation. Do not skip the spike.

## Story

As a **sync engine developer**,
I want **`createDriveClient(token)` to construct a real `ProtonDriveClient` against live Proton infrastructure and `main.ts` to rewire `handleTokenRefresh` to use it**,
so that **the engine's `session_ready` event carries real account data, the `DriveClient` wrapper can actually be instantiated outside of unit tests, and Story 2.5 (sync engine core) has a working SDK to drive uploads and downloads.**

## Acceptance Criteria

> **DRAFT — to be expanded by SM (Bob) once the SRP spike completes.** The ACs below are placeholders capturing the team's consensus shape; final wording depends on what Mary's spike surfaces.

**AC1 — SRP module wiring path confirmed:**
**Given** Mary's analyst spike (Task 1) has completed
**When** the spike report is reviewed
**Then** the team has a documented path forward for Proton SRP integration: either (a) a Node-compatible Proton SRP module identified, (b) a Proton-published SRP package referenced, OR (c) an explicit architectural decision recorded in `_bmad-output/planning-artifacts/architecture.md` deferring SRP-dependent flows
**And** if (c) is chosen, the rest of this story is rescoped or blocked accordingly

**AC2 — `createDriveClient(token)` factory in `engine/src/sdk.ts`:**
**Given** the wrapper class shipped in Story 2.2
**When** calling `createDriveClient(token)`
**Then** it constructs a real `ProtonDriveClient` with all required dependencies wired:
  - `httpClient` — Node 22 global `fetch` adapter, injecting `Authorization: Bearer ${token}` header, supporting `timeoutMs` via `AbortSignal.timeout()` combined with caller signal via `AbortSignal.any()`
  - `entitiesCache` — in-memory `Map<string, string>` adapter
  - `cryptoCache` — in-memory `Map<string, CachedCryptoMaterial>` adapter
  - `account` — adapter implementing `ProtonDriveAccount` interface; minimal token-only flow with `getOwnPrimaryAddress`, `getOwnAddresses`, `getPublicKeys`, `hasProtonAccount`
  - `openPGPCryptoModule` — `OpenPGPCryptoWithCryptoProxy` from the SDK, wrapping an `OpenPGPCryptoProxy` adapter that delegates to openpgp v6 (`openpgp.generateKey`, `openpgp.encryptSessionKey`, etc.)
  - `srpModule` — per the path confirmed in AC1
  - `config` — `{ baseUrl: "drive-api.proton.me", clientUid: "io.github.ronki2304.ProtonDriveLinuxClient" }`
  - `telemetry` / `featureFlagProvider` / `latestEventIdProvider` — undefined (or `NullFeatureFlagProvider` for feature flags)
**And** all `Uint8Array<ArrayBufferLike>` ↔ `Uint8Array<ArrayBuffer>` casts live inside `sdk.ts`, never leaking to call-sites
**And** the SDK boundary is preserved — `sdk.ts` remains the sole importer of `@protontech/drive-sdk` and `openpgp` (existing boundary tests still pass)
**And** `createDriveClient` failure modes (network down at construction, invalid token, openpgp init failure) are wrapped in typed engine errors and the partial construction tears down cleanly without leaking HTTP connections or open sockets

**AC3 — `validateSession(token)` method on `DriveClient`:**
**Given** a `DriveClient` constructed via `createDriveClient(token)`
**When** calling `validateSession(token)`
**Then** it returns `Promise<AccountInfo>` where `AccountInfo = { display_name: string; email: string; storage_used: number; storage_total: number; plan: string }` (snake_case)
**And** internally it round-trips through the `account.getOwnPrimaryAddress()` (or equivalent) to confirm the token is valid
**And** on auth rejection it throws `NetworkError("Authentication failed", { cause: err })` per Story 2.2 AC5 (now renumbered AC5) error mapping rules
**And** storage and plan fields may be zero/empty initially with `// TODO(story-2.x)` comments — full account metadata fetch deferred until a downstream story needs it

**AC4 — `main.ts:handleTokenRefresh` rewired:**
**Given** `engine/src/main.ts` (currently emits a placeholder hardcoded `session_ready` payload)
**When** a `token_refresh` IPC command arrives
**Then** `handleTokenRefresh` calls `createDriveClient(token)` then `client.validateSession(token)` and emits the resulting real `AccountInfo` as the `session_ready` event payload
**And** on any thrown engine error, emits `token_expired` (existing failure path)
**And** the `// TODO: Story 1-13 will add DriveClient.validateSession(token)` comment in `main.ts` is deleted
**And** `main.test.ts` is updated if it currently asserts the old hardcoded payload shape

**AC5 — Manual integration smoke test documented and executed:**
**Given** the wiring is complete
**When** running the manual integration smoke per the checklist below
**Then** the engine emits a real `session_ready` event with the actual Proton account email, observed by a manual UI test or by reading the IPC socket directly
**And** the smoke test checklist is committed to `CONTRIBUTING.md` (or `engine/src/__integration__/README.md`):
  1. Get fresh Proton token via dev auth flow (Story 1.7-1.9 produced this flow)
  2. Set `PROTON_TEST_TOKEN` env var
  3. Run `node --import tsx engine/src/main.ts`
  4. Connect via IPC (or run the UI in dev mode and observe)
  5. Confirm `session_ready` payload contains real `email` matching the token's account
  6. Tear down: kill the engine, clear `PROTON_TEST_TOKEN`, do NOT commit the token

**AC6 — All tests green:**
**Given** the engine and UI test suites
**When** running `node --import tsx --test 'engine/src/**/*.test.ts'` and `meson test -C builddir`
**Then** all existing tests still pass (zero regressions)
**And** any new unit tests added for the factory adapters (HTTP, account, openpgp proxy) are isolated — they mock external dependencies, never hit the real network in unit mode
**And** the manual integration smoke (AC5) is verified by hand and recorded in Dev Agent Record

## Tasks / Subtasks

- [ ] **Task 1: Analyst Spike — SRP Module Wiring Path** (AC: #1) — **OWNER: Mary (bmad-agent-analyst)** — **MUST COMPLETE BEFORE DEV WORK**
  - [ ] 1.1 Read the `SRPModule` interface from the SDK. Locate the `.d.ts` (likely in `engine/node_modules/@protontech/drive-sdk/dist/crypto/` or `internal/`). Document the exact interface shape: methods, parameter types, return types.
  - [ ] 1.2 Search the SDK source for any reference implementation of `SRPModule` — does the SDK ship a default? Is there a bundled adapter? Check `engine/node_modules/@protontech/drive-sdk/dist/internal/` for hints.
  - [ ] 1.3 Search npm for Node-compatible Proton SRP modules: keywords `proton srp`, `proton account`, `srp-6a node`, `proton drive client node`. Note any matches with their version, last update, and whether they target Proton's specific SRP variant (Proton uses a customized SRP-6a — generic SRP libraries do NOT work).
  - [ ] 1.4 Inspect Proton's open-source web client repo (`github.com/ProtonMail/WebClients`) for their SRP implementation — that's the canonical reference. Document the file path. Determine licensing (GPL? AGPL? MIT?) and whether it can be ported or vendored into this Flatpak'd Linux client.
  - [ ] 1.5 Recommend ONE of three paths in a written report (`_bmad-output/planning-artifacts/research/srp-spike-2026-04-XX.md`):
    - **Path A:** Use an identified Node-compatible package (cite name, version, license, integration sketch)
    - **Path B:** Vendor/port Proton's web SRP into `engine/src/sdk.ts` (cite source file, license, estimated LOC)
    - **Path C:** Cannot resolve in current scope — recommend deferring SRP-dependent flows (e.g., the engine relies entirely on the libsecret-stored session cookie injected via `Authorization` header, bypassing SRP at the SDK boundary; this requires confirming the SDK's HTTP path doesn't internally invoke SRP for token refresh — likely needs reading `protonDriveClient.js` source)
  - [ ] 1.6 Time-box: **1 hour maximum**. If the spike runs over without a clear recommendation, that itself is the finding — escalate immediately to Bob (SM) and Winston (Architect) for a course-correct conversation.
  - [ ] 1.7 Hand off the spike report to Bob (SM). Bob expands AC2-AC4 of this story to match the chosen path before unblocking dev work.

- [ ] **Task 2: HTTPClient adapter** (AC: #2) — _depends on Task 1_
  - [ ] 2.1 Implement `ProtonDriveHTTPClient` adapter using Node 22 global `fetch`
  - [ ] 2.2 Inject `Authorization: Bearer ${token}` header on every request
  - [ ] 2.3 Apply `timeoutMs` via `AbortSignal.timeout()` combined with caller signal via `AbortSignal.any([...])`
  - [ ] 2.4 Map `ProtonDriveHTTPClientJsonRequest` and `ProtonDriveHTTPClientBlobRequest` shapes to `fetch(url, init)` calls
  - [ ] 2.5 Return native `Response` directly (both `fetchJson` and `fetchBlob` return `Response`)
  - [ ] 2.6 Unit test with `node:test` mock fetch — verify auth header injection, timeout chaining, body shape

- [ ] **Task 3: In-memory cache adapters** (AC: #2) — _depends on Task 1_
  - [ ] 3.1 Implement `ProtonDriveEntitiesCache` as in-memory `Map<string, string>` (verify exact `ProtonDriveCache<T>` interface from `cache/index.d.ts` first)
  - [ ] 3.2 Implement `ProtonDriveCryptoCache` as in-memory `Map<string, CachedCryptoMaterial>`
  - [ ] 3.3 Both adapters live inside `sdk.ts` — no new files
  - [ ] 3.4 Unit test cache CRUD operations

- [ ] **Task 4: Account adapter** (AC: #2) — _depends on Task 1_
  - [ ] 4.1 Implement minimal `ProtonDriveAccount` adapter satisfying the interface from `engine/node_modules/@protontech/drive-sdk/dist/interface/account.d.ts:2-33`
  - [ ] 4.2 `getOwnPrimaryAddress` round-trips through the HTTPClient adapter to fetch the account's primary address
  - [ ] 4.3 `getOwnAddresses` similar
  - [ ] 4.4 `getPublicKeys(email)` and `hasProtonAccount(email)` — implementation TBD pending spike findings on whether full key retrieval is needed for token-only flow
  - [ ] 4.5 Unit test with mocked HTTPClient

- [ ] **Task 5: openpgp v6 → OpenPGPCryptoProxy adapter** (AC: #2) — _depends on Task 1_
  - [ ] 5.1 Implement an `OpenPGPCryptoProxy` adapter (interface in `engine/node_modules/@protontech/drive-sdk/dist/crypto/openPGPCrypto.d.ts:6-96`) that delegates each method to openpgp v6
  - [ ] 5.2 Apply `Uint8Array<ArrayBufferLike>` ↔ `Uint8Array<ArrayBuffer>` casts at every method boundary — confined to this adapter
  - [ ] 5.3 Wrap the adapter in `OpenPGPCryptoWithCryptoProxy` from the SDK (`engine/node_modules/@protontech/drive-sdk/dist/crypto/openPGPCrypto.d.ts:102`)
  - [ ] 5.4 Unit test the adapter with deterministic openpgp inputs (generate a known key, encrypt/decrypt round-trip)

- [ ] **Task 6: SRP module wiring** (AC: #1, #2) — _per Mary's spike conclusion_
  - [ ] 6.1 Implementation depends entirely on Task 1 outcome. Bob will expand this task with concrete subtasks once the spike report lands.

- [ ] **Task 7: `createDriveClient(token)` factory** (AC: #2) — _depends on Tasks 2-6_
  - [ ] 7.1 Compose all adapters into `ProtonDriveClientContructorParameters`
  - [ ] 7.2 Construct `new ProtonDriveClient(params)`
  - [ ] 7.3 Wrap in `new DriveClient(sdk)`
  - [ ] 7.4 Tear-down logic on partial construction failure: close any open HTTP connections, dispose openpgp keys
  - [ ] 7.5 Wrap in error mapping helper from Story 2.2

- [ ] **Task 8: `validateSession(token)` method on DriveClient** (AC: #3) — _depends on Task 7_
  - [ ] 8.1 Add the method to `DriveClient` class in `sdk.ts`
  - [ ] 8.2 Update `ProtonDriveClientLike` (the test seam type from Story 2.2) to include the account-fetching method needed by `validateSession`
  - [ ] 8.3 Implement the happy path: call `account.getOwnPrimaryAddress()`, map to `AccountInfo`, return
  - [ ] 8.4 Wrap in error mapping helper
  - [ ] 8.5 Add `// TODO(story-2.x)` comment for storage/plan zeros
  - [ ] 8.6 Add unit tests for `validateSession` (happy path + error mapping) using mocked SDK — same pattern as Story 2.2's wrapper tests

- [ ] **Task 9: `main.ts:handleTokenRefresh` rewire** (AC: #4) — _depends on Task 8_
  - [ ] 9.1 Replace placeholder hardcoded `session_ready` payload (lines 26-35) with `await createDriveClient(token).validateSession(token)`
  - [ ] 9.2 Wrap in try/catch — on engine error, emit `token_expired` (existing failure path)
  - [ ] 9.3 Delete the `// TODO: Story 1-13` comment
  - [ ] 9.4 Update `main.test.ts` if it asserts the old payload shape (read first to confirm)

- [ ] **Task 10: Manual integration smoke + checklist** (AC: #5) — _depends on Task 9_
  - [ ] 10.1 Document the smoke test checklist in `CONTRIBUTING.md` or `engine/src/__integration__/README.md`
  - [ ] 10.2 Execute the smoke against a real Proton dev account
  - [ ] 10.3 Record the result (email observed, latency, any anomalies) in Dev Agent Record
  - [ ] 10.4 Tear down — verify no token persistence, no open connections

- [ ] **Task 11: Full test suite verification** (AC: #6) — _final gate_
  - [ ] 11.1 Run `node --import tsx --test 'engine/src/**/*.test.ts'` — all green
  - [ ] 11.2 Run `cd engine && npx tsc --noEmit` — strict mode clean
  - [ ] 11.3 Run `meson test -C builddir` — UI suite green
  - [ ] 11.4 Manual boundary check: `grep -rn "@protontech/drive-sdk\|from \"openpgp\"" engine/src/` — only `sdk.ts` matches

## Dev Notes

### Architecture invariants (inherited from Story 2.2)

All architectural rules from Story 2.2 still apply:

- SDK boundary: `engine/src/sdk.ts` is the sole importer of `@protontech/drive-sdk` and `openpgp`
- One-way dependency rule: `sdk.ts` imports only from `errors.ts` and `debug-log.ts`
- `MaybeNode` always unwrapped via `.ok` check
- openpgp v6 ↔ SDK Uint8Array casts confined to `sdk.ts`
- Token never in output (logs, errors, debug)
- async/await only — no `.then().catch()` chains
- Throw, never return errors
- `node:test` framework, not Jest/Vitest
- Engine source flat — no subdirectories, all wiring code in `sdk.ts`

### What this story does NOT do

- **No new wrapper methods.** All four public methods (`listRemoteFolders`, `uploadFile`, `downloadFile`, plus the new `validateSession`) are wrapper-API surface. The wrapper itself was shipped in Story 2.2; this story only ADDS `validateSession`.
- **No new SQLite schema.** State DB is owned by Story 2.1.
- **No UI changes.** Manual smoke is observed via UI in dev mode but no UI code changes.
- **No automated integration test suite.** Proton CAPTCHA blocks automation. Manual smoke is the only honest validation gate.

### Known unknowns going into this story

1. **SRP module path** — biggest unknown, owned by Mary's spike (Task 1)
2. **Whether `getPublicKeys`/`hasProtonAccount` are actually called by the SDK during token-only flows** — may be reachable to stub if not
3. **Whether `clientUid` in config has any UX implications** — Story 2.4 will need it for upload conflict resolution; pick a stable value now
4. **Latency of `account.getOwnPrimaryAddress()` round-trip** — affects UI perceived auth time; if >2 seconds, may need a loading state in `main.ts` or UI

### References

- [Source: `_bmad-output/implementation-artifacts/2-2-sdk-driveclient-wrapper.md`] — The wrapper this story extends
- [Source: `_bmad-output/planning-artifacts/epics.md#Story 2.2`] — Original epic AC list (some carry over to this story)
- [Source: party-mode review session 2026-04-10] — Team consensus that produced the split (Winston, Amelia, Quinn, Mary, John, Bob)
- [Source: `engine/node_modules/@protontech/drive-sdk/dist/interface/`] — Full SDK type surface
- [Source: `engine/node_modules/@protontech/drive-sdk/dist/crypto/openPGPCrypto.d.ts`] — `OpenPGPCryptoProxy` interface

## Dev Agent Record

### Agent Model Used

_To be filled at implementation time_

### Implementation Plan

_To be expanded by Bob (SM) once Mary's SRP spike completes and AC2-AC4 are refined._

### Debug Log

### Completion Notes

### File List

## Change Log

- 2026-04-10: Story drafted by Bob (SM) following party-mode consensus on Story 2.2 split. Status `backlog` — awaits Mary's analyst spike (Task 1) before transitioning to `ready-for-dev`. Sequence: 2.2 → 2.3 → **this** → 2.4 → 2.5.
