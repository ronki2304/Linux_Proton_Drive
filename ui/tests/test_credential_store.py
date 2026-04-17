"""Tests for credential storage backends and manager."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# GI mocks installed by ui/tests/conftest.py at import time. Read the shared
# Secret/GLib mocks for assertion access — do not reassign sys.modules entries.
_secret_mock = sys.modules["gi.repository.Secret"]
_glib_mock = sys.modules["gi.repository.GLib"]

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
        # NOTE: do NOT reassign ``_glib_mock.Error`` here. conftest.py
        # installs a stable real exception class at import time, and
        # reassigning it per test creates a new class identity that breaks
        # ``except GLib.Error`` references captured by other test modules.
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

    def test_store_key_password_delegates_to_active_backend(self) -> None:
        with (
            patch.object(SecretPortalStore, "is_available", return_value=True),
            patch.object(SecretPortalStore, "store_key_password") as mock_store,
        ):
            mgr = CredentialManager()
            mgr.store_key_password("$2y$10$fakehash")
            mock_store.assert_called_once_with("$2y$10$fakehash")

    def test_retrieve_key_password_delegates_to_active_backend(self) -> None:
        with (
            patch.object(SecretPortalStore, "is_available", return_value=True),
            patch.object(SecretPortalStore, "retrieve_key_password", return_value="$2y$10$stored"),
        ):
            mgr = CredentialManager()
            result = mgr.retrieve_key_password()
            assert result == "$2y$10$stored"

    def test_delete_key_password_delegates_to_active_backend(self) -> None:
        with (
            patch.object(SecretPortalStore, "is_available", return_value=True),
            patch.object(SecretPortalStore, "delete_key_password") as mock_delete,
        ):
            mgr = CredentialManager()
            mgr.delete_key_password()
            mock_delete.assert_called_once()

    def test_retrieve_key_password_returns_none_when_absent(self) -> None:
        with (
            patch.object(SecretPortalStore, "is_available", return_value=True),
            patch.object(SecretPortalStore, "retrieve_key_password", return_value=None),
        ):
            mgr = CredentialManager()
            result = mgr.retrieve_key_password()
            assert result is None

    def test_key_password_never_in_error_message(self) -> None:
        """Raw keyPassword must never appear in exception messages."""
        key_pw = "bcrypt-output-secret-$2y$10$abcdefghijklmnopqrstuuABCDEFGHIJKL"
        with (
            patch.object(SecretPortalStore, "is_available", return_value=True),
            patch.object(
                SecretPortalStore,
                "store_key_password",
                side_effect=AuthError("Failed to store key password"),
            ),
        ):
            mgr = CredentialManager()
            with pytest.raises(AuthError) as exc_info:
                mgr.store_key_password(key_pw)
            assert key_pw not in str(exc_info.value)


class TestSecretPortalStoreKeyPassword:
    """Test libsecret backend key password methods."""

    def setup_method(self) -> None:
        _secret_mock.reset_mock(side_effect=True)
        _glib_mock.reset_mock(side_effect=True)
        SecretPortalStore._schema = None

    def test_store_key_password(self) -> None:
        store = SecretPortalStore()
        store.store_key_password("$2y$10$fakehash")
        _secret_mock.password_store_sync.assert_called_once()

    def test_retrieve_key_password(self) -> None:
        store = SecretPortalStore()
        _secret_mock.password_lookup_sync.return_value = "$2y$10$stored"
        result = store.retrieve_key_password()
        assert result == "$2y$10$stored"

    def test_delete_key_password(self) -> None:
        store = SecretPortalStore()
        store.delete_key_password()
        _secret_mock.password_clear_sync.assert_called_once()

    def test_store_uses_different_attributes_from_token(self) -> None:
        """Key password must be stored under a different label than the token."""
        store = SecretPortalStore()
        store.store_key_password("$2y$10$kp")
        call_args = _secret_mock.password_store_sync.call_args
        # The attributes dict (second positional arg) must differ from the token attributes.
        attrs = call_args[0][1]
        assert attrs.get("type") == "key-password", "key-password must use distinct type attribute"


class TestEncryptedFileStoreKeyPassword:
    """Test encrypted file fallback backend key password methods."""

    def test_key_password_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            store = EncryptedFileStore()
            store._dir = Path(tmpdir)
            store._token_path = Path(tmpdir) / "session.enc"
            store._salt_path = Path(tmpdir) / "salt.bin"
            store._key_password_path = Path(tmpdir) / "key-password.enc"

            store.store_key_password("$2y$10$mykeypassword")
            result = store.retrieve_key_password()
        assert result == "$2y$10$mykeypassword"

    def test_retrieve_key_password_missing_returns_none(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            store = EncryptedFileStore()
            store._dir = Path(tmpdir)
            store._token_path = Path(tmpdir) / "session.enc"
            store._salt_path = Path(tmpdir) / "salt.bin"
            store._key_password_path = Path(tmpdir) / "key-password.enc"

            result = store.retrieve_key_password()
        assert result is None

    def test_delete_key_password_removes_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            store = EncryptedFileStore()
            store._dir = Path(tmpdir)
            store._token_path = Path(tmpdir) / "session.enc"
            store._salt_path = Path(tmpdir) / "salt.bin"
            store._key_password_path = Path(tmpdir) / "key-password.enc"

            store.store_key_password("$2y$10$todelete")
            assert store._key_password_path.exists()

            store.delete_key_password()
            assert not store._key_password_path.exists()

    def test_key_password_independent_of_token(self) -> None:
        """Token and keyPassword are stored independently — deleting one leaves the other."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = EncryptedFileStore()
            store._dir = Path(tmpdir)
            store._token_path = Path(tmpdir) / "session.enc"
            store._salt_path = Path(tmpdir) / "salt.bin"
            store._key_password_path = Path(tmpdir) / "key-password.enc"

            store.store_token("mytoken")
            store.store_key_password("$2y$10$kp")
            store.delete_key_password()

            assert store.retrieve_token() == "mytoken"
            assert store.retrieve_key_password() is None
