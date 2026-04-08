# Story 1.6: Credential Storage (libsecret + Fallback)

Status: ready-for-dev

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

- [ ] Task 1: Create `CredentialStore` abstraction layer (AC: #1, #2, #3, #5, #6)
  - [ ] 1.1 Create `ui/src/protondrive/credential_store.py` with abstract base class `CredentialStore` defining `store_token()`, `retrieve_token()`, `delete_token()`, `backend_name` property
  - [ ] 1.2 Add type hints on all methods; use `from __future__ import annotations`
  - [ ] 1.3 Define `CredentialBackend` enum: `SECRET_PORTAL`, `ENCRYPTED_FILE`, `NONE`

- [ ] Task 2: Implement `SecretPortalStore` (libsecret backend) (AC: #1, #5, #6)
  - [ ] 2.1 Create `SecretPortalStore(CredentialStore)` class using `gi.repository.Secret`
  - [ ] 2.2 Define `Secret.Schema` with attributes: `{"app": "ProtonDriveLinuxClient", "type": "session-token"}`
  - [ ] 2.3 Implement `store_token(token: str) -> None` using `Secret.password_store_sync()`
  - [ ] 2.4 Implement `retrieve_token() -> str | None` using `Secret.password_lookup_sync()`
  - [ ] 2.5 Implement `delete_token() -> None` using `Secret.password_clear_sync()`
  - [ ] 2.6 Implement `is_available() -> bool` — attempt a no-op Secret portal call to verify the portal responds; catch `GLib.Error` on failure

- [ ] Task 3: Implement `EncryptedFileStore` (fallback backend) (AC: #2, #5, #6)
  - [ ] 3.1 Create `EncryptedFileStore(CredentialStore)` class
  - [ ] 3.2 Derive encryption key from machine-specific entropy (e.g., `machine-id` + app ID + salt); use `hashlib.pbkdf2_hmac` with SHA-256
  - [ ] 3.3 Encrypt token with `cryptography.fernet.Fernet` (symmetric, authenticated encryption)
  - [ ] 3.4 Implement file creation with `0600` permissions set BEFORE content: `os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)` — never `open()` then `chmod()`
  - [ ] 3.5 Store path: `~/.var/app/io.github.ronki2304.ProtonDriveLinuxClient/data/keyrings/session.enc` (Flatpak); `$XDG_DATA_HOME/protondrive/keyrings/session.enc` (native dev)
  - [ ] 3.6 Implement `retrieve_token()` — decrypt and return; return `None` if file missing or decryption fails
  - [ ] 3.7 Implement `delete_token()` — securely delete file (`os.unlink()`)
  - [ ] 3.8 Implement `is_available() -> bool` — verify parent directory is writable

- [ ] Task 4: Implement `CredentialManager` facade (AC: #1, #2, #3, #4)
  - [ ] 4.1 Create `CredentialManager` class that probes backends in order: `SecretPortalStore` then `EncryptedFileStore`
  - [ ] 4.2 On init, call `is_available()` on each backend; select first available; set `active_backend` property
  - [ ] 4.3 If fallback is selected, emit a message string for the UI: "Credential storage unavailable via Secret portal -- falling back to encrypted file store"
  - [ ] 4.4 If neither available, raise `AuthError("No secure credential storage available")`
  - [ ] 4.5 Delegate `store_token()`, `retrieve_token()`, `delete_token()` to active backend
  - [ ] 4.6 Ensure token value never appears in any `__repr__`, `__str__`, log message, or exception message — all error messages reference "token" generically, never include the value

- [ ] Task 5: Integrate with auth flow (AC: #1, #5)
  - [ ] 5.1 Instantiate `CredentialManager` in `main.py` `Application` class (singleton, like `Gio.Settings`)
  - [ ] 5.2 Pass `CredentialManager` to `auth.py` and `window.py` via constructor
  - [ ] 5.3 After auth callback receives token: call `credential_manager.store_token(token)`
  - [ ] 5.4 On app launch: call `credential_manager.retrieve_token()` — if token exists, skip auth flow
  - [ ] 5.5 On logout / token invalidation: call `credential_manager.delete_token()`

- [ ] Task 6: Add `AuthError` to error hierarchy (AC: #3, #4)
  - [ ] 6.1 Add `AuthError(AppError)` to UI error classes if not already present
  - [ ] 6.2 Use `AuthError` for all credential storage/retrieval failures
  - [ ] 6.3 Verify `AuthError` message never contains the token value — only descriptive text

- [ ] Task 7: Write tests (AC: #1, #2, #3, #4, #5, #6)
  - [ ] 7.1 In `ui/tests/test_credential_store.py`: test `SecretPortalStore` with mocked `gi.repository.Secret`
  - [ ] 7.2 Test `EncryptedFileStore` with temp directory — verify `0600` permissions on created file
  - [ ] 7.3 Test `EncryptedFileStore` — verify round-trip: store then retrieve returns same token
  - [ ] 7.4 Test `CredentialManager` fallback selection: mock `SecretPortalStore.is_available()` returning `False`
  - [ ] 7.5 Test `CredentialManager` raises `AuthError` when both backends unavailable
  - [ ] 7.6 Test token never appears in exception messages — catch `AuthError`, assert token string not in `str(error)`
  - [ ] 7.7 Test `delete_token()` on both backends
  - [ ] 7.8 Add mock `CredentialManager` fixture to `ui/tests/conftest.py`

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

### Debug Log References

### Completion Notes List

### File List
