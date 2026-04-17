"""Tests for Application watcher status reset on token_expired and logout.

AC2: _on_token_expired and logout both reset _watcher_status to "unknown".

GI mocks are installed by ui/tests/conftest.py before any test module is
imported, so GLib.source_remove is already a MagicMock — no per-test patching
of sys.modules is required.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from protondrive.main import Application


def _make_app() -> Application:
    """Return a minimal Application instance bypassing GTK/GLib initialisation.

    Uses object.__new__ to skip Application.__init__ and Adw.Application.__init__,
    then sets every attribute _on_token_expired and logout read or write.
    """
    app = object.__new__(Application)
    app._settings = MagicMock()
    app._engine = MagicMock()
    app._credential_manager = MagicMock()
    app._window = MagicMock()
    app._window.is_auth_browser_active.return_value = False
    app._token_validation_timer_id = None  # no active timer → GLib.source_remove not called
    app._cached_session_data = None
    app._watcher_status = "unknown"
    app._pending_key_unlock_dialog = None
    app._had_browser_session = False
    return app


class TestTokenExpiredResetsWatcherStatus:
    """_on_token_expired resets _watcher_status to 'unknown' regardless of prior value."""

    def test_resets_from_ready(self) -> None:
        app = _make_app()
        app._watcher_status = "ready"
        app._on_token_expired({"payload": {"code": "SESSION_EXPIRED"}})
        assert app._watcher_status == "unknown"

    def test_resets_from_initializing(self) -> None:
        app = _make_app()
        app._watcher_status = "initializing"
        app._on_token_expired({"payload": {"code": "SESSION_EXPIRED"}})
        assert app._watcher_status == "unknown"


class TestLogoutResetsWatcherStatus:
    """logout resets _watcher_status to 'unknown' regardless of prior value."""

    def test_resets_from_ready(self) -> None:
        app = _make_app()
        app._watcher_status = "ready"
        app.logout()
        assert app._watcher_status == "unknown"

    def test_resets_from_initializing(self) -> None:
        app = _make_app()
        app._watcher_status = "initializing"
        app.logout()
        assert app._watcher_status == "unknown"


class TestOfflineOnlineHandlers:
    """_on_offline and _on_online forward to window."""

    def test_on_offline_calls_window_on_offline(self) -> None:
        app = _make_app()
        app._on_offline({})
        app._window.on_offline.assert_called_once_with()

    def test_on_online_calls_window_on_online(self) -> None:
        app = _make_app()
        app._on_online({})
        app._window.on_online.assert_called_once_with()

    def test_on_offline_no_window_is_noop(self) -> None:
        app = _make_app()
        app._window = None
        app._on_offline({})  # must not raise

    def test_on_online_no_window_is_noop(self) -> None:
        app = _make_app()
        app._window = None
        app._on_online({})  # must not raise


class TestQueueReplayCompleteHandler:
    """Story 3-3 — _on_queue_replay_complete forwards payload to window."""

    def test_forwards_payload_to_window(self) -> None:
        app = _make_app()
        payload = {"synced": 3, "skipped_conflicts": 0}
        app._on_queue_replay_complete({"payload": payload})
        app._window.on_queue_replay_complete.assert_called_once_with(payload)

    def test_forwards_conflict_payload_to_window(self) -> None:
        app = _make_app()
        payload = {"synced": 1, "skipped_conflicts": 2}
        app._on_queue_replay_complete({"payload": payload})
        app._window.on_queue_replay_complete.assert_called_once_with(payload)

    def test_no_window_is_noop(self) -> None:
        app = _make_app()
        app._window = None
        app._on_queue_replay_complete({"payload": {"synced": 1, "skipped_conflicts": 0}})

    def test_non_dict_payload_is_ignored(self) -> None:
        app = _make_app()
        app._on_queue_replay_complete({"payload": None})
        app._window.on_queue_replay_complete.assert_not_called()

    def test_handler_registered_in_do_startup(self) -> None:
        """Verify the handler key is 'queue_replay_complete' in do_startup wiring.

        We can't invoke do_startup() (requires a real Adw.Application), but we can
        inspect the source to ensure the registration line exists for the right key.
        """
        import protondrive.main as main_module
        import inspect

        source = inspect.getsource(main_module.Application.do_startup)
        assert '"queue_replay_complete"' in source
        assert "_on_queue_replay_complete" in source


class TestRateLimitedHandler:
    """Story 3-4 — _on_rate_limited forwards payload to window."""

    def test_handler_registered_in_do_startup(self) -> None:
        import protondrive.main as main_module
        import inspect

        source = inspect.getsource(main_module.Application.do_startup)
        assert '"rate_limited"' in source
        assert "_on_rate_limited" in source

    def test_forwards_payload_to_window(self) -> None:
        app = _make_app()
        payload = {"resume_in_seconds": 10}
        app._on_rate_limited(payload)
        app._window.on_rate_limited.assert_called_once_with(payload)
