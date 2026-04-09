"""Tests for embedded WebKitGTK auth browser."""

from __future__ import annotations

import inspect
import sys
from unittest.mock import MagicMock, patch

import pytest

# GI mocks installed by ui/tests/conftest.py at import time.
import protondrive.auth_window as _mod

_webkit = sys.modules["gi.repository.WebKit"]


class TestAuthWindowMetadata:

    def test_gtype_name(self) -> None:
        assert _mod.AuthWindow.__gtype_name__ == "ProtonDriveAuthWindow"

    def test_auth_completed_signal_defined(self) -> None:
        assert "auth-completed" in _mod.AuthWindow.__gsignals__

    def test_signal_carries_token_string(self) -> None:
        sig_def = _mod.AuthWindow.__gsignals__["auth-completed"]
        assert str in sig_def[2]


class TestAuthFlowOrdering:

    def test_server_binds_before_webview_navigates(self) -> None:
        """Auth server socket must bind before WebView.load_uri is called."""
        call_order: list[str] = []

        mock_server = MagicMock()
        mock_server.get_port.return_value = 12345
        mock_server.start_async.side_effect = lambda *a: call_order.append("server_start")

        mock_webview = MagicMock()
        mock_webview.load_uri.side_effect = lambda u: call_order.append("webview_load")

        # Patch at the module level so start_auth() sees our mocks
        original_server_cls = _mod.AuthCallbackServer
        original_webview_cls = _mod.WebKit.WebView
        _mod.AuthCallbackServer = lambda: mock_server
        _mod.WebKit.WebView = lambda: mock_webview

        try:
            window = object.__new__(_mod.AuthWindow)
            window._auth_server = None
            window._webview = None
            window._auth_start_url = None
            window._completed = False
            window.url_label = MagicMock()
            window.webview_container = MagicMock()
            window.error_banner = MagicMock()

            window.start_auth()

            assert call_order == ["server_start", "webview_load"]
            assert "127.0.0.1:12345" in mock_webview.load_uri.call_args[0][0]
        finally:
            _mod.AuthCallbackServer = original_server_cls
            _mod.WebKit.WebView = original_webview_cls


def _make_window():
    window = object.__new__(_mod.AuthWindow)
    window._auth_server = MagicMock()
    window._webview = MagicMock()
    window._auth_start_url = "http://127.0.0.1:12345/auth-start"
    window._completed = False
    window.url_label = MagicMock()
    window.webview_container = MagicMock()
    window.error_banner = MagicMock()
    window.emit = MagicMock()
    return window


class TestWebViewCleanup:

    def test_try_close_called(self) -> None:
        w = _make_window()
        wv = w._webview
        w._on_token_received("tok")
        wv.try_close.assert_called_once()

    def test_webview_set_to_none(self) -> None:
        w = _make_window()
        w._on_token_received("tok")
        assert w._webview is None

    def test_auth_server_stopped(self) -> None:
        w = _make_window()
        srv = w._auth_server
        w._on_token_received("tok")
        srv.stop.assert_called_once()
        assert w._auth_server is None

    def test_auth_completed_emitted(self) -> None:
        w = _make_window()
        w._on_token_received("my-token")
        w.emit.assert_called_once_with("auth-completed", "my-token")

    def test_webview_removed_from_container(self) -> None:
        w = _make_window()
        wv = w._webview
        w._on_token_received("tok")
        w.webview_container.remove.assert_called_once_with(wv)


class TestURLLabel:

    def test_domain_shown_on_committed(self) -> None:
        w = _make_window()
        wv = MagicMock()
        wv.get_uri.return_value = "https://account.proton.me/login"
        w._on_load_changed(wv, _webkit.LoadEvent.COMMITTED)
        w.url_label.set_text.assert_called_with("account.proton.me")

    def test_localhost_shows_connecting(self) -> None:
        w = _make_window()
        wv = MagicMock()
        wv.get_uri.return_value = "http://127.0.0.1:54321/auth-start"
        w._on_load_changed(wv, _webkit.LoadEvent.COMMITTED)
        w.url_label.set_text.assert_called_with("Connecting...")


class TestErrorBanner:

    def test_shown_on_load_failed(self) -> None:
        w = _make_window()
        result = w._on_load_failed(MagicMock(), MagicMock(), "https://x", MagicMock())
        w.error_banner.set_revealed.assert_called_with(True)
        assert result is True

    def test_hidden_on_success(self) -> None:
        w = _make_window()
        w.error_banner.get_revealed.return_value = True
        wv = MagicMock()
        wv.get_uri.return_value = "https://account.proton.me"
        w._on_load_changed(wv, _webkit.LoadEvent.COMMITTED)
        w.error_banner.set_revealed.assert_called_with(False)

    def test_retry_reloads(self) -> None:
        w = _make_window()
        w._on_retry_clicked(MagicMock())
        w._webview.load_uri.assert_called_once_with("http://127.0.0.1:12345/auth-start")


