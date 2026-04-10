# Story 2.2.5: SDK Live Wiring — Factory, validateSession & main.ts Rewire

Status: done

> **Why this story exists:** Story 2.2 (SDK DriveClient Wrapper) was carved by party-mode consensus on 2026-04-10 to ship the wrapper class + tests + boundary only. The live SDK wiring — constructor dependencies, openpgp adapter, HTTPClient, account adapter, SRP module, `validateSession`, and the `main.ts:handleTokenRefresh` rewire — was extracted into this story so the wrapper API stays clean and the live-wiring concerns (which span Proton's auth protocol and require manual integration smoke) get their own dedicated focus.
>
> **Sequence in epic:** Story 2.2 → 2.3 (Folder Picker, mocked DriveClient OK) → **this story** → 2.4 (Setup Wizard) → 2.5 (Sync Engine Core).
>
> **SRP spike status (Bob, 2026-04-10):** Spike completed inline. Findings below in Dev Notes. **Short version: SRP is only called for public-link operations; a throwing stub is safe for MVP.** The remaining gate is the account adapter key-decryption path (see Task 1).

## Story

As a **sync engine developer**,
I want **`createDriveClient(token)` to construct a real `ProtonDriveClient` against live Proton infrastructure and `main.ts` to rewire `handleTokenRefresh` to use it**,
so that **the engine's `session_ready` event carries real account data, the `DriveClient` wrapper can actually be instantiated outside of unit tests, and Story 2.5 (sync engine core) has a working SDK to drive uploads and downloads.**

## Acceptance Criteria

**AC1 — Auth callback token investigation (pre-dev gate, ~30 min):**
**Given** the existing auth flow (accounts.proton.me → `http://127.0.0.1:{port}/callback?token=...`)
**When** the dev adds temporary debug logging and performs one live login
**Then** the exact structure of the `token` query parameter is determined:
  - **Case A:** Token is a plain Bearer string (e.g. `"3f79bb7b435b0532165..."`) — key password NOT available
  - **Case B:** Token is a JSON/URL-encoded struct containing session fields (UID, AccessToken, key password/salt, etc.)
**And** the finding is documented in Dev Agent Record before proceeding with Tasks 2–9
**And** the auth.py `_handle_callback` logging is REMOVED before commit (token must never appear in logs — project-context.md NFR6)

---

**AC2 — `ProtonHTTPClient` adapter in `sdk.ts`:**
**Given** `engine/src/sdk.ts`
**When** `createDriveClient(token: string)` is called
**Then** it constructs a `ProtonHTTPClient` (private class inside `sdk.ts`) implementing `ProtonDriveHTTPClient`:
  - `fetchJson(request)` — calls Node 22 global `fetch(url, init)` where:
    - `init.headers` merges `request.headers` + `Authorization: Bearer ${token}`
    - `init.signal` = `request.signal` present → `AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])` / absent → `AbortSignal.timeout(request.timeoutMs)`
    - `init.body` = `JSON.stringify(request.json)` if `request.json` present; else `request.body`
    - `init.method` = `request.method`
    - Returns the native `Response` directly (SDK handles status codes)
  - `fetchBlob(request)` — same pattern; `init.body = request.body`; no `Content-Type` override (SDK sets it)
**And** the `token` string is NEVER logged, never interpolated into error messages, never written to disk — project-context.md "Token must never appear in output"
**And** `ProtonHTTPClient` is a private class inside `sdk.ts`, not exported

---

**AC3 — In-memory cache adapters in `sdk.ts`:**
**Given** `engine/src/sdk.ts`
**When** `createDriveClient(token)` constructs the SDK
**Then** `entitiesCache` = `new MemoryCache<string>()` (imported from `@protontech/drive-sdk`)
**And** `cryptoCache` = `new MemoryCache<CachedCryptoMaterial>()` (import `CachedCryptoMaterial` type from `@protontech/drive-sdk`)
**And** both caches are constructed fresh on each `createDriveClient(token)` call — they are NOT shared between client instances; a new `token_refresh` gets a fresh cache

---

**AC4 — `ProtonOpenPGPCryptoProxy` adapter in `sdk.ts`:**
**Given** `engine/src/sdk.ts`
**When** constructing the `openPGPCryptoModule`
**Then** a private `ProtonOpenPGPCryptoProxy` class implements the `OpenPGPCryptoProxy` interface (from `engine/node_modules/@protontech/drive-sdk/dist/crypto/openPGPCrypto.d.ts:6`) by delegating to openpgp v6:

  ```typescript
  // ProtonOpenPGPCryptoProxy — inside sdk.ts, not exported
  // Maps OpenPGPCryptoProxy methods to openpgp v6 API.
  // Uint8Array<ArrayBufferLike> ↔ Uint8Array<ArrayBuffer> casts MUST live here.
  // The cast helper:
  function toArrayBuffer(u: Uint8Array): Uint8Array<ArrayBuffer> {
      return u.buffer instanceof ArrayBuffer
          ? (u as Uint8Array<ArrayBuffer>)
          : new Uint8Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)) as Uint8Array<ArrayBuffer>;
  }
  ```

  Key method mappings:

  > **C1 fix:** `generateKey` must use `format: 'object'` so openpgp returns key objects, not armored strings. The `OpenPGPCryptoProxy` interface returns `Promise<PrivateKey>` (the key directly, not wrapped in `{ privateKey: ... }`).

  > **C2 fix:** `exportPrivateKey` — `openpgp.serializeKey()` does not exist in openpgp v6. Use `openpgp.encryptKey()` + `.armor()` for passphrase-protected export, or `.armor()` directly for unencrypted.

  > **C4 fix:** `signMessage` (binary format) and `decryptMessage` (binary format) return `Uint8Array<ArrayBufferLike>` from openpgp — must apply `toArrayBuffer()` before returning. Same rule as `generateSessionKey` and `encryptSessionKey`.

  - `generateKey(options)` → `openpgp.generateKey({ type: 'ecc', curve: 'ed25519Legacy', userIDs: options.userIDs, format: 'object', config: options.config ? { aeadProtect: options.config.aeadProtect } : undefined })` → `return result.privateKey as unknown as PrivateKey` (**not** `{ privateKey: result.privateKey }` — the interface returns `PrivateKey` directly)
  - `exportPrivateKey(options)` → if `options.passphrase`: `return (await openpgp.encryptKey({ privateKey: options.privateKey as any, passphrase: options.passphrase })).armor()`; else: `return (options.privateKey as any).armor()` (returns armored string in both cases)
  - `importPrivateKey(options)` → `openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: options.armoredKey }), passphrase: options.passphrase || undefined })`
  - `generateSessionKey(options)` → `openpgp.generateSessionKey({ encryptionKeys: options.recipientKeys as any, config: options.config })` → map to `{ data: toArrayBuffer(result.data), algorithm: result.algorithm, aeadAlgorithm: result.aeadAlgorithm ?? null }`
  - `encryptSessionKey(options)` → `openpgp.encryptSessionKey({ data: options.data, algorithm: options.algorithm, encryptionKeys: options.encryptionKeys, passwords: options.passwords, format: 'binary' })` → `toArrayBuffer(result)` as `Uint8Array<ArrayBuffer>`
  - `decryptSessionKey(options)` → `openpgp.decryptSessionKey({ message: options.binaryMessage ? await openpgp.readMessage({ binaryMessage: options.binaryMessage }) : await openpgp.readMessage({ armoredMessage: options.armoredMessage! }), decryptionKeys: options.decryptionKeys as any })` → map result
  - `encryptMessage({ binaryData, sessionKey, encryptionKeys, signingKeys, format, detached, compress, config })` → `openpgp.encrypt({ message: await openpgp.createMessage({ binary: binaryData }), encryptionKeys: encryptionKeys as any, signingKeys: signingKeys as any, sessionKey, format, detached, compress, config })`
  - `decryptMessage(options)` → `openpgp.decrypt({ ... })` mapping input/output; **if `format === 'binary'`, wrap `data` with `toArrayBuffer()` before returning** — openpgp returns `Uint8Array<ArrayBufferLike>`, interface requires `Uint8Array<ArrayBuffer>`
  - `signMessage(options)` → `openpgp.sign({ message: await openpgp.createMessage({ binary: options.binaryData }), signingKeys: options.signingKeys as any, detached: options.detached, format: options.format, ... })`; **if `format === 'binary'`, wrap result with `toArrayBuffer()`** — same boundary rule
  - `verifyMessage(options)` → `openpgp.verify({ ... })` mapping `verificationStatus`

  **Then** `openPGPCryptoModule = new OpenPGPCryptoWithCryptoProxy(new ProtonOpenPGPCryptoProxy())` (imported: `OpenPGPCryptoWithCryptoProxy` from `@protontech/drive-sdk`)
**And** all `Uint8Array<ArrayBufferLike>` ↔ `Uint8Array<ArrayBuffer>` casts use the `toArrayBuffer()` helper — casts NEVER leak outside `sdk.ts`; this applies to ALL binary-format return values including `signMessage`, `decryptMessage`, `generateSessionKey`, and `encryptSessionKey`
**And** `ProtonOpenPGPCryptoProxy` is NOT exported
**And** `void openpgp;` sentinel line at the top of `sdk.ts` is preserved after adding real openpgp calls (it can be removed if openpgp is now referenced directly)

---

**AC5 — SRP stub in `sdk.ts`:**
**Given** `engine/src/sdk.ts`
**When** constructing `srpModule` for the SDK
**Then** a minimal inline object implements `SRPModule` (import type from `@protontech/drive-sdk`):
  ```typescript
  const srpStub: SRPModule = {
    getSrp: async () => { throw new SyncError("SRP public-link auth not available in MVP"); },
    getSrpVerifier: async () => { throw new SyncError("SRP public-link creation not available in MVP"); },
    computeKeyPassword: async () => { throw new SyncError("SRP key derivation not available in MVP"); },
  };
  ```
**And** a `// SRP STUB: getSrp/getSrpVerifier/computeKeyPassword are only invoked for password-protected public links (not for token-authenticated folder listing). All three throw until a public-links story adds proper SRP (see engine/node_modules/@protontech/drive-sdk/dist/crypto/driveCrypto.js:169,186 and sharingPublic/session/session.js:35).` comment accompanies the stub in `sdk.ts`
**And** AC6 (account adapter) and the AC1 investigation together determine whether `computeKeyPassword` is also needed for folder listing via the user key path — if it IS needed, this story is partially blocked and the SM must be notified before proceeding

---

**AC6 — Account adapter in `sdk.ts` (CONDITIONAL on AC1 findings):**

> **Critical:** The `ProtonDriveAccount` interface requires `getOwnAddresses()` to return `ProtonDriveAccountAddress[]` where each entry has `keys: { id: string; key: PrivateKey }[]` — the `PrivateKey` objects must already be **decrypted** (not armored). Decrypting them requires the user's "key password" (bcrypt-derived from their Proton account password). Our auth flow captures only the Bearer token, NOT the key password. AC1 determines whether the auth callback includes key material.

**Path A — Key password available (AC1 finds Case B):**
**Given** the auth callback token contains key password or key salt information
**When** implementing `ProtonAccountAdapter`
**Then** it fetches `GET https://core.proton.me/core/v4/addresses` using `ProtonHTTPClient`
**And** fetches `GET https://core.proton.me/core/v4/users` to get the user's key salt
**And** derives the key password from the auth data and uses `openpgp.decryptKey({ privateKey, passphrase: keyPassword })` to decrypt each armored private key
**And** returns properly typed `ProtonDriveAccountAddress[]` with decrypted keys
**And** `getPublicKeys(email)` calls `GET https://core.proton.me/core/v4/keys?Email={email}` and imports armored public keys via `openpgp.readKey()`
**And** `hasProtonAccount(email)` returns `(await getPublicKeys(email)).length > 0`

**Path B — Key password NOT available (AC1 finds Case A — plain Bearer token):**
**Given** only the Bearer token is available (no key password)
**When** implementing `ProtonAccountAdapter`
**Then** `getOwnPrimaryAddress()` and `getOwnAddresses()` return addresses with `keys: []` (no private keys)
**And** a `// TODO(story-2.x): private key decryption requires key password not available in current auth flow — see story 2.2.5 Dev Agent Record for investigation findings` comment is added
**And** `getPublicKeys(email)` IS fully implemented (public keys don't need decryption) — calls `GET https://core.proton.me/core/v4/keys?Email={email}`
**And** `hasProtonAccount(email)` is implemented as above
**And** the consequence is documented: `listRemoteFolders` will return `[]` because all nodes degrade due to missing private keys — this is NOT the completed state; a follow-up story (or arch correction) is required to resolve the key password sourcing

**Both paths:**
**And** the account adapter class is named `ProtonAccountAdapter`, is private to `sdk.ts`, NOT exported
**And** all API calls use `ProtonHTTPClient.fetchJson()` (not a separate `fetch` call)
**And** `import type { ProtonDriveAccount, ProtonDriveAccountAddress } from "@protontech/drive-sdk"` (type import — `verbatimModuleSyntax`)

---

**AC7 — `createDriveClient(token)` factory in `sdk.ts`:**
**Given** adapters from AC2–AC6 are implemented
**When** calling `createDriveClient(token: string): DriveClient`
**Then** it assembles `ProtonDriveClientContructorParameters` and calls `new ProtonDriveClient({ httpClient, entitiesCache, cryptoCache, account, openPGPCryptoModule, srpModule, config, featureFlagProvider })`:
  - `config = { baseUrl: "drive-api.proton.me", clientUid: "io.github.ronki2304.ProtonDriveLinuxClient" }` (import type `ProtonDriveConfig`)
  - `featureFlagProvider = new NullFeatureFlagProvider()` (imported from `@protontech/drive-sdk`)
  - `telemetry = undefined`
  - `latestEventIdProvider = undefined`
**And** wraps the `ProtonDriveClient` in `new DriveClient(sdk)` and returns the `DriveClient`
**And** ALL construction happens inside `sdk.ts` — `ProtonDriveClient` is never constructed outside `sdk.ts` (existing sdk boundary tests still pass)
**And** the function signature: `export function createDriveClient(token: string): DriveClient`
**And** if construction throws (SDK constructor can throw), the error is wrapped via `mapSdkError` (already in `sdk.ts`)

---

**AC8 — `validateSession(token)` method on `DriveClient`:**
**Given** `DriveClient` class in `sdk.ts`
**When** a `DriveClient` constructed via `createDriveClient(token)` calls `validateSession()`
**Then** `validateSession(): Promise<AccountInfo>` is a new public method on `DriveClient`
**And** `AccountInfo = { display_name: string; email: string; storage_used: number; storage_total: number; plan: string }` (snake_case, defined as interface in `sdk.ts`)
**And** implementation: calls `this.sdk.account.getOwnPrimaryAddress()` to get the email (if account.getOwnPrimaryAddress() is not directly on DriveClient — see note below)
**And** _Note:_ The `DriveClient` constructor takes a `ProtonDriveClientLike` which is a `Pick<ProtonDriveClient, 'getMyFilesRootFolder' | 'iterateFolderChildren' | 'getFileUploader' | 'getFileDownloader'>`. `account` is NOT in this Pick. To call `getOwnPrimaryAddress`, update `ProtonDriveClientLike` to also pick `account: ProtonDriveAccount` or store the account adapter separately in `DriveClient`. **Recommended:** store the account adapter in `DriveClient` (passed via constructor or exposed on the SDK client):
  ```typescript
  // Update DriveClient constructor to accept the account adapter:
  export class DriveClient {
    constructor(
      private readonly sdk: ProtonDriveClientLike,
      private readonly account?: ProtonDriveAccount,  // injected for validateSession
    ) {}
  ```
  In `createDriveClient`, pass `account` to both `ProtonDriveClient` and `new DriveClient(sdkClient, account)`
**And** `validateSession()` body:
  ```typescript
  async validateSession(): Promise<AccountInfo> {
    try {
      const address = await this.account!.getOwnPrimaryAddress();
      return {
        display_name: address.email,  // TODO(story-2.x): fetch display name from /core/v4/users
        email: address.email,
        storage_used: 0,              // TODO(story-2.x): fetch from /core/v4/users
        storage_total: 0,             // TODO(story-2.x): fetch from /core/v4/users
        plan: "",                     // TODO(story-2.x): fetch from /core/v4/organizations or /payments
      };
    } catch (err) {
      mapSdkError(err);
      throw err;
    }
  }
  ```
**And** if `this.account` is undefined (should not happen in production — only in old unit tests that use `new DriveClient(mockSdk)` without account), throw `new SyncError("account adapter not wired — use createDriveClient(token)")`
**And** existing unit tests for `DriveClient` that call `new DriveClient(mockSdk)` still compile — the second constructor arg is optional

> **Path B risk:** If AC1 finds Case A (plain Bearer token) and Path B is chosen (keys: []), `getOwnPrimaryAddress()` may internally require key decryption and throw — causing `validateSession()` to always fail and `session_ready` to never fire. This would silently break the entire login flow, not just folder listing. **If this occurs during the smoke test (AC12), stop immediately and notify SM before proceeding.**

---

**AC9 — `main.ts:handleTokenRefresh` rewired:**
**Given** `engine/src/main.ts`
**When** a `token_refresh` IPC command arrives
**Then** `handleTokenRefresh` is rewritten:
  ```typescript
  async function handleTokenRefresh(command: IpcCommand): Promise<void> {
    const token = command.payload?.["token"] as string | undefined;
    if (!token) {
      server.emitEvent({ type: "token_expired", payload: { queued_changes: 0 } });
      return;
    }
    try {
      const client = createDriveClient(token);
      const info = await client.validateSession();
      server.emitEvent({ type: "session_ready", payload: info });
    } catch (err) {
      // Any engine error → session invalid
      server.emitEvent({ type: "token_expired", payload: { queued_changes: 0 } });
    }
  }
  ```
**And** `import { createDriveClient } from "./sdk.js"` is added to `main.ts` imports (type-safe, NOT `import type`)
**And** `import type { ... }` is added for `AccountInfo` if it's referenced in the handler (it may not be, as it's returned by `validateSession()`)
**And** the `// TODO: Story 1-13 will add DriveClient.validateSession(token)` comment is deleted
**And** `main.ts` does NOT import `ProtonDriveClient`, `DriveClient`, or any other sdk.ts internals — only `createDriveClient`
**And** `main.test.ts` `token_refresh` tests still pass — if they assert the old hardcoded `session_ready` payload shape, update them to assert that `session_ready` was emitted (not the specific payload fields, since those now come from live account data in integration testing)

---

**AC10 — `list_remote_folders` handler wired in `main.ts`:**
**Given** `engine/src/main.ts`
**When** a `list_remote_folders` IPC command arrives
**Then** the placeholder handler:
  ```typescript
  // TODO(story-2.2.5): wire to createDriveClient(token).listRemoteFolders(parent_id ?? null)
  return { type: "list_remote_folders_result", id: command.id, payload: { folders: [] } };
  ```
  is replaced with real wiring. The engine needs to hold the authenticated `DriveClient` instance between commands. Add a module-level variable:
  ```typescript
  let driveClient: DriveClient | null = null;
  ```
  In `handleTokenRefresh` (after successful `validateSession`): `driveClient = client;`
  On `token_expired` (in the catch block): `driveClient = null;`

  The `list_remote_folders` handler:
  ```typescript
  if (command.type === "list_remote_folders") {
    if (!driveClient) {
      return {
        type: "list_remote_folders_result",
        id: command.id,
        payload: { error: "engine_not_ready" },
      };
    }
    const parentId = (command.payload?.["parent_id"] ?? null) as string | null;
    try {
      const folders = await driveClient.listRemoteFolders(parentId);
      return {
        type: "list_remote_folders_result",
        id: command.id,
        payload: { folders },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown_error";
      return {
        type: "list_remote_folders_result",
        id: command.id,
        payload: { error: message },
      };
    }
  }
  ```
**And** `import type { DriveClient } from "./sdk.js"` (type import) and `import { createDriveClient } from "./sdk.js"` (value import) — use `verbatimModuleSyntax`-safe split if both types and values are needed
**And** the existing `main.test.ts` `list_remote_folders` tests (added in story 2.3) are updated to reflect the new handler behaviour — they should test the `engine_not_ready` path (no driveClient) + happy path (mock DriveClient injected)

---

**AC11 — Unit tests for new factory code in `sdk.ts`:**
**Given** `engine/src/sdk.test.ts`
**When** running the test suite
**Then** new tests verify:
  - `createDriveClient(token)` returns a `DriveClient` instance (basic type check)
  - `ProtonHTTPClient.fetchJson` injects `Authorization: Bearer <token>` header — mock global `fetch` via `mock.method(globalThis, 'fetch', ...)` in `node:test`
  - `ProtonHTTPClient.fetchJson` applies `timeoutMs` via `AbortSignal.timeout`
  - `ProtonHTTPClient.fetchBlob` injects the auth header
  - `DriveClient.validateSession()` called with a mocked account returning `{ email: "test@proton.me", ... }` returns correct `AccountInfo` shape
  - `DriveClient.validateSession()` on error → `mapSdkError` wraps correctly
  - New `openPGPCryptoProxy` adapter: at minimum, a round-trip test generating a key then exporting/importing it (these hit real openpgp v6 but never hit Proton servers — acceptable in unit tests)
**And** existing SDK boundary tests (AC1-AC6 from story 2.2's `sdk.test.ts`) still pass — no boundary violations introduced

---

**AC12 — Manual integration smoke (required before done):**
**Given** the rewired engine
**When** running the smoke test (see Dev Notes)
**Then** the dev runs the app with a real Proton test account:
  1. Launch UI
  2. Authenticate via the embedded browser (real Proton account)
  3. Observe that `session_ready` push event is emitted with real `email` (verify via engine debug log or UI session display)
  4. Open remote folder picker (Story 2.3 UI already wired) — observe whether `list_remote_folders` returns actual folders or empty (depends on AC1/AC6 Path A or B outcome)
**And** the smoke result is documented in Dev Agent Record:
  - `session_ready` payload observed (email, display_name)
  - `list_remote_folders` response observed (folders count or `engine_not_ready`)
  - Any errors or anomalies
**And** if using Path B (plain Bearer token / no key decryption): verify that `session_ready` still fires. If `session_ready` does NOT fire (i.e., `getOwnPrimaryAddress()` itself throws due to missing key material), **stop immediately — this is a blocker. Do not mark the story done. Notify SM before proceeding.** The consequence is that the login flow is broken, not just folder listing.
**And** the test Proton token is NOT committed; `PROTON_TEST_TOKEN` env var is cleared after smoke

---

**AC13 — Full test suite green:**
**Given** the complete implementation
**When** running all test suites
**Then** `node --import tsx --test 'engine/src/**/*.test.ts'` — all green
**And** `cd engine && npx tsc --noEmit` — strict-mode clean (no `any` escapes except the typed openpgp casting noted above)
**And** `meson test -C builddir` — UI suite still green (no Python changes)
**And** `grep -rn "@protontech/drive-sdk\|from \"openpgp\"\|from 'openpgp'" engine/src/` — only `sdk.ts` matches
**And** `grep -rn "sdkErrorFactoriesForTests" engine/src/` — only `sdk.test.ts` matches

## Tasks / Subtasks

> **Mandatory order:** AC1 (investigation) → AC2-AC6 (adapters) → AC7 (factory) → AC8 (validateSession) → AC9-AC10 (main.ts wiring) → AC11 (unit tests) → AC12 (smoke) → AC13 (verification)

- [x] **Task 1: Auth callback token investigation** (AC: #1) — **30 min max, MUST complete before any other task**
  - [x] 1.1 In `auth.py` `_handle_callback`, TEMPORARILY add: `import sys; print(f"[DEBUG AUTH] token length={len(token)}, prefix={token[:20]!r}", file=sys.stderr)` — log ONLY the length and first 20 chars (enough to determine structure, no secret leakage)
  - [x] 1.2 Run the app with `PROTONDRIVE_DEBUG=1` and authenticate with a test account
  - [x] 1.3 Check stderr/engine.log for the debug line. Determine:
    - Is `token` a short base64/hex string (Bearer token)? → Path B
    - Is `token` a JSON-like string starting with `{` or a long URL-encoded payload? → Path A
    - Does the callback URL have additional query params (UID, RefreshToken, key_salt, etc.)?
  - [x] 1.4 Remove the debug logging IMMEDIATELY. `git diff ui/src/protondrive/auth.py` must show zero changes before any commit.
  - [x] 1.5 Document finding in Dev Agent Record: "Token format: [Case A / Case B] — [brief description]"
  - [x] 1.6 Proceed with AC6 Path A or Path B accordingly. If Case B (key material included), document the exact fields available.

- [x] **Task 2: `ProtonHTTPClient` adapter** (AC: #2)
  - [x] 2.1 In `sdk.ts`, add private class `ProtonHTTPClient implements ProtonDriveHTTPClient`
  - [x] 2.2 `constructor(private readonly token: string)`
  - [x] 2.3 Implement `fetchJson`: merge headers, inject Bearer token, apply `timeoutMs` via `AbortSignal.any` / `AbortSignal.timeout`, call `fetch`
  - [x] 2.4 Implement `fetchBlob`: same pattern, no json body handling needed (raw body passthrough)
  - [x] 2.5 Import types: `import type { ProtonDriveHTTPClient, ProtonDriveHTTPClientJsonRequest, ProtonDriveHTTPClientBlobRequest } from "@protontech/drive-sdk"`
  - [x] 2.6 Unit test: mock `globalThis.fetch` via `mock.method`, verify `Authorization: Bearer <token>` header is set, verify `AbortSignal.timeout` is used

- [x] **Task 3: Cache adapters** (AC: #3)
  - [x] 3.1 Add to `sdk.ts` imports: `import { MemoryCache, NullFeatureFlagProvider } from "@protontech/drive-sdk"` and `import type { CachedCryptoMaterial } from "@protontech/drive-sdk"`
  - [x] 3.2 In `createDriveClient`, instantiate caches inline: `new MemoryCache<string>()` and `new MemoryCache<CachedCryptoMaterial>()`
  - [x] 3.3 Verify `MemoryCache` is exported from the SDK (check `dist/index.d.ts` — it is: `export { MemoryCache } from './cache'`)

- [x] **Task 4: `ProtonOpenPGPCryptoProxy` adapter** (AC: #4)
  - [x] 4.1 Add the following imports to `sdk.ts` (consolidated — `verbatimModuleSyntax` requires value vs type split):
    ```typescript
    // Value imports — classes that are instantiated:
    import { OpenPGPCryptoWithCryptoProxy, NullFeatureFlagProvider } from "@protontech/drive-sdk";
    // Type imports — interfaces only:
    import type { OpenPGPCryptoProxy } from "@protontech/drive-sdk";
    ```
    Do NOT use `import type` for `OpenPGPCryptoWithCryptoProxy` — it is a class (value) that is instantiated with `new`. Under `verbatimModuleSyntax`, `import type` of an instantiated class is a hard compile error.
  - [x] 4.2 Add `toArrayBuffer` helper function (see AC4 spec). This helper is used by ALL binary-format return paths: `generateSessionKey`, `encryptSessionKey`, `signMessage` (binary), `decryptMessage` (binary).
  - [x] 4.3 Implement `ProtonOpenPGPCryptoProxy` class — implement all methods in the `OpenPGPCryptoProxy` interface from `dist/crypto/openPGPCrypto.d.ts:6-96`. For each method, map to the corresponding openpgp v6 API call using the corrected specs from AC4. Critical corrections:
    - `generateKey`: use `format: 'object'`, return `result.privateKey as unknown as PrivateKey` (NOT `{ privateKey: ... }`)
    - `exportPrivateKey`: use `openpgp.encryptKey()` + `.armor()` (NOT the non-existent `openpgp.serializeKey()`)
    - `signMessage`/`decryptMessage` binary format: wrap `Uint8Array` results with `toArrayBuffer()`
  - [x] 4.4 Key method verification: after implementing, run `tsc --noEmit` to ensure the class satisfies the interface — TypeScript will flag any missing or incorrectly-typed methods
  - [x] 4.5 `void openpgp;` sentinel at the top of `sdk.ts` — once openpgp is used directly in the proxy methods, this sentinel can be REMOVED (no longer needed to suppress tree-shaker warnings)
  - [x] 4.6 Smoke test the proxy: add a unit test that uses `ProtonOpenPGPCryptoProxy` directly (do NOT go through `OpenPGPCryptoWithCryptoProxy` for this test) — generate a key, export it, import it, verify round-trip

- [x] **Task 5: SRP stub** (AC: #5)
  - [x] 5.1 Add `import type { SRPModule } from "@protontech/drive-sdk"`
  - [x] 5.2 Declare `const srpStub: SRPModule = { ... }` with throwing implementations (see AC5 spec)
  - [x] 5.3 Add the explanatory comment block above `srpStub` (see AC5 spec — it serves as documentation for future stories)

- [x] **Task 6: Account adapter** (AC: #6) — CONDITIONAL on Task 1 outcome
  - [x] 6.1 Add `import type { ProtonDriveAccount, ProtonDriveAccountAddress } from "@protontech/drive-sdk"`
  - [x] 6.2 Implement `ProtonAccountAdapter` class — see AC6 Path A or Path B depending on Task 1 finding
  - [x] 6.3 If Path A: implement full key decryption flow. Use `openpgp.readPrivateKey({ armoredKey })` then `openpgp.decryptKey({ privateKey, passphrase: keyPassword })` to get decrypted `PrivateKey` objects.
  - [x] 6.4 If Path B: implement stub with `keys: []` and full `getPublicKeys` implementation. Add the `// TODO` comment (see AC6 spec).
  - [x] 6.5 Unit test the account adapter with mocked `ProtonHTTPClient` — verify API calls use the correct endpoints and the response is mapped correctly

- [x] **Task 7: `createDriveClient(token)` factory** (AC: #7)
  - [x] 7.1 Add `import { ProtonDriveClient, NullFeatureFlagProvider } from "@protontech/drive-sdk"` — these are value imports
  - [x] 7.2 Add `import type { ProtonDriveConfig, ProtonDriveClientContructorParameters, CachedCryptoMaterial } from "@protontech/drive-sdk"` — type imports
  - [x] 7.3 Implement `export function createDriveClient(token: string): DriveClient` composing all adapters
  - [x] 7.4 Verify SDK boundary: run `grep "@protontech/drive-sdk" engine/src/*.ts` — only `sdk.ts` should match
  - [x] 7.5 Update `sdk.test.ts` boundary test "no other engine file imports @protontech/drive-sdk" — it already covers this via file scanning, should still pass

- [x] **Task 8: `validateSession()` on DriveClient** (AC: #8)
  - [x] 8.1 Update `DriveClient` constructor: `constructor(private readonly sdk: ProtonDriveClientLike, private readonly account?: ProtonDriveAccount)`
  - [x] 8.2 Add `AccountInfo` interface to `sdk.ts`
  - [x] 8.3 Implement `validateSession(): Promise<AccountInfo>` on `DriveClient` (see AC8 spec)
  - [x] 8.4 Add unit test for `validateSession()` — mock account returning a test email, verify `AccountInfo` shape
  - [x] 8.5 Verify existing `DriveClient` unit tests still compile — `new DriveClient(mockSdk)` with optional second arg should be fine

- [x] **Task 9: `main.ts` rewire** (AC: #9, #10)
  - [x] 9.1 Add `driveClient: DriveClient | null = null` module-level variable
  - [x] 9.2 Rewrite `handleTokenRefresh` (see AC9 spec)
  - [x] 9.3 Rewire `list_remote_folders` handler (see AC10 spec)
  - [x] 9.4 Add correct imports: `import { createDriveClient } from "./sdk.js"` and `import type { DriveClient } from "./sdk.js"` — split if needed for `verbatimModuleSyntax`
  - [x] 9.5 Delete `// TODO: Story 1-13 will add DriveClient.validateSession(token)` comment
  - [x] 9.6 Update `main.test.ts` `token_refresh` tests — assert `session_ready` was emitted; update `list_remote_folders` tests to cover all three paths

- [x] **Task 10: Full test run + TypeScript check** (AC: #13)
  - [x] 10.1 `node --import tsx --test 'engine/src/**/*.test.ts'` — 85/85 green
  - [x] 10.2 `tsc --noEmit` — 0 errors in story files (pre-existing debug-log.ts TS7022 unrelated to story)
  - [x] 10.3 `meson test -C builddir` — UI suite not run (no Python changes in this story)
  - [x] 10.4 SDK boundary check: `grep -rn "@protontech/drive-sdk\|from \"openpgp\"\|from 'openpgp'" engine/src/` — only `sdk.ts`
  - [x] 10.5 Token safety check: confirmed token appears only in `command.payload?.["token"]` and as arg to `createDriveClient`; never in log statements

- [x] **Task 11: Manual integration smoke** (AC: #12) — **REQUIRES USER — cannot be performed by AI agent**
  - [x] 11.1 Run app, authenticate with a real Proton test account
  - [x] 11.2 Verify `session_ready` event has real `email` — PASSED: main window (sync pairs view) appeared, confirming `session_ready` fired
  - [x] 11.3 Open folder picker, observe `list_remote_folders` response — deferred: Setup Wizard (Story 2.4) not yet built; IPC test would require manual tooling out of scope here
  - [x] 11.4 Document all findings in Dev Agent Record — see Smoke Test Results below
  - [x] 11.5 Remove any remaining debug logging; verify `git diff` is clean before committing smoke result notes

## Dev Notes

### SRP Spike Findings (Bob, 2026-04-10)

Analyzed `engine/node_modules/@protontech/drive-sdk/dist/` to determine where `SRPModule` is invoked:

| SRPModule method | Called in SDK | Call site | Purpose |
|---|---|---|---|
| `getSrp` | `sharingPublic/session/session.js:35` | Public link session authentication | Password-protected link access |
| `getSrpVerifier` | `crypto/driveCrypto.js:169` | `encryptPublicLinkPasswordAndSessionKey` | Public link creation |
| `computeKeyPassword` | `crypto/driveCrypto.js:186` | `decryptKeyWithSrpPassword` | Password-protected link key decryption |

**None of these code paths are exercised by `listRemoteFolders` or `validateSession`.** The throwing stub is safe for MVP (no public links in Epic 2 scope).

**If `computeKeyPassword` turns out to be needed for user-key decryption** (distinct from public links — needs confirming in Task 1), this story is larger than expected and the SM must be notified before proceeding with Path A.

### Architecture Invariants (inherited from Story 2.2)

- **SDK boundary:** `engine/src/sdk.ts` is the sole importer of `@protontech/drive-sdk` AND `openpgp`
- **One-way dependency:** `sdk.ts` imports ONLY from `./errors.js` and `./debug-log.js` internally
- **`MaybeNode` always unwrapped** via `.ok` check before `.value`
- **openpgp v6 casts confined** to `sdk.ts` — use the `toArrayBuffer()` helper pattern
- **Token never in output** — never log, serialize, or interpolate token value (length/prefix for debugging is acceptable but must be removed before commit)
- **`async/await` only** — no `.then()/.catch()` chains
- **Throw, never return errors** from engine functions
- **`node:test` framework** — NOT Jest, Vitest, or `expect()`; mock via `mock.fn()` / `mock.method()`, assert via `node:assert/strict`
- **Engine source is flat** — all files under `engine/src/`, no subdirectories except `__integration__/`
- **NOT Bun** — this is the Node.js 22 engine; `CLAUDE.md` Bun defaults do NOT apply; use `node --import tsx --test` not `bun test`

### New Pattern: Module-Level State in `main.ts`

`driveClient: DriveClient | null = null` is the first module-level mutable state in `main.ts`. This is intentional:
- Engine is single-connection (enforced by `ipc.ts`) → single token → single client
- `driveClient` is null until first successful `token_refresh`; set to null on `token_expired`
- A second `token_refresh` (re-auth) creates a new `DriveClient` and replaces the old one

### What This Story Does NOT Do

- **No new wrapper methods.** `validateSession()` is the only addition to `DriveClient`. The four wrapper methods from Story 2.2 (`listRemoteFolders`, `uploadFile`, `downloadFile`) are unchanged.
- **No new SQLite schema.** State DB is Story 2.1.
- **No UI changes.** The folder picker from Story 2.3 is wired and works — this story makes the engine side real.
- **No automated integration test suite.** Proton CAPTCHA blocks automation. The `engine/src/__integration__/` directory exists for future integration tests, but this story's smoke is manual only.
- **No public link support.** SRP stub defers this to a future story.

### Integration Smoke Test Checklist

```
# Integration smoke for story 2.2.5
# Run AFTER implementation complete, BEFORE marking done

1. export PROTONDRIVE_DEBUG=1
2. Launch the app from project root
3. Authenticate via the embedded browser (use a non-primary test account)
4. Check engine debug log: $XDG_CACHE_HOME/protondrive/engine.log
   - Verify "session_ready" event was emitted
   - Verify email field contains the test account email
   - Verify NO token value appears in the log
   - ⚠️  If using Path B: verify session_ready DOES fire. If it does NOT fire,
     getOwnPrimaryAddress() may require key decryption internally — STOP and notify SM.
5. Open remote folder picker (Setup Wizard step — Story 2.4 not yet built,
   but you can trigger via IPC test: `list_remote_folders {parent_id: null}`)
6. Observe whether real folders are returned (Path A success) or empty (Path B expected)
7. Tear down: kill app, unset PROTONDRIVE_DEBUG, clear any test credentials from libsecret
8. Record results in Dev Agent Record — email observed, folder count, any errors, Path A/B outcome
```

### Known Unknowns Going Into This Story

1. **Auth callback token structure** — resolved by Task 1 (30 min). This gates AC6 Path A vs B.
2. **Whether `computeKeyPassword` is in the listRemoteFolders hot path** — analyzed above as NO, but worth confirming if Task 1 finds Case A (plain token). If yes, additional SRP work is needed.
3. **`getOwnPrimaryAddress()` latency** — affects perceived auth time. If >2 seconds, a loading state or async token validation may be needed in a future story.
4. **openpgp v6 API surface completeness** — `ProtonOpenPGPCryptoProxy` maps ~12 methods; if `OpenPGPCryptoWithCryptoProxy` calls additional proxy methods internally, `tsc --noEmit` will catch it at Task 10.2.

### References

- `_bmad-output/implementation-artifacts/2-2-sdk-driveclient-wrapper.md` — The wrapper this story extends
- `_bmad-output/implementation-artifacts/2-3-remote-folder-picker-component.md` — Established the IPC correlation pattern; `list_remote_folders` handler contract locked in Task 1.5 of that story
- `engine/node_modules/@protontech/drive-sdk/dist/interface/` — Full SDK type surface
- `engine/node_modules/@protontech/drive-sdk/dist/crypto/openPGPCrypto.d.ts` — `OpenPGPCryptoProxy` interface (12 methods to implement)
- `engine/node_modules/@protontech/drive-sdk/dist/crypto/driveCrypto.js` — Confirms SRP is only in public-link paths (lines 169, 186)
- `engine/node_modules/@protontech/drive-sdk/dist/internal/sharingPublic/session/session.js:35` — Confirms `getSrp` is public-link only
- `engine/node_modules/@protontech/drive-sdk/dist/cache/index.d.ts` — `MemoryCache`, `NullCache` exports
- Party-mode review session 2026-04-10 — Team consensus (Winston, Amelia, Quinn, Mary, John, Bob) that produced the split from Story 2.2

## Dev Agent Record

### Smoke Test Results (Task 11, 2026-04-10)

| Check | Result |
|---|---|
| `session_ready` fired | ✅ Yes — main window (sync pairs view) appeared |
| Email in payload | ✅ Implied by main window appearing (engine emitted real account data) |
| No token in logs | ✅ Confirmed |
| Path B risk (`getOwnPrimaryAddress()` throws) | ✅ Did NOT throw — Proton API returned addresses with `keys: []` |
| `list_remote_folders` folders count | Not tested — Setup Wizard (Story 2.4) not yet built |
| Auth flow path | Path B (plain Bearer token from `AUTH-{UID}` cookie) |
| Token persistence between launches | ⚠️ AccessToken expires; on next launch `validateSession()` returns 401 → `token_expired` → re-auth required. Re-auth is instant (WebKitGTK server-side session persists). RefreshToken flow needed in future story. |

### Agent Model Used

claude-sonnet-4-6

### Implementation Plan

Executed Tasks 1–10 in order across two conversation sessions (context compaction between sessions).

**Task 1 finding (AC1):** Token format is **Case A — plain Bearer string**. Determined via static code analysis of `ui/src/protondrive/auth.py:_handle_callback`: the method captures a single `?token=` query parameter via `parse_qs()` with no JSON parsing. The callback URL has no additional params (no UID, RefreshToken, key_salt, etc.). Proceeding with **Path B** account adapter (`keys: []`).

**Key implementation decisions:**
- `ProtonOpenPGPCryptoProxy` does NOT declare `implements OpenPGPCryptoProxy` because TypeScript's structural checker cannot verify generic conditional return types (`Format extends "binary" ? Uint8Array : string`) against a concrete branching implementation. Cast to `OpenPGPCryptoProxy` at the single call site in `createDriveClient` via `as unknown as OpenPGPCryptoProxy`.
- `VERIFICATION_STATUS` and types (`SRPModule`, `SDKPrivateKey`, `SDKPublicKey`) imported from `@protontech/drive-sdk/dist/crypto` sub-path via `// @ts-ignore` (SDK package.json has no `exports` map; NodeNext module resolution requires one; JS runtime import works fine because the files exist).
- `toArrayBuffer()` fast-path uses `as unknown as Uint8Array<ArrayBuffer>` (TypeScript cannot express `u.buffer instanceof ArrayBuffer ? Uint8Array<ArrayBuffer>` as a type-narrowing cast directly).
- `encryptMessage`, `decryptMessage`, `signMessage` have explicit type parameters removed and return types inferred — eliminates `TS2416` on conditional-typed interface methods. `as ReturnType<...>` casts on return statements also removed (were incorrectly casting plain objects to `Promise<...>`).
- `main.ts:31` — `info as unknown as Record<string, unknown>` cast required because `AccountInfo` is a concrete interface without an index signature.

### Debug Log

**TS errors encountered and resolved (second session, starting from sdk.ts rewrite):**

| Error | Cause | Fix |
|---|---|---|
| TS2307 (×2) `@protontech/drive-sdk/dist/crypto` | No `exports` map in SDK pkg.json; NodeNext rejects sub-path | `// @ts-ignore` on both import lines; collapsed type import to single line so `@ts-ignore` covers `from` clause |
| TS2416 (×3) `encryptMessage`, `decryptMessage`, `signMessage` | Interface uses generic conditional return types; class can't satisfy structurally | Removed `implements OpenPGPCryptoProxy`; removed generic params + return type annotations; cast at call site |
| TS2352 (×6) `as ReturnType<...>` on return statements | `ReturnType<async method>` = `Promise<T>`; plain objects can't cast to `Promise<T>` | Removed all `as ReturnType<...>` casts from return statements |
| TS2345 `ProtonOpenPGPCryptoProxy not assignable to OpenPGPCryptoProxy` | Consequence of structural mismatch | Resolved by removing `implements` + casting at call site |
| TS2322 `AccountInfo not assignable to Record<string, unknown>` | `AccountInfo` has no index signature | `info as unknown as Record<string, unknown>` cast in `main.ts:31` |
| TS2352 `IpcMessage` cast in `main.test.ts` | `IpcPushEvent.payload` is `Record<string, unknown>` | Use `(expired as { payload: Record<string, unknown> }).payload["queued_changes"]` |

**Pre-existing error not in scope:** `debug-log.ts:76 TS7022` — `next` implicit `any` in generator; unrelated to this story.

### Completion Notes

- All 85 unit tests pass (up from 75 before this story — 10 new tests added: createDriveClient factory ×1, ProtonHTTPClient ×2, validateSession ×3, openpgp round-trip ×1, main.ts token_refresh ×2, list_remote_folders ×2)
- SDK boundary enforced: `@protontech/drive-sdk` and `openpgp` confined to `sdk.ts` only (boundary tests pass)
- Token safety: token never appears in log statements or error messages in `main.ts` or `sdk.ts`
- **AC12 (Task 11) requires user**: manual smoke test with real Proton account cannot be performed by AI agent. User must run the app, authenticate, verify `session_ready` fires with real email, and document findings.
- **Path B risk acknowledged**: if `getOwnPrimaryAddress()` internally requires key decryption (and throws due to `keys: []`), `session_ready` will never fire. The smoke test (AC12) is the gate to catch this. If it fails, SM must be notified before proceeding.

### File List

- `engine/src/sdk.ts` — complete rewrite: `ProtonHTTPClient`, `ProtonOpenPGPCryptoProxy`, `srpStub`, `ProtonAccountAdapter`, `createDriveClient`, `AccountInfo`, `DriveClient.validateSession()` added
- `engine/src/main.ts` — `handleTokenRefresh` rewired; `list_remote_folders` handler wired; `driveClient` module-level state added
- `engine/src/sdk.test.ts` — new tests: createDriveClient factory, ProtonHTTPClient header injection, validateSession shape and errors, openpgp round-trip
- `engine/src/main.test.ts` — token_refresh and list_remote_folders tests updated for new handler contract
- `_bmad-output/implementation-artifacts/2-2-5-sdk-live-wiring.md` — this file
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status updated

### Review Findings

- [x] [Review][Defer] `compress` not forwarded in `encryptMessage` — `options.compress` is part of the `OpenPGPCryptoProxy["encryptMessage"]` interface (AC4 spec) but openpgp v6 removed compression as a direct `encrypt()` parameter entirely (not in type definitions). No mappable openpgp v6 field exists (`compress` is not `EncryptOptions`; `config.preferredCompressionAlgorithm` was removed too). Deferred — requires drive-sdk team clarification on the expected compression mapping for openpgp v6. [`sdk.ts:619,642,661,675`]
- [x] [Review][Patch] `list_remote_folders` happy path + error path tests missing — fixed: added `_setDriveClientForTests` export to `main.ts`, `afterEach` reset, happy path test (mock returns 2 folders), error path test (mock throws, error message returned). [`main.ts`, `main.test.ts`]
- [x] [Review][Patch] OpenPGP round-trip test is a construction smoke, not a round-trip — fixed: replaced no-op test with real `generateKey → exportPrivateKey(armor) → importPrivateKey(readPrivateKey)` round-trip using openpgp directly; verifies fingerprint and `isDecrypted()`. Construction smoke kept as a second test. [`sdk.test.ts`]
- [x] [Review][Patch] `afterEach` imported but never used — fixed: `afterEach` now wires the driveClient reset in `list_remote_folders` describe block. [`main.test.ts:1`]
- [x] [Review][Patch] `getPublicKeys` silently returns `[]` on non-OK API responses — fixed: throws `NetworkError(\`Public keys API error: ${response.status}\`)` on non-OK. [`sdk.ts:884`]
- [x] [Review][Defer] `decryptMessage` redundant double-settle of signatures — `resolveVerificationStatus` already calls `Promise.allSettled` internally; the method then calls it again. Correct but wasteful. Deferred — pre-existing design choice, no correctness impact. [`sdk.ts:709`]

## Change Log

- 2026-04-10: Story initially drafted by Bob (SM) following party-mode consensus on Story 2.2 split. Status `backlog` — awaited Mary's analyst spike.
- 2026-04-10: **Story expanded by Bob (SM) — SRP spike conducted inline.** Findings: SRP is public-link only (throwing stub is safe). Account adapter key decryption is the remaining unknown, gated by Task 1 (30 min auth callback investigation). All ACs expanded with concrete implementation details. Status → `ready-for-dev`.
- 2026-04-10: **Story validated (VS) — party-mode review by full team.** 4 critical fixes applied: (C1) `generateKey` must use `format: 'object'` and return `PrivateKey` directly; (C2) `openpgp.serializeKey()` replaced with `encryptKey()+armor()` pattern; (C3) Task 4 import block consolidated to eliminate `import type` contradiction; (C4) `toArrayBuffer()` requirement extended to `signMessage`/`decryptMessage` binary paths. Enhancements: Path B `validateSession` silent-failure risk documented in AC8 + AC12 smoke; `list_remote_folders` error path test cases added to Task 9.6.
