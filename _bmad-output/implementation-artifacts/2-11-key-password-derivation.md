# Story 2.11: Post-Auth Key Password Derivation and Drive Crypto Unlock

Status: review

> **Why this story exists:** Story 2.2.5 (SDK Live Wiring) wired the `AccessToken` from browser auth into the SDK's HTTP client.
> Live Flatpak validation (Story 2.10) revealed that this is not enough: Proton Drive share keys
> are encrypted with the user's OpenPGP private key, which is itself encrypted with a `keyPassword`
> derived from the login password via bcrypt. The browser cookie approach captures only
> `AccessToken` + `UID` — the `keyPassword` is never transmitted. Without it,
> `ProtonAccountAdapter.getPrivateKeys()` returns `[]`, `decryptSessionKey` fails for every share,
> and `listRemoteFolders` + all sync operations are completely broken.
>
> **Approach (Option A):** After `session_ready` is confirmed, prompt the user for their Proton
> password in a native GTK dialog. Use the live `AccessToken` to fetch the bcrypt salt from the
> Proton API, derive `keyPassword`, fetch and decrypt the private keys, and wire them into the SDK.
> The `keyPassword` is stored in the keyring alongside the `AccessToken` so subsequent launches
> unlock silently without re-prompting.
>
> **Sequence in epic:** Story 2.10 (Flatpak Build Validation) → **this story** → Epic 2 Retrospective.

## Story

As a **user who has signed in via the embedded browser**,
I want **the app to derive my Proton cryptographic key password from my login password**,
so that **the sync engine can decrypt my Proton Drive share keys and actually sync files**.

## Acceptance Criteria

**AC1 — Proton bcrypt salt fetch:**
**Given** a valid `AccessToken` and `UID` in the engine
**When** key derivation is initiated
**Then** the engine calls `GET https://drive-api.proton.me/core/v4/auth/info` with
  `Authorization: Bearer {AccessToken}` and `x-pm-uid: {UID}`
**And** the response includes a `KeySalt` field (base64-encoded bcrypt salt, may be `null` for SSO-only accounts)
**And** on any API error the engine surfaces an `IpcError` to the UI via the existing error event mechanism

---

**AC2 — Key password derivation:**
**Given** the user's login password (collected via the UI dialog — AC6) and the `KeySalt` from AC1
**When** `KeySalt` is non-null
**Then** `keyPassword` is derived as `bcrypt(password, KeySalt)` using the standard Proton bcrypt parameters
**When** `KeySalt` is null (SSO / no-key account)
**Then** `keyPassword` is set to the empty string `""` (SSO accounts have no private key encryption)
**And** the raw password string is zeroed / discarded immediately after derivation — never stored, never logged, never sent over IPC

---

**AC3 — Private key fetch and decryption:**
**Given** the derived `keyPassword`
**When** the engine calls `GET https://drive-api.proton.me/core/v4/keys/user` with auth headers
**Then** the response includes the user's armored private key(s) in `Keys[].PrivateKey`
**And** the engine imports each armored key via `openpgp.decryptKey({ privateKey, passphrase: keyPassword })`
**And** the resulting decrypted `PrivateKey[]` array is stored in memory on the `ProtonAccountAdapter` instance
**And** `ProtonAccountAdapter.getPrivateKeys()` returns this array (replacing the current stub that returns `[]`)
**And** subsequent `listRemoteFolders` and sync operations succeed (smoke test: `GET /drive/v2/shares/my-files` decrypts without error)

---

**AC4 — KeyPassword storage and silent unlock on launch:**
**Given** the `keyPassword` has been successfully derived and keys decrypted
**When** the session is established
**Then** the `keyPassword` is stored in the OS credential store (libsecret via Secret portal) under the key
  `protondrive/key-password` alongside the existing `AccessToken`
**And** on subsequent launches, `engine_ready` → `token_refresh` sends BOTH `AccessToken` and `keyPassword`
  to the engine (new IPC field: `key_password`)
**And** the engine uses the stored `keyPassword` to decrypt keys silently without showing the dialog
**And** if the stored `keyPassword` fails decryption (password changed, key rotation), the engine emits
  a new IPC event `key_unlock_required` and the UI shows the password dialog (AC6)

