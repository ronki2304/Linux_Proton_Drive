"""Tests for Story 2.0 AC7 — auth completion failure handling.

Verifies that ``Application.on_auth_completed`` aborts the auth transition
when token storage fails, and that ``MainWindow._on_auth_completed`` does
not call ``show_main()`` when the application reports failure.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

# GI mocks installed by ui/tests/conftest.py at import time.
from protondrive.errors import AuthError
from protondrive.main import Application
from protondrive.window import MainWindow


def _make_app() -> Application:
    """Build an Application without invoking GTK constructors."""
    app = object.__new__(Application)
    app._settings = MagicMock()
    app._engine = MagicMock()
    app._credential_manager = MagicMock()
    app._window = MagicMock()
    app._token_validation_timer_id = None
    return app


def _make_window() -> MainWindow:
    """Build a MainWindow without invoking GTK constructors."""
    win = object.__new__(MainWindow)
    win._pre_auth_screen = None
    win._auth_window = MagicMock()
    win._account_header_bar = None
    win._settings_page = None
    win._session_data = None
    return win


class TestApplicationOnAuthCompleted:
    """AC7 — token-storage failure must abort the auth transition."""

    def test_success_returns_true_and_sets_wizard_flag(self) -> None:
        app = _make_app()
        result = app.on_auth_completed("good-token")

        assert result is True
        app._credential_manager.store_token.assert_called_once_with("good-token")
        app._settings.set_boolean.assert_called_with("wizard-auth-complete", True)
        app._engine.send_token_refresh.assert_called_once_with("good-token")

    def test_store_token_failure_returns_false(self) -> None:
        app = _make_app()
        app._credential_manager.store_token.side_effect = AuthError(
            "Failed to store credential in keyring"
        )

        result = app.on_auth_completed("token-x")

        assert result is False

    def test_store_token_failure_does_not_set_wizard_flag(self) -> None:
        app = _make_app()
        app._credential_manager.store_token.side_effect = AuthError("nope")

        app.on_auth_completed("token-x")

        app._settings.set_boolean.assert_not_called()

    def test_store_token_failure_does_not_send_token_refresh(self) -> None:
        app = _make_app()
        app._credential_manager.store_token.side_effect = AuthError("nope")

        app.on_auth_completed("token-x")

        app._engine.send_token_refresh.assert_not_called()

    def test_no_credential_manager_still_succeeds(self) -> None:
        """If credential manager is unavailable, the flow still proceeds."""
        app = _make_app()
        app._credential_manager = None

        result = app.on_auth_completed("token-x")

        assert result is True
        app._settings.set_boolean.assert_called_with("wizard-auth-complete", True)
        app._engine.send_token_refresh.assert_called_once_with("token-x")


class TestWindowOnAuthCompleted:
    """AC7 — MainWindow must not transition on application failure."""

    def test_success_calls_show_main(self) -> None:
        win = _make_window()
        mock_app = MagicMock()
        mock_app.on_auth_completed.return_value = True
        win.get_application = MagicMock(return_value=mock_app)
        win.show_main = MagicMock()

        win._on_auth_completed(MagicMock(), "token")

        win.show_main.assert_called_once()

    def test_failure_does_not_call_show_main(self) -> None:
        win = _make_window()
        mock_app = MagicMock()
        mock_app.on_auth_completed.return_value = False
        win.get_application = MagicMock(return_value=mock_app)
        win.show_main = MagicMock()

        win._on_auth_completed(MagicMock(), "token")

        win.show_main.assert_not_called()

    def test_failure_shows_credential_error_on_auth_window(self) -> None:
        win = _make_window()
        mock_app = MagicMock()
        mock_app.on_auth_completed.return_value = False
        win.get_application = MagicMock(return_value=mock_app)
        win.show_main = MagicMock()

        win._on_auth_completed(MagicMock(), "token")

        win._auth_window.show_credential_error.assert_called_once()

    def test_no_application_is_safe_noop(self) -> None:
        win = _make_window()
        win.get_application = MagicMock(return_value=None)
        win.show_main = MagicMock()

        # Should not raise.
        win._on_auth_completed(MagicMock(), "token")

        win.show_main.assert_not_called()
