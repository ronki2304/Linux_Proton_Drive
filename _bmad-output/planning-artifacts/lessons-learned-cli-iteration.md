# Lessons Learned: CLI Iteration (2026-04-01 to 2026-04-06)

## Core Finding

**The Proton SDK (`@protontech/drive-sdk` ^0.14.3) is designed for GUI use, not headless/scriptable use.**

The SDK's auth flow requires interactive human presence:
- **CAPTCHA (Code 9001)** fires on both `/auth/v4/info` and `/auth/v4` — any auth attempt can trigger it
- **2FA (TOTP)** requires interactive input with partial session token carry-forward
- **Session tokens have limited lifetime** — when they expire, re-auth requires a human in front of a browser
- This makes unattended cron/CI usage fundamentally unreliable

Proton is reportedly working on a new SDK version. Until that ships, the tool must assume interactive human presence.

## Technical Discoveries

### SRP Authentication
- No npm SRP library matches Proton's custom SRP-B variant — must implement from scratch
- Reference implementations: `henrybear327/Proton-API-Bridge` (Go), rclone's SRP port
- Working implementation validated against live Proton auth endpoint

### API URL Mismatch
- `account-service.ts` and `client.ts` in the SDK use `api.proton.me` (ConnectionRefused)
- Working auth code uses `mail.proton.me/api`
- The base URL must be centralized; `mail.proton.me/api` is the one that works

### Bun Compilation
- `bun build --compile` works with the ProtonDrive SDK (validated Bun 1.3.11, Linux x86_64 Fedora 43)
- `@napi-rs/keyring@1.2.0` native addon embeds correctly in compiled binary (Bun 1.3.x)
- No `dbus-next` pure-JS fallback needed — NAPI-RS bundles cleanly
- Commander.js (~35ms overhead) works well for CLI structure

### Architecture Patterns That Worked
- `DriveClient` service class as sole SDK import boundary — isolates SDK version churn
- `CredentialStore` interface with KeyringStore + FileStore fallback — runtime selection based on keychain availability
- `bun:sqlite` for sync state (zero dependency, atomic writes, queryable)
- Error class hierarchy (`ProtonDriveError` → `AuthError | SyncError | NetworkError | ConfigError`) with universal exit codes
- Atomic file writes (`*.protondrive-tmp` → rename) for crash safety
- Delta detection: mtime-first, SHA-256 hash on change

### What Didn't Work
- Designing for headless-first when the SDK requires interactive auth
- Assuming session tokens would be long-lived enough for cron use
- The "scriptable CLI" value proposition — broken by SDK auth constraints

## Implications for GUI Iteration

- Auth flow must be interactive-first (embedded browser or system browser redirect for CAPTCHA)
- Session management needs a persistent process that can prompt re-auth when tokens expire
- The sync engine, config layer, state DB, and credential store designs are all reusable
- CLI can coexist as a secondary interface for terminal-comfortable users
- Headless/cron use should be documented as best-effort, gated on future SDK improvements