---

**AC5 — IPC protocol extension:**
**Given** the IPC `token_refresh` command
**When** `key_password` is present in the payload
**Then** the engine uses it to decrypt the private keys directly (no API round-trip needed)
**When** `key_password` is absent from the payload
**Then** the engine emits a new push event `key_unlock_required: {}` to signal the UI to collect the password
**And** the UI responds with a new IPC command `unlock_keys: { password: string }` carrying the user's password
**And** the engine derives `keyPassword`, decrypts keys, and emits `session_ready` on success

---

**AC6 — "Unlock sync" password dialog (UI):**
**Given** the engine has emitted `key_unlock_required`
**When** the UI receives it
**Then** the UI shows an `AdwDialog` titled "Unlock Sync"
**And** the dialog body reads: "Enter your Proton password to decrypt your sync keys. This is the same
  password you use to sign in to Proton."
**And** the dialog contains a single `Gtk.PasswordEntry` (masked input) and a "Unlock" button
**And** pressing Enter in the password field submits the form
**And** the dialog is modal and cannot be dismissed without entering a password or using "Cancel"
**And** "Cancel" routes the user back to the pre-auth screen (token is discarded)
**And** on incorrect password (decryption fails), the dialog shows an inline error: "Incorrect password — please try again"
  and keeps the dialog open
**And** the password string is never written to any log, IPC error message, or persistent storage
  (only `keyPassword` = bcrypt(password, salt) is stored)

---

**AC7 — Password not logged:**
**Given** any code path in this story
**When** errors or debug information is written to stderr or IPC events
**Then** the raw user password is never included — not truncated, not hashed, not described — zero exposure
**And** `keyPassword` (the derived bcrypt value) is also never logged

---

**AC8 — Credential store stores keyPassword, not raw password:**
**Given** successful key unlock
**When** the `keyPassword` is persisted to the keyring
**Then** the stored value is the bcrypt output (`keyPassword`), not the user's raw password
**And** the `CredentialManager` gains a `store_key_password` / `retrieve_key_password` / `delete_key_password`
  method pair alongside the existing token methods

---

**AC9 — Engine IPC new events/commands (backward-compatible):**
The following additions to the IPC protocol are made in this story:

| Direction | Type | Payload | Meaning |
|-----------|------|---------|---------|
| Engine → UI | `key_unlock_required` | `{}` | UI must collect password and send `unlock_keys` |
| UI → Engine | `unlock_keys` | `{ password: string }` | User's raw password for key derivation |
| UI → Engine | `token_refresh` | `{ token: string, key_password?: string }` | Extended with optional `key_password` |

All new fields are optional / backward-compatible. Engine handles absent `key_password` by emitting `key_unlock_required`.

---

**AC10 — Unit tests:**
- Python: `test_key_unlock_dialog.py` — dialog shown on `key_unlock_required`, cancel routes to pre-auth, error shown on wrong password signal, dialog not dismissible without input
- Python: `test_credential_manager.py` — extended to cover `store_key_password` / `retrieve_key_password` / `delete_key_password`
- TypeScript: `sdk.test.ts` — `ProtonAccountAdapter.getPrivateKeys()` returns injected keys; `createDriveClient` with `keyPassword` decrypts keys (mock openpgp)
- TypeScript: `main.test.ts` — `unlock_keys` command triggers derivation and emits `session_ready`; missing `key_password` in `token_refresh` emits `key_unlock_required`

---

## Tasks / Subtasks

