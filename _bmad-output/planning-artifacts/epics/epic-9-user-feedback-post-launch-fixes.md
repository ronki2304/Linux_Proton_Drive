# Epic 9: User Feedback & Post-Launch Fixes

First post-launch user feedback is triaged, diagnosed, and shipped as targeted fixes. No silent crashes, no security artifacts left in production builds. This epic is reactive — each story maps directly to a confirmed user report or a security finding surfaced during distribution review.

**FRs covered:** None (post-launch reactive fixes, not planned features)
**UX-DRs:** None
**NFRs as acceptance constraints:** NFR6 (token never in output — Story 9-1 resolves a violation)

**Includes:** Engine crash on legacy share key decryption (pre-2024 Proton accounts), removal of debug token dump security artifact `[7-1 CR D9]`, actionable error dialog guiding users to re-wrap old keys in Proton Drive web.

---

## Story 9.1: Session Activation Failure — Legacy Share Key Decryption

As a user with a pre-2024 Proton account,
I want the app to show a clear, actionable error when it cannot decrypt my Drive files after signing in,
so that I know exactly what to do — without the app silently crashing.

**Background:** **GitHub issue #2 (first user feedback):** User on Debian (x86_64) authenticates successfully (keys decrypt, API responds 200) but the engine process crashes immediately after with an unhandled rejection. The app shows nothing; the user is stuck.

Two root causes are fixed together:

- **Bug 1 — Engine crash (fatal):** `_activateSession` calls `startRemoteEventSubscription` with no try/catch. For accounts with a legacy share key format ("from before 2024"), the SDK throws `"No decryption key packets found"`. Since `_activateSession` is invoked via `void`, the rejection is unhandled → Bun process exits → app appears frozen.
- **Bug 2 — Debug token written to disk (security):** `handleTokenRefresh` writes the live access token to `/tmp/proton-debug-token.txt` — an unremoved dev debugging artifact that violates NFR6. Resolves `[7-1 CR D9]`.

**Acceptance Criteria:** See `_bmad-output/implementation-artifacts/9-1-legacy-share-key-decryption-error.md` for full spec (AC1–AC8).

Key outcomes:
- Engine catches decryption failures in `_activateSession` and emits `session_error` instead of crashing
- Non-decryption errors (network, auth) are re-thrown as before — no behaviour change for those paths
- UI registers `session_error`, closes the auth browser, and presents `Adw.AlertDialog` with "Open Proton Drive" (suggested) and "Sign Out" (destructive) actions
- Debug token dump is removed entirely from `engine/src/main.ts`

---
