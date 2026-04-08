"""Credential storage with libsecret primary and encrypted file fallback."""

from __future__ import annotations

import base64
import hashlib
import os
import secrets
from abc import ABC, abstractmethod
from enum import Enum
from pathlib import Path
from typing import Any

import gi

gi.require_version("Secret", "1")
from gi.repository import GLib, Secret


APP_ID = "io.github.ronki2304.ProtonDriveLinuxClient"
PBKDF2_ITERATIONS = 600_000


class AuthError(Exception):
    """Credential storage/retrieval failures. Never includes the token value."""


class CredentialBackend(Enum):
    SECRET_PORTAL = "secret_portal"
    ENCRYPTED_FILE = "encrypted_file"
    NONE = "none"


class CredentialStore(ABC):
    """Abstract base for credential storage backends."""

    @abstractmethod
    def store_token(self, token: str) -> None: ...

    @abstractmethod
    def retrieve_token(self) -> str | None: ...

    @abstractmethod
    def delete_token(self) -> None: ...

    @abstractmethod
    def is_available(self) -> bool: ...

    @property
    @abstractmethod
    def backend_name(self) -> CredentialBackend: ...


# --- libsecret backend ---

_SCHEMA = Secret.Schema.new(
    APP_ID,
    Secret.SchemaFlags.NONE,
    {
        "app": Secret.SchemaAttributeType.STRING,
        "type": Secret.SchemaAttributeType.STRING,
    },
)
_ATTRIBUTES = {"app": "ProtonDriveLinuxClient", "type": "session-token"}


class SecretPortalStore(CredentialStore):
    """Store credentials via libsecret Secret portal (GNOME Keyring)."""

    @property
    def backend_name(self) -> CredentialBackend:
        return CredentialBackend.SECRET_PORTAL

    def is_available(self) -> bool:
        try:
            Secret.password_lookup_sync(_SCHEMA, _ATTRIBUTES, None)
            return True
        except GLib.Error:
            return False

    def store_token(self, token: str) -> None:
        try:
            Secret.password_store_sync(
                _SCHEMA,
                _ATTRIBUTES,
                Secret.COLLECTION_DEFAULT,
                "ProtonDrive session token",
                token,
                None,
            )
        except GLib.Error as e:
            raise AuthError("Failed to store credential in keyring") from e

    def retrieve_token(self) -> str | None:
        try:
            return Secret.password_lookup_sync(_SCHEMA, _ATTRIBUTES, None)
        except GLib.Error as e:
            raise AuthError("Failed to retrieve credential from keyring") from e

    def delete_token(self) -> None:
        try:
            Secret.password_clear_sync(_SCHEMA, _ATTRIBUTES, None)
        except GLib.Error as e:
            raise AuthError("Failed to delete credential from keyring") from e


# --- Encrypted file backend ---

def _get_fallback_dir() -> Path:
    """Resolve credential file directory."""
    if os.environ.get("FLATPAK_ID"):
        return (
            Path.home()
            / ".var"
            / "app"
            / APP_ID
            / "data"
            / "keyrings"
        )
    data_home = os.environ.get(
        "XDG_DATA_HOME", str(Path.home() / ".local" / "share")
    )
    return Path(data_home) / "protondrive" / "keyrings"


def _derive_key(salt: bytes) -> bytes:
    """Derive Fernet key from machine-id + app-id + salt."""
    machine_id = b""
    try:
        machine_id = Path("/etc/machine-id").read_bytes().strip()
    except OSError:
        machine_id = b"fallback-machine-id"

    raw_key = hashlib.pbkdf2_hmac(
        "sha256",
        machine_id + APP_ID.encode("utf-8"),
        salt,
        PBKDF2_ITERATIONS,
    )
    return base64.urlsafe_b64encode(raw_key)


class EncryptedFileStore(CredentialStore):
    """Fallback: store credentials in an encrypted local file."""

    def __init__(self) -> None:
        self._dir = _get_fallback_dir()
        self._token_path = self._dir / "session.enc"
        self._salt_path = self._dir / "salt.bin"

    @property
    def backend_name(self) -> CredentialBackend:
        return CredentialBackend.ENCRYPTED_FILE

    def is_available(self) -> bool:
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            return os.access(self._dir, os.W_OK)
        except OSError:
            return False

    def store_token(self, token: str) -> None:
        from cryptography.fernet import Fernet

        self._dir.mkdir(parents=True, exist_ok=True)

        # Generate or read salt
        if self._salt_path.exists():
            salt = self._salt_path.read_bytes()
        else:
            salt = secrets.token_bytes(32)
            self._write_secure(self._salt_path, salt)

        key = _derive_key(salt)
        f = Fernet(key)
        encrypted = f.encrypt(token.encode("utf-8"))
        self._write_secure(self._token_path, encrypted)

    def retrieve_token(self) -> str | None:
        from cryptography.fernet import Fernet, InvalidToken

        if not self._token_path.exists() or not self._salt_path.exists():
            return None

        try:
            salt = self._salt_path.read_bytes()
            key = _derive_key(salt)
            f = Fernet(key)
            encrypted = self._token_path.read_bytes()
            return f.decrypt(encrypted).decode("utf-8")
        except (InvalidToken, OSError):
            return None

    def delete_token(self) -> None:
        try:
            self._token_path.unlink(missing_ok=True)
        except OSError as e:
            raise AuthError("Failed to delete credential file") from e

    @staticmethod
    def _write_secure(path: Path, data: bytes) -> None:
        """Write file with 0600 permissions set atomically."""
        tmp_path = path.with_suffix(".tmp")
        fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
        os.rename(str(tmp_path), str(path))


# --- Credential Manager facade ---

class CredentialManager:
    """Probes backends and delegates to the first available one."""

    def __init__(self) -> None:
        self._active: CredentialStore | None = None
        self._backend: CredentialBackend = CredentialBackend.NONE
        self._fallback_message: str | None = None

        secret_store = SecretPortalStore()
        if secret_store.is_available():
            self._active = secret_store
            self._backend = CredentialBackend.SECRET_PORTAL
            return

        file_store = EncryptedFileStore()
        if file_store.is_available():
            self._active = file_store
            self._backend = CredentialBackend.ENCRYPTED_FILE
            self._fallback_message = (
                "Credential storage unavailable via Secret portal "
                "-- falling back to encrypted file store"
            )
            return

        raise AuthError("No secure credential storage available")

    @property
    def active_backend(self) -> CredentialBackend:
        return self._backend

    @property
    def fallback_message(self) -> str | None:
        return self._fallback_message

    def store_token(self, token: str) -> None:
        if self._active is None:
            raise AuthError("No credential backend available")
        self._active.store_token(token)

    def retrieve_token(self) -> str | None:
        if self._active is None:
            raise AuthError("No credential backend available")
        return self._active.retrieve_token()

    def delete_token(self) -> None:
        if self._active is None:
            raise AuthError("No credential backend available")
        self._active.delete_token()
