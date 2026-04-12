# Sprint Change Proposal — 2026-04-11

**Workflow:** Correct Course (CC)
**Triggered by:** Jeremy
**Approved by:** Jeremy (2026-04-11)
**Scope:** Minor — implemented by development team

---

## Section 1: Issue Summary

**Problem:** Browser-based auth (WebKit cookie extraction) yields only `AccessToken` + `UID`. Proton
Drive share keys are encrypted with the user's OpenPGP private key, which is itself encrypted with
a `keyPassword` derived from the login password via bcrypt. This value is never transmitted in any
cookie or HTTP response — it is computed client-side from the user's password at login time.

Without `keyPassword`, `ProtonAccountAdapter.getPrivateKeys()` returns `[]`, causing
`decryptSessionKey` to fail for every share. Result: `listRemoteFolders` fails, the setup wizard
cannot display remote folders, and all sync operations are completely broken.

**When discovered:** Live Flatpak validation (Story 2.10) — first real end-to-end auth run in the
Flatpak sandbox on 2026-04-11.

**Evidence:**
```
ERROR [shares-crypto] Failed to decrypt share 8wx_... (from before 2024: undefined)
Error: Error decrypting session keys: Session key decryption failed.
  at ProtonOpenPGPCryptoProxy.decryptSessionKey (sdk.js:514)
  ...
ERROR [shares] Failed to get active volume
```

---

## Section 2: Impact Analysis

**Epic Impact:**
- Epic 2 (First Sync Pair & File Sync): additive change only — new story 2-11 inserted before retrospective. Epic goal (working sync) now achievable.
- Epics 3–7: unaffected — they assume working sync, which this story enables.

**Story Impact:**
- Story 2-11 added: `ready-for-dev`
- All other Epic 2 stories: unchanged
- Story 2.10 (Flatpak Build Validation): remains `in-progress`, unblocked by this change

**Artifact Conflicts:**
- `epics.md`: Story 2.11 added ✓
- `sprint-status.yaml`: `2-11-key-password-derivation: ready-for-dev` added ✓
- `_bmad-output/implementation-artifacts/2-11-key-password-derivation.md`: created ✓
- `PRD FR34`: "stores session token" should be read as "stores session credentials including keyPassword" — no formal update required (interpretation, not contradiction)
- Architecture doc: token flow diagram implicitly extends — no blocking update needed before implementation

**Technical Impact:**
- New IPC events: `key_unlock_required` (engine→UI), `unlock_keys` (UI→engine)
- Extended `token_refresh` payload: `key_password?: string`
- New `CredentialManager` methods: `store_key_password` / `retrieve_key_password` / `delete_key_password`
- New `ProtonAccountAdapter` methods: `fetchKeySalt`, `fetchAndDecryptKeys`, `deriveAndUnlock`
- New UI widget: `KeyUnlockDialog` (AdwDialog + PasswordEntry)
- bcrypt dependency (verify if already available via drive-sdk before adding new dep)

---

## Section 3: Recommended Approach

**Selected: Direct Adjustment (Option 1)**

Add Story 2-11 within Epic 2. No rollbacks, no MVP reduction, no epic resequencing.

**Rationale:**
- The issue is bounded: one missing derivation step, well-understood Proton API, validated by proton-drive-sync reference implementation
- All required API endpoints confirmed working via live testing (`/core/v4/auth/info`, `/core/v4/keys/user`)
- openpgp is already a dependency in `engine/src/sdk.ts` — `decryptKey` API is available
- Effort: Medium (~2 dev sessions). Risk: Low.
- Option B (full SRP auth replacing browser) deferred — higher complexity, not needed to unblock Epic 2

---

## Section 4: Detailed Change Proposals

### New Story: `2-11-key-password-derivation.md`

Created at: `_bmad-output/implementation-artifacts/2-11-key-password-derivation.md`

Key AC summary:
- AC1: Fetch bcrypt salt from `GET /core/v4/auth/info`
- AC2: Derive `keyPassword = bcrypt(password, salt)`; handle null salt (SSO accounts)
- AC3: Fetch + decrypt private keys; `getPrivateKeys()` returns real keys
- AC4: Store `keyPassword` in keyring; silent unlock on relaunch
- AC5: New IPC events (`key_unlock_required`, `unlock_keys`, extended `token_refresh`)
- AC6: "Unlock Sync" AdwDialog with PasswordEntry
- AC7–AC8: Password never logged; keyring stores derived value only
- AC9: IPC protocol additions documented and backward-compatible
- AC10: Unit tests for all new paths

### `sprint-status.yaml`

```yaml
# Added:
2-11-key-password-derivation: ready-for-dev  # CC-2026-04-11
```

### `epics.md`

Story 2.11 synopsis appended to Epic 2 story list.

---

## Section 5: Implementation Handoff

**Scope classification:** Minor — development team implements directly.

**Next step:** Invoke `bmad-agent-dev` → DS (Dev Story) → story `2-11-key-password-derivation`

**Success criteria:**
1. `listRemoteFolders` succeeds after user enters password in unlock dialog (no `decryptSessionKey` error)
2. Second launch: no password dialog shown (silent unlock from stored `keyPassword`)
3. All AC10 unit tests pass
4. `[AUTH]` debug log contains no raw password strings

---

*Correct Course workflow complete, Jeremy!*
