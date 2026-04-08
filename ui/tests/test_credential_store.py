"""Tests for credential storage backends and manager."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

# Mock gi before importing — SecretPortalStore imports gi.repository.Secret lazily
_secret_mock = MagicMock()
_glib_mock = MagicMock()
_glib_mock.Error = type("GLibError", (Exception,), {})

# Ensure mocks exist in sys.modules regardless of import order
if "gi" not in sys.modules:
    sys.modules["gi"] = MagicMock()
if "gi.repository" not in sys.modules:
    sys.modules["gi.repository"] = MagicMock()

# Wire our mocks into the gi.repository module (even if already set by other tests)
sys.modules["gi.repository"].Secret = _secret_mock
sys.modules["gi.repository"].GLib = _glib_mock
sys.modules["gi.repository.Secret"] = _secret_mock
sys.modules["gi.repository.GLib"] = _glib_mock
sys.modules["gi"].require_version = MagicMock()

from protondrive.errors import AuthError
from protondrive.credential_store import (
    CredentialBackend,
    CredentialManager,
    EncryptedFileStore,
    SecretPortalStore,
    _derive_key,
)


class TestSecretPortalStore:
    """Test libsecret backend with mocked Secret module."""

    def setup_method(self) -> None:
        _secret_mock.reset_mock()
        _glib_mock.reset_mock(side_effect=True)
        _glib_mock.Error = type("GLibError", (Exception,), {})
        # Re-wire mocks — other test files may overwrite sys.modules["gi.repository"]
        sys.modules["gi.repository"].Secret = _secret_mock
        sys.modules["gi.repository"].GLib = _glib_mock
        # Reset lazy schema so each test gets fresh state
        SecretPortalStore._schema = None

    def test_store_token(self) -> None:
        store = SecretPortalStore()
        store.store_token("test-token-123")
        _secret_mock.password_store_sync.assert_called_once()

    def test_retrieve_token(self) -> None:
        store = SecretPortalStore()
        _secret_mock.password_lookup_sync.return_value = "found-token"
        result = store.retrieve_token()
        assert result == "found-token"

    def test_delete_token(self) -> None:
        store = SecretPortalStore()
        store.delete_token()
        _secret_mock.password_clear_sync.assert_called_once()

    def test_is_available_success(self) -> None:
        store = SecretPortalStore()
        _secret_mock.password_lookup_sync.return_value = None
        assert store.is_available()

    def test_is_available_failure(self) -> None:
        store = SecretPortalStore()
        _secret_mock.password_lookup_sync.side_effect = _glib_mock.Error("portal unavailable")
        assert not store.is_available()

    def test_backend_name(self) -> None:
        store = SecretPortalStore()
        assert store.backend_name == CredentialBackend.SECRET_PORTAL


class TestEncryptedFileStore:
    """Test encrypted file fallback backend."""

    def test_round_trip(self) -> None:
        """Store then retrieve returns same token."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = EncryptedFileStore()
            store._dir = Path(tmpdir)
            store._token_path = Path(tmpdir) / "session.enc"
            store._salt_path = Path(tmpdir) / "salt.bin"

            store.store_token("my-secret-token")
            result = store.retrieve_token()

        assert result == "my-secret-token"

    def test_file_permissions_0600(self) -> None:
        """Credential file must have 0600 permissions."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = EncryptedFileStore()
            store._dir = Path(tmpdir)
            store._token_path = Path(tmpdir) / "session.enc"
            store._salt_path = Path(tmpdir) / "salt.bin"

            store.store_token("test-token")

            token_perms = oct(os.stat(store._token_path).st_mode & 0o777)
            salt_perms = oct(os.stat(store._salt_path).st_mode & 0o777)

        assert token_perms == "0o600"
        assert salt_perms == "0o600"

    def test_retrieve_missing_file(self) -> None:
        """Returns None when no credential file exists."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = EncryptedFileStore()
            store._dir = Path(tmpdir)
            store._token_path = Path(tmpdir) / "session.enc"
            store._salt_path = Path(tmpdir) / "salt.bin"

            result = store.retrieve_token()
        assert result is None

    def test_delete_token(self) -> None:
        """Delete removes the credential file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = EncryptedFileStore()
            store._dir = Path(tmpdir)
            store._token_path = Path(tmpdir) / "session.enc"
            store._salt_path = Path(tmpdir) / "salt.bin"

            store.store_token("to-delete")
            assert store._token_path.exists()

            store.delete_token()
            assert not store._token_path.exists()

    def test_is_available(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            store = EncryptedFileStore()
            store._dir = Path(tmpdir)
            assert store.is_available()

    def test_backend_name(self) -> None:
        store = EncryptedFileStore()
        assert store.backend_name == CredentialBackend.ENCRYPTED_FILE


class TestCredentialManager:
    """Test manager facade and backend selection."""

    def test_selects_secret_portal_when_available(self) -> None:
        with (
            patch.object(SecretPortalStore, "is_available", return_value=True),
        ):
            mgr = CredentialManager()
        assert mgr.active_backend == CredentialBackend.SECRET_PORTAL
        assert mgr.fallback_message is None

    def test_falls_back_to_encrypted_file(self) -> None:
        with (
            patch.object(SecretPortalStore, "is_available", return_value=False),
            patch.object(EncryptedFileStore, "is_available", return_value=True),
        ):
            mgr = CredentialManager()
        assert mgr.active_backend == CredentialBackend.ENCRYPTED_FILE
        assert mgr.fallback_message is not None
        assert "falling back" in mgr.fallback_message

    def test_raises_when_both_unavailable(self) -> None:
        with (
            patch.object(SecretPortalStore, "is_available", return_value=False),
            patch.object(EncryptedFileStore, "is_available", return_value=False),
        ):
            with pytest.raises(AuthError, match="No secure credential storage"):
                CredentialManager()

    def test_token_never_in_error_message(self) -> None:
        """Token value must never appear in exception messages."""
        token = "super-secret-token-value-12345"
        with (
            patch.object(SecretPortalStore, "is_available", return_value=True),
            patch.object(SecretPortalStore, "store_token", side_effect=AuthError("Failed to store credential")),
        ):
            mgr = CredentialManager()
            with pytest.raises(AuthError) as exc_info:
                mgr.store_token(token)
            assert token not in str(exc_info.value)

    def test_delete_delegates_to_active_backend(self) -> None:
        with (
            patch.object(SecretPortalStore, "is_available", return_value=True),
            patch.object(SecretPortalStore, "delete_token") as mock_delete,
        ):
            mgr = CredentialManager()
            mgr.delete_token()
            mock_delete.assert_called_once()