class TestWebKitImport:

    def test_uses_webkit_6_not_webkit2(self) -> None:
        source = inspect.getsource(_mod)
        assert "WebKit2" not in source
        assert "'WebKit', '6.0'" in source or '"WebKit", "6.0"' in source

    def test_no_lambda_in_init(self) -> None:
        source = inspect.getsource(_mod.AuthWindow.__init__)
        assert "lambda" not in source


class TestStory20CredentialErrorFlow:
    """AC7 — credential storage failure surfaces an actionable banner."""

    def test_show_credential_error_reveals_banner(self) -> None:
        w = _make_window()
        w._completed = True  # _on_token_received already ran
        w.show_credential_error()
        w.error_banner.set_revealed.assert_called_with(True)

    def test_show_credential_error_sets_actionable_title(self) -> None:
        w = _make_window()
        w.show_credential_error()
        w.error_banner.set_title.assert_called_once()
        title = w.error_banner.set_title.call_args[0][0]
        assert "credentials" in title.lower()

    def test_show_credential_error_re_arms_completed_flag(self) -> None:
        w = _make_window()
        w._completed = True
        w.show_credential_error()
        assert w._completed is False

    def test_retry_after_credential_error_restarts_auth_flow(self) -> None:
        """When the WebView was torn down, retry must restart the whole flow."""
        w = _make_window()
        w._webview = None  # torn down by _on_token_received
        w._auth_start_url = None
        w._completed = False
        w.start_auth = MagicMock()
        w._on_retry_clicked(MagicMock())
        w.start_auth.assert_called_once()

    def test_retry_with_live_webview_reloads_uri(self) -> None:
        """Existing behaviour preserved when WebView is still alive."""
        w = _make_window()
        w._completed = False
        w._on_retry_clicked(MagicMock())
        w._webview.load_uri.assert_called_once_with(
            "http://127.0.0.1:12345/auth-start"
        )


class TestStory20WebviewSessionClearing:
    """AC8 — WebKit network session must be cleared before close."""

    def test_token_received_clears_website_data_before_try_close(self) -> None:
        w = _make_window()
        wv = w._webview
        # Build a fresh data_manager mock to assert against.
        data_manager = MagicMock()
        wv.get_network_session.return_value.get_website_data_manager.return_value = (
            data_manager
        )

        # Track relative call order via side_effects so we can assert that
        # data was cleared BEFORE the WebView was closed.
        call_order: list[str] = []
        data_manager.clear.side_effect = lambda *a, **k: call_order.append("clear")
        wv.try_close.side_effect = lambda: call_order.append("try_close")

        w._on_token_received("tok")

        data_manager.clear.assert_called_once()
        wv.try_close.assert_called_once()
        assert call_order == ["clear", "try_close"], (
            f"clear must be called BEFORE try_close, got {call_order}"
        )

    def test_cleanup_clears_website_data(self) -> None:
        w = _make_window()
        data_manager = MagicMock()
        w._webview.get_network_session.return_value.get_website_data_manager.return_value = (
            data_manager
        )

        w.cleanup()

        data_manager.clear.assert_called_once()

    def test_cleanup_and_token_received_use_same_helper(self) -> None:
        """DRY: both paths route through _teardown_webview."""
        import inspect

        token_src = inspect.getsource(_mod.AuthWindow._on_token_received)
        cleanup_src = inspect.getsource(_mod.AuthWindow.cleanup)
        assert "_teardown_webview" in token_src
        assert "_teardown_webview" in cleanup_src

    def test_clear_session_falls_back_to_webview_data_manager(self) -> None:
        """If get_network_session raises AttributeError, use the WebView API."""
        webview = MagicMock(spec=["get_website_data_manager", "try_close"])
        # spec= restricts attrs — get_network_session does NOT exist.
        data_manager = MagicMock()
        webview.get_website_data_manager.return_value = data_manager

        _mod.AuthWindow._clear_webview_session(webview)

        data_manager.clear.assert_called_once()

    def test_clear_session_swallows_glib_error_silently(self) -> None:
        """Failures during clear must not bubble up — teardown must always finish."""
        from gi.repository import GLib as _GLib

        webview = MagicMock()
        data_manager = MagicMock()
        data_manager.clear.side_effect = _GLib.Error("flush failed")
        webview.get_network_session.return_value.get_website_data_manager.return_value = (
            data_manager
        )

        # Should not raise.
        _mod.AuthWindow._clear_webview_session(webview)
