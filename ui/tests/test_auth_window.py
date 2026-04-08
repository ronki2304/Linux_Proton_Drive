"""Tests for embedded WebKitGTK auth browser."""

from __future__ import annotations

import inspect
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))


def _setup_mocks():
    """Set up GI mocks and import auth_window module."""
    gi_mock = MagicMock()
    gobject_mock = MagicMock()
    gtk_mock = MagicMock()
    adw_mock = MagicMock()
    webkit_mock = MagicMock()
    glib_mock = MagicMock()
    auth_mock = MagicMock()

    def template_decorator(**kwargs):
        def wrapper(cls):
            return cls
        return wrapper

    gtk_mock.Template = template_decorator
    gtk_mock.Template.Child = MagicMock(return_value=MagicMock())
    gtk_mock.Label = MagicMock
    gtk_mock.Box = MagicMock

    class FakeBin:
        def __init__(self, **kwargs):
            pass
        def emit(self, signal_name, *args):
            pass

    adw_mock.Bin = FakeBin
    adw_mock.Banner = MagicMock

    webkit_mock.WebView = MagicMock
    webkit_mock.LoadEvent = MagicMock()
    webkit_mock.LoadEvent.COMMITTED = "COMMITTED"
    webkit_mock.LoadEvent.FINISHED = "FINISHED"
    webkit_mock.LoadEvent.STARTED = "STARTED"

    modules = {
        "gi": gi_mock,
        "gi.repository": MagicMock(
            Adw=adw_mock, Gtk=gtk_mock, GObject=gobject_mock,
            WebKit=webkit_mock, GLib=glib_mock,
        ),
        "gi.repository.Adw": adw_mock,
        "gi.repository.Gtk": gtk_mock,
        "gi.repository.GObject": gobject_mock,
        "gi.repository.WebKit": webkit_mock,
        "gi.repository.GLib": glib_mock,
        "protondrive.auth": auth_mock,
    }

    # Clean any previous imports of the module under test (not this test file)
    for mod in list(sys.modules):
        if mod == "protondrive.auth_window":
            del sys.modules[mod]

    saved = {}
    for key, val in modules.items():
        saved[key] = sys.modules.get(key)
        sys.modules[key] = val

    import protondrive.auth_window as mod
    mod.WebKit = webkit_mock
    mod.AuthCallbackServer = auth_mock.AuthCallbackServer

    return mod, webkit_mock, auth_mock


_mod, _webkit, _auth = _setup_mocks()


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
