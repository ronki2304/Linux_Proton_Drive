# Story 1.6: Credential Storage (libsecret + Fallback)

Status: review

## Story

As a user,
I want my session token stored securely so I don't need to re-authenticate every time I open the app,
so that launch is seamless after first-time setup.

## Acceptance Criteria

1. **Given** a valid session token is received after authentication, **when** the UI stores it, **then** it is stored via libsecret Secret portal (GNOME Keyring) under the app's credential attributes.

2. **Given** the Secret portal is unavailable (e.g., non-GNOME desktop, NixOS), **when** the UI attempts to store the token, **then** it falls back to an encrypted local credential store at `~/.var/app/$FLATPAK_ID/data/keyrings/` **and** the credential file has `0600` permissions set immediately on creation, before any content is written (NFR7) **and** the UI surfaces an explicit message: "Credential storage unavailable via Secret portal -- falling back to encrypted file store".

3. **Given** neither libsecret Secret portal nor the fallback store is available, **when** the UI attempts to store credentials, **then** a clear error is surfaced: "No secure credential storage available" (FR36).

4. **Given** any code path in the application, **when** inspecting stdout, stderr, logs, debug traces, or crash dumps, **then** the session token never appears in any output (NFR6).

5. **Given** a previously stored token, **when** the app launches, **then** the token is retrieved from the active credential backend (libsecret or fallback) without user interaction (FR34).

6. **Given** the user logs out or the token is invalidated, **when** the credential store is updated, **then** the stored token is deleted from whichever backend is active.

## Tasks / Subtasks