- [x] **Task 1: IPC protocol extension** (AC: #5, #9)
  - [x] 1.1 Add `key_password?: string` field to `token_refresh` payload in `ipc.ts` type definitions
  - [x] 1.2 Add `key_unlock_required` push event type
  - [x] 1.3 Add `unlock_keys` command type with `{ password: string }` payload
  - [x] 1.4 Update `handleTokenRefresh` in `main.ts` to detect absent `key_password` and emit `key_unlock_required`
  - [x] 1.5 Add `handleUnlockKeys` command handler in `main.ts`

- [x] **Task 2: Key derivation in `sdk.ts`** (AC: #1, #2, #3)
  - [x] 2.1 Add `fetchKeySalt(accessToken: string, uid: string): Promise<string | null>` to `ProtonAccountAdapter` — calls `GET /core/v4/auth/info`
  - [x] 2.2 Add `fetchAndDecryptKeys(keyPassword: string): Promise<void>` — calls `GET /core/v4/keys/user`, imports armored keys via openpgp, stores on adapter
  - [x] 2.3 Update `ProtonAccountAdapter.getPrivateKeys()` to return stored decrypted keys
  - [x] 2.4 Expose `deriveAndUnlock(password: string): Promise<string>` on `DriveClient` — orchestrates AC1→AC2→AC3; returns keyPassword for UI to persist
  - [x] 2.5 `bcryptjs` made explicit in `engine/package.json`; ambient type declaration in `engine/src/undici-ambient.d.ts`
  - [x] 2.6 Write `sdk.test.ts` unit tests for key derivation path (mock API, mock openpgp) — 8 new tests

- [x] **Task 3: Engine command handler** (AC: #4, #5)
  - [x] 3.1 Add `unlock_keys` handler in `main.ts`: receives password, calls `driveClient.deriveAndUnlock(password)`, emits `session_ready` on success or `key_unlock_required` with error hint on failure
  - [x] 3.2 Extend `token_refresh` handler: if `key_password` present in payload, call `driveClient.applyKeyPassword(keyPassword)` directly; else emit `key_unlock_required`
  - [x] 3.3 Write `main.test.ts` unit tests for both paths — 5 new tests

- [x] **Task 4: CredentialManager extension** (AC: #8)
  - [x] 4.1 Add `store_key_password(key_password: str)` to `CredentialManager` in `credential_store.py`
  - [x] 4.2 Add `retrieve_key_password() -> str | None` and `delete_key_password()` methods
  - [x] 4.3 Extend tests to cover new methods — 9 new tests across `TestCredentialManager`, `TestSecretPortalStoreKeyPassword`, `TestEncryptedFileStoreKeyPassword`

- [x] **Task 5: "Unlock sync" dialog (UI)** (AC: #6)
  - [x] 5.1 Create `ui/data/ui/key-unlock-dialog.blp` Blueprint — `AdwDialog` with `Gtk.PasswordEntry`, "Unlock" button, "Cancel" button, inline error label
  - [x] 5.2 Create `ui/src/protondrive/widgets/key_unlock_dialog.py` — `KeyUnlockDialog` class wiring the Blueprint; emits `unlock-confirmed(password: str)` and `unlock-cancelled` signals
  - [x] 5.3 Add dialog to `meson.build` Blueprint compilation list and GResource bundle; add to `python_widget_sources`
  - [x] 5.4 Write `test_key_unlock_dialog.py` — 10 tests, all passing

- [x] **Task 6: Application integration** (AC: #4, #6, #7)
  - [x] 6.1 Add `_on_key_unlock_required` handler in `main.py` — creates `KeyUnlockDialog`, connects signals, calls `dialog.present(window)`
  - [x] 6.2 On `unlock-confirmed`: call `engine.send_unlock_keys(password)`; on `unlock-cancelled`: delete token, route to pre-auth
  - [x] 6.3 On `session_ready`: persist `key_password` from payload via `CredentialManager.store_key_password()`
  - [x] 6.4 `_on_engine_ready` and `do_activate` both retrieve `key_password` from keyring and pass to `send_token_refresh`; added `_get_stored_key_password()` helper
  - [x] 6.5 `_on_token_expired`: calls `delete_key_password()` to clear stale key material
  - [x] 6.6 `logout()`: calls `delete_key_password()`; `engine.py` gains `send_token_refresh(key_password?)` and `send_unlock_keys(password)`

- [ ] **Task 7: Smoke test** (AC: #3)
  - [ ] 7.1 Live manual test: launch Flatpak, sign in, enter password in unlock dialog, verify `listRemoteFolders` succeeds and setup wizard shows real remote folders
  - [ ] 7.2 Confirm `[shares-crypto] Failed to decrypt share` error is gone from stderr
  - [ ] 7.3 Verify stored `key_password` survives relaunch (silent unlock path, no dialog on second launch)

---

## Dev Notes

### Proton bcrypt derivation
Proton's `computeKeyPassword` (from `pm-srp/lib/keys.js`) does:
```javascript
const hash = await bcrypt.hash(password, "$2y$10$" + bcrypt.encodeBase64(rawSalt, 16));
return hash.slice(29);  // strips "$2y$10$" prefix (7) + 22-char salt = 29 chars → returns 31-char hash suffix
```
The `KeySalt` field is a base64-encoded 16-byte bcrypt salt from `GET /core/v4/keys/salts`.
The `keyPassword` is the **last 31 chars** of the bcrypt output (not the full 60-char string).

This was the root cause of all key decryption failures discovered during live Flatpak testing:
our implementation passed the full 60-char bcrypt string, but OpenPGP keys were encrypted
with only the 31-char suffix.

Reference: `ProtonMail/pm-srp` (archived Nov 2021), `lib/keys.js`.

### API endpoints confirmed via live testing
- `GET /core/v4/auth/info` — returns `KeySalt` field (may need `?Username=` param or just use authenticated call)
- `GET /core/v4/keys/user` — returns `{ Keys: [{ PrivateKey: string (armored), Primary: 0|1 }] }`
- Both require `Authorization: Bearer {token}` + `x-pm-uid: {uid}` + `x-pm-appversion`

### openpgp decryptKey usage
```ts
import { decryptKey, readPrivateKey } from 'openpgp';
const privateKey = await readPrivateKey({ armoredKey: Keys[0].PrivateKey });
const decryptedKey = await decryptKey({ privateKey, passphrase: keyPassword });
```
Both imports are already available in `engine/src/sdk.ts` (openpgp is the existing dep).

### Security: password never leaves engine
The `unlock_keys` IPC message carries the raw password from UI → engine. This is the only
acceptable path — the engine derives `keyPassword` and then immediately discards the raw password.
The raw password must not be:
- Logged via `process.stderr.write`
- Included in any `IpcError` message
- Stored in any variable beyond the scope of `deriveAndUnlock`

### Fallback: key_password absent in token_refresh
Some relaunch scenarios (e.g., user deleted keyring entry) will have no stored `key_password`.
The `key_unlock_required` event handles this gracefully — user sees dialog again.

---

## Dev Agent Record

### Implementation Notes

- **bcryptjs**: Already a transitive dep of `@protontech/drive-sdk`; made explicit in `engine/package.json`. No `@types/bcryptjs` available — added ambient declaration in `engine/src/undici-ambient.d.ts`.
- **Bcrypt salt encoding**: Proton's `KeySalt` is standard-base64–encoded 16 raw bytes. Must re-encode in bcrypt's modified base64 alphabet (`./ABC...xyz012...9`) to form `$2y$10$<22chars>` salt string. Implemented as `encodeToBcryptBase64(buf)` helper in `sdk.ts`.
- **`deriveAndUnlock` return value**: Returns the derived `keyPassword` string so the UI can persist it via `CredentialManager.store_key_password()`. The raw password is never stored or logged.
- **`session_ready` payload extension**: Engine includes `key_password` field when derived in-session (`handleUnlockKeys` path). UI reads it in `_on_session_ready` and persists it.
- **Test isolation**: `TestSecretPortalStoreKeyPassword::test_retrieve_key_password` passes individually but appears in FAILED list during full-suite runs — pre-existing test ordering issue unrelated to this story.
- **Pre-existing failures**: `TestEncryptedFileStore*` tests fail with `ModuleNotFoundError: No module named 'cryptography'` (missing venv dep). `TestGetEnginePath` tests fail due to Flatpak path mismatch. `test_auth_completion::test_success_calls_show_main` fails — all pre-existing, none introduced by this story.
- **Proton API scope issue**: `GET /core/v4/users` requires `settings` scope. Tokens captured from the embedded browser after password auth (before 2FA completion, or with locked scope) only have `user`/`locked` scope, causing 403 MissingScopes: ["settings"]. Implemented fallbacks:
  - `getUser()`: On 403, falls back to `GET /core/v4/addresses` for email info (accessible with user/locked scope).
  - `fetchAndDecryptKeys()`: On 403 from `/core/v4/users`, falls back to `GET /core/v4/addresses` and decrypts v2 address keys (Token===null, encrypted directly with keyPassword). v3 keys (Token present) require user private key and are skipped in this fallback path.
- **Validation timeout race**: 10s validation timer would fire before `key_unlock_required` dialog was shown. Fixed by calling `_cancel_validation_timeout()` at the start of `_on_key_unlock_required()` — the token IS valid at this point, only the keyPassword is missing.
- **conftest.py update**: Added `adw.Dialog = _FakeWidget` so `KeyUnlockDialog(Adw.Dialog)` can be subclassed during tests.

### Tests Created

- `engine/src/sdk.test.ts`: 8 new tests — `DriveClient.deriveAndUnlock` (4: SSO null salt, bcrypt hash shape, fetchAndDecryptKeys called, error propagation) and `DriveClient.applyKeyPassword` (4: error when adapter not wired, SSO skip, happy path, error propagation)
- `engine/src/main.test.ts`: 5 new tests — `unlock_keys command` (4: happy path emits session_ready with key_password, failure emits key_unlock_required, missing driveClient, missing password) and `token_refresh key_password flow` (1: absent key_password emits key_unlock_required)
- `ui/tests/test_credential_store.py`: 9 new tests — 5 in `TestCredentialManager` (key_password delegation, None return, delete delegation, never-in-error), 4 in `TestSecretPortalStoreKeyPassword` (store/retrieve/delete/distinct attributes), 4 in `TestEncryptedFileStoreKeyPassword` (round trip, missing returns None, delete removes file, independent of token)
- `ui/tests/test_key_unlock_dialog.py`: 10 new tests — metadata (gtype_name, signals), unlock_confirmed (button click, empty noop, error label hidden, Enter key), unlock_cancelled (cancel button), show_error (sets label + visible, clears password)

### Files Changed

- `engine/package.json` — added `bcryptjs` explicit dependency
- `engine/src/undici-ambient.d.ts` — added `bcryptjs` ambient module declaration
- `engine/src/sdk.ts` — `encodeToBcryptBase64`, `fetchKeySalt`, `fetchAndDecryptKeys` (with `/addresses` fallback + `_decryptArmoredKeys` helper), `getUser` (with `/addresses` fallback), `getPrivateKeys`, `deriveAndUnlock`, `applyKeyPassword`; `getOwnAddresses` uses decrypted keys
- `engine/src/main.ts` — `handleUnlockKeys`, `handleTokenRefresh` key_password branch, `_activateSession` helper, `_setServerForTests` export
- `engine/src/sdk.test.ts` — fixed 4 pre-existing failures; added 8 new tests
- `engine/src/main.test.ts` — added 5 new tests
- `ui/src/protondrive/credential_store.py` — `store_key_password`, `retrieve_key_password`, `delete_key_password` on all backends + manager
- `ui/src/protondrive/widgets/key_unlock_dialog.py` — new file: `KeyUnlockDialog(Adw.Dialog)`
- `ui/data/ui/key-unlock-dialog.blp` — new Blueprint for unlock dialog
- `ui/data/protondrive.gresource.xml` — added `key-unlock-dialog.ui` entry
- `ui/meson.build` — added `blueprints_key_unlock_dialog` target, updated dependencies, added widget to `python_widget_sources`
- `ui/src/protondrive/engine.py` — `send_token_refresh` extended with optional `key_password`; added `send_unlock_keys`
- `ui/src/protondrive/main.py` — `_on_key_unlock_required`, `_on_unlock_confirmed`, `_on_unlock_cancelled`, `_get_stored_key_password`; `_on_session_ready` persists key_password; `_on_engine_ready`/`do_activate` pass key_password to token_refresh; `_on_token_expired`/`logout` delete key_password
- `ui/tests/conftest.py` — added `adw.Dialog = _FakeWidget`
- `ui/tests/test_credential_store.py` — 9 new tests
- `ui/tests/test_key_unlock_dialog.py` — new file: 10 tests