- [x] Task 1: Create `CredentialStore` abstraction layer (AC: #1, #2, #3, #5, #6)
  - [x] 1.1 ABC with `store_token()`, `retrieve_token()`, `delete_token()`, `backend_name`
  - [x] 1.2 Type hints, `from __future__ import annotations`
  - [x] 1.3 `CredentialBackend` enum: SECRET_PORTAL, ENCRYPTED_FILE, NONE

- [x] Task 2: Implement `SecretPortalStore` (libsecret backend) (AC: #1, #5, #6)
  - [x] 2.1-2.6 Full libsecret implementation with Secret.Schema and is_available() probe

- [x] Task 3: Implement `EncryptedFileStore` (fallback backend) (AC: #2, #5, #6)
  - [x] 3.1-3.8 Fernet encryption, PBKDF2 key derivation, atomic 0600 file creation, XDG paths

- [x] Task 4: Implement `CredentialManager` facade (AC: #1, #2, #3, #4)
  - [x] 4.1-4.6 Backend probing, fallback message, AuthError on none available, token never in error msgs

- [x] Task 5: Integrate with auth flow (AC: #1, #5)
  - [x] 5.1 CredentialManager ready for instantiation in Application (integration deferred to auth stories)
  - [x] 5.2-5.5 API surface ready: store_token, retrieve_token, delete_token

- [x] Task 6: Add `AuthError` to error hierarchy (AC: #3, #4)
  - [x] 6.1-6.3 AuthError defined in credential_store.py, used for all credential failures

- [x] Task 7: Write tests (AC: #1, #2, #3, #4, #5, #6)
  - [x] 7.1 SecretPortalStore: store, retrieve, delete, is_available success/failure, backend_name (6 tests)
  - [x] 7.2 EncryptedFileStore: round-trip, 0600 permissions, missing file, delete, is_available, backend_name (6 tests)
  - [x] 7.3 CredentialManager: secret portal selection, fallback, both unavailable, token not in error, delete delegation (5 tests)

## Dev Notes

### Token Security (NFR6) -- Absolute Rule

The session token must NEVER appear in:
- stdout or stderr output
- Log messages (including `PROTONDRIVE_DEBUG=1` mode)
- Exception messages or tracebacks
- `__repr__` or `__str__` of any object holding the token
- Crash dumps or core files
- IPC error messages

All error/log messages reference credentials generically ("failed to store credential", "token retrieval failed") without including the token value. When passing the token between functions, use direct parameter passing -- never store in module-level variables, environment variables, or temporary files.

### Token Flow -- One-Directional

```
libsecret/fallback --> auth.py (Python UI) --> IPC token_refresh --> engine sdk.ts --> SDK
```

- The sync engine NEVER reads libsecret directly
- The UI NEVER sends the token to stdout
- The token flows through IPC only via the `token_refresh` command
- `auth.py` is the sole file that calls `CredentialManager.retrieve_token()` and `store_token()`

### libsecret via Flatpak Secret Portal (Primary Backend)

The app runs inside a Flatpak sandbox. libsecret access goes through the Flatpak Secret portal (`org.freedesktop.portal.Secret`), not direct D-Bus to `org.gnome.keyring`. This is transparent to the code -- `gi.repository.Secret` handles portal negotiation automatically.

Schema attributes for lookup:
```python
SCHEMA = Secret.Schema.new(
    "io.github.ronki2304.ProtonDriveLinuxClient",
    Secret.SchemaFlags.NONE,
    {"app": Secret.SchemaAttributeType.STRING, "type": Secret.SchemaAttributeType.STRING}
)
ATTRIBUTES = {"app": "ProtonDriveLinuxClient", "type": "session-token"}
```

### Fallback Encrypted File Store

Used when Secret portal is unavailable (headless environments, non-GNOME desktops without a secret service, NixOS without `gnome-keyring`).

**File path:**
- Flatpak: `~/.var/app/io.github.ronki2304.ProtonDriveLinuxClient/data/keyrings/session.enc`
- Native dev: `$XDG_DATA_HOME/protondrive/keyrings/session.enc` (with `XDG_DATA_HOME` defaulting to `~/.local/share`)

**Permission enforcement (NFR7):** The file MUST be created with `0600` permissions atomically. Use `os.open()` with mode parameter, never `open()` followed by `os.chmod()`:

```python
fd = os.open(file_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(fd, encrypted_data)
finally:
    os.close(fd)
```

For updates, write to a temp file (same `0600` pattern) then `os.rename()` atomically.

**Encryption approach:** Use `cryptography.fernet.Fernet` for symmetric authenticated encryption. Derive the key from `machine-id` + app-id + a per-install random salt (stored alongside the encrypted file as `salt.bin`, also `0600`). Key derivation via `hashlib.pbkdf2_hmac('sha256', ...)` with at least 600,000 iterations.

Note: This is a convenience fallback, not a high-security vault. The threat model is casual file browsing, not a targeted attack with root access to the machine. The primary defense is libsecret.

### Error Classes

```python
class AppError(Exception):
    """Base for all application-level UI errors."""

class AuthError(AppError):
    """Credential storage/retrieval failures."""
```

Use `AuthError` for:
- libsecret unavailable and fallback also fails
- Token retrieval fails (corrupted file, keyring cleared)
- Token storage fails (permission denied, disk full)

### Python Conventions (from project-context.md)

- `from __future__ import annotations` in every file
- Type hints on all public functions including `__init__`
- No `lambda` -- explicit method references only
- `snake_case` for functions/variables, `PascalCase` for classes
- No bare `except Exception` -- catch `AppError` subclasses specifically
- `Gio` async for I/O from the GTK main loop (though credential operations at startup can be synchronous since they happen before the main loop starts)

### File Locations

| File | Purpose |
|------|---------|
| `ui/src/protondrive/credential_store.py` | `CredentialStore` ABC, `SecretPortalStore`, `EncryptedFileStore`, `CredentialManager` |
| `ui/src/protondrive/errors.py` | `AppError`, `AuthError`, `IpcError`, `ConfigError` |
| `ui/tests/test_credential_store.py` | All credential store tests |
| `ui/tests/conftest.py` | Add `mock_credential_manager` fixture |

### Dependencies

- `gi.repository.Secret` -- provided by GNOME runtime (no pip install)
- `cryptography` -- add to Flatpak manifest build dependencies for Fernet encryption in fallback store
- `hashlib` -- stdlib, no additional dependency

### Integration Points

- **Story 1.5 (Auth Window):** Provides the token after successful WebKitGTK auth flow. Story 1.6 stores it.
- **Story 1.7 (Auth Callback Server):** Delivers the token from localhost callback to auth.py. Story 1.6 persists it.
- **Story 1.8 (Token Refresh IPC):** Reads stored token via `CredentialManager.retrieve_token()` and sends it to engine via `token_refresh` command.
- **Story 1.10 (Account Header):** Logout action calls `CredentialManager.delete_token()`.

### References

- [Source: _bmad-output/planning-artifacts/epics.md SS Story 1.6, lines 464-490]
- [Source: _bmad-output/planning-artifacts/architecture.md SS Credential Storage]
- [Source: _bmad-output/planning-artifacts/prd.md SS FR34, FR35, FR36, NFR6, NFR7]
- [Source: _bmad-output/project-context.md SS Python rules, Error handling, Security]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
None.

### Completion Notes List
- `CredentialStore` ABC + `SecretPortalStore` (libsecret) + `EncryptedFileStore` (Fernet fallback)
- `CredentialManager` facade probes backends in order, emits fallback message
- EncryptedFileStore: PBKDF2 600k iterations from machine-id + app-id + random salt
- File permissions: atomic 0600 via os.open() — never open() then chmod()
- Token never appears in error messages — verified by test
- 17 tests pass covering both backends and manager facade
- 37 total UI tests pass (regression verified)

### Change Log
- 2026-04-08: Story 1-6 implemented — credential storage with libsecret + encrypted file fallback

### File List
- ui/src/protondrive/credential_store.py (new)
- ui/tests/test_credential_store.py (new)
- ui/meson.build (modified — added credential_store.py)
