"""Tests for Application watcher status reset on token_expired and logout.

AC2: _on_token_expired and logout both reset _watcher_status to "unknown".

GI mocks are installed by ui/tests/conftest.py before any test module is
imported, so GLib.source_remove is already a MagicMock — no per-test patching
of sys.modules is required.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

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
    app._pending_reauth_dialog = None
    app._pending_crash_recovery = False
    app._last_token_expired_queued_count = 0
    app._had_browser_session = False
    app.show_reauth_dialog = MagicMock()
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


class TestConflictDetectedHandler:
    """Story 4-4 — _on_conflict_detected forwards payload to window."""

    def test_forwards_payload_to_window(self) -> None:
        app = _make_app()
        app._send_conflict_notification = MagicMock()
        payload = {"pair_id": "p1", "conflict_copy_path": "/tmp/notes.md.conflict-2026-04-17"}
        app._on_conflict_detected({"payload": payload})
        app._window.on_conflict_detected.assert_called_once_with(payload)

    def test_no_window_is_noop(self) -> None:
        app = _make_app()
        app._window = None
        app._send_conflict_notification = MagicMock()
        app._on_conflict_detected({"payload": {"pair_id": "p1", "conflict_copy_path": "/tmp/x"}})
        # must not raise

    def test_non_dict_payload_is_ignored(self) -> None:
        app = _make_app()
        app._on_conflict_detected({"payload": None})
        app._window.on_conflict_detected.assert_not_called()

    def test_handler_registered_in_do_startup(self) -> None:
        import protondrive.main as main_module
        import inspect

        source = inspect.getsource(main_module.Application.do_startup)
        assert '"conflict_detected"' in source
        assert "_on_conflict_detected" in source


# ---------------------------------------------------------------------------
# Story 4-5 — _send_conflict_notification
# ---------------------------------------------------------------------------

class TestSendConflictNotification:
    """Story 4-5 AC1/3/4 — _send_conflict_notification behaviour."""

    def _make_app(self) -> Application:
        app = object.__new__(Application)
        app._window = None
        app.send_notification = MagicMock()
        return app

    def test_sends_notification_with_stable_id(self):
        app = self._make_app()
        app._get_pair_name_for_notification = MagicMock(return_value="Docs")
        app._send_conflict_notification({
            "pair_id": "p1",
            "local_path": "/home/user/Docs/notes.md",
        })
        call_args = app.send_notification.call_args
        assert call_args[0][0] == "conflict-p1"

    def test_notification_title_is_sync_conflict_detected(self):
        app = self._make_app()
        app._get_pair_name_for_notification = MagicMock(return_value="Docs")
        with patch("protondrive.main.Gio.Notification") as mock_notif_cls:
            mock_notif = MagicMock()
            mock_notif_cls.new.return_value = mock_notif
            app._send_conflict_notification({
                "pair_id": "p1",
                "local_path": "/home/user/Docs/notes.md",
            })
            mock_notif_cls.new.assert_called_once_with("Sync Conflict Detected")

    def test_body_includes_filename_and_pair_name(self):
        app = self._make_app()
        app._get_pair_name_for_notification = MagicMock(return_value="Docs")
        with patch("protondrive.main.Gio.Notification") as mock_notif_cls:
            mock_notif = MagicMock()
            mock_notif_cls.new.return_value = mock_notif
            app._send_conflict_notification({
                "pair_id": "p1",
                "local_path": "/home/user/Docs/notes.md",
            })
            mock_notif.set_body.assert_called_once_with("Conflict in Docs: notes.md")

    def test_body_fallback_when_no_local_path(self):
        app = self._make_app()
        app._get_pair_name_for_notification = MagicMock(return_value="Photos")
        with patch("protondrive.main.Gio.Notification") as mock_notif_cls:
            mock_notif = MagicMock()
            mock_notif_cls.new.return_value = mock_notif
            app._send_conflict_notification({"pair_id": "p1"})
            mock_notif.set_body.assert_called_once_with("Conflict in Photos")

    def test_returns_early_when_no_pair_id(self):
        app = self._make_app()
        app._send_conflict_notification({})
        app.send_notification.assert_not_called()

    def test_on_conflict_detected_calls_send_conflict_notification(self):
        app = self._make_app()
        app._window = None
        app._send_conflict_notification = MagicMock()
        app._on_conflict_detected({"payload": {"pair_id": "p1", "local_path": "/tmp/f.md"}})
        app._send_conflict_notification.assert_called_once_with(
            {"pair_id": "p1", "local_path": "/tmp/f.md"}
        )


# ---------------------------------------------------------------------------
# Story 4-5 — _on_show_conflict_pair
# ---------------------------------------------------------------------------

class TestOnShowConflictPair:
    """Story 4-5 AC2 — _on_show_conflict_pair presents window and selects pair."""

    def test_presents_window_and_selects_pair(self):
        app = _make_app()
        param = MagicMock()
        param.get_string.return_value = "p1"
        app._on_show_conflict_pair(MagicMock(), param)
        app._window.present.assert_called_once()
        app._window.select_pair.assert_called_once_with("p1")

    def test_calls_activate_when_window_is_none(self):
        app = _make_app()
        app._window = None
        app.activate = MagicMock()
        # After activate(), _window remains None in unit context — no crash expected.
        param = MagicMock()
        param.get_string.return_value = "p1"
        app._on_show_conflict_pair(MagicMock(), param)
        app.activate.assert_called_once()


# ---------------------------------------------------------------------------
# Story 5-1 — _on_token_expired new behaviour (banner, no credential deletion)
# ---------------------------------------------------------------------------

class TestTokenExpiredCallsWarning:
    """_on_token_expired calls show_token_expired_warning, not show_pre_auth."""

    def test_calls_show_token_expired_warning(self) -> None:
        app = _make_app()
        app._on_token_expired({"queued_changes": 3})
        app._window.show_token_expired_warning.assert_called_once_with()

    def test_does_not_call_show_pre_auth(self) -> None:
        app = _make_app()
        app._on_token_expired({"queued_changes": 0})
        app._window.show_pre_auth.assert_not_called()

    def test_does_not_delete_credentials(self) -> None:
        app = _make_app()
        app._on_token_expired({"queued_changes": 0})
        app._credential_manager.delete_token.assert_not_called()
        app._credential_manager.delete_key_password.assert_not_called()

    def test_no_window_is_noop(self) -> None:
        app = _make_app()
        app._window = None
        app._on_token_expired({"queued_changes": 2})  # must not raise
        app.show_reauth_dialog.assert_not_called()

    def test_shows_banner_even_when_auth_browser_active(self) -> None:
        app = _make_app()
        app._window.is_auth_browser_active.return_value = True
        app._on_token_expired({"queued_changes": 1})
        app._window.show_token_expired_warning.assert_called_once_with()


# ---------------------------------------------------------------------------
# Story 5-2 — ReauthDialog lifecycle
# ---------------------------------------------------------------------------

class TestReauthDialogLifecycle:
    """show_reauth_dialog creates dialog; _on_reauth_response handles sign_in/dismiss."""

    def test_show_reauth_dialog_calls_set_queued_changes(self) -> None:
        """Dialog receives the queued-change count from last token_expired payload."""
        app = _make_app()
        app._last_token_expired_queued_count = 5
        mock_dialog = MagicMock()
        # ReauthDialog is a lazy import inside show_reauth_dialog() — patch sys.modules.
        import sys
        import types
        fake_mod = types.ModuleType("protondrive.widgets.reauth_dialog")
        fake_mod.ReauthDialog = MagicMock(return_value=mock_dialog)
        # Use the real show_reauth_dialog, not the mock set by _make_app
        from protondrive.main import Application
        with patch.dict(sys.modules, {"protondrive.widgets.reauth_dialog": fake_mod}):
            Application.show_reauth_dialog(app)
        mock_dialog.set_queued_changes.assert_called_once_with(5)

    def test_show_reauth_dialog_is_idempotent(self) -> None:
        """Calling show_reauth_dialog twice does not create a second dialog."""
        app = _make_app()
        existing = MagicMock()
        app._pending_reauth_dialog = existing
        from protondrive.main import Application
        Application.show_reauth_dialog(app)  # must be a no-op
        # pending_reauth_dialog is still the original (no new dialog created)
        assert app._pending_reauth_dialog is existing

    def test_on_token_expired_calls_show_reauth_dialog(self) -> None:
        """_on_token_expired calls show_reauth_dialog (Story 5-2 addition)."""
        app = _make_app()
        app._on_token_expired({"queued_changes": 3})
        app.show_reauth_dialog.assert_called_once_with()

    def test_on_token_expired_caches_queued_count(self) -> None:
        """_on_token_expired stores queued_changes for later dialog use."""
        app = _make_app()
        app._on_token_expired({"queued_changes": 7})
        assert app._last_token_expired_queued_count == 7

    def test_on_token_expired_zero_queued_fallback(self) -> None:
        """Missing queued_changes key defaults to 0."""
        app = _make_app()
        app._on_token_expired({})
        assert app._last_token_expired_queued_count == 0

    def test_sign_in_response_calls_start_auth_flow(self) -> None:
        """'sign_in' response invokes start_auth_flow (opens auth browser)."""
        app = _make_app()
        app.start_auth_flow = MagicMock()
        app._pending_reauth_dialog = MagicMock()
        app._on_reauth_response(MagicMock(), "sign_in")
        app.start_auth_flow.assert_called_once_with()
        assert app._pending_reauth_dialog is None

    def test_dismiss_response_does_not_start_auth_flow(self) -> None:
        """'dismiss' response clears dialog ref but does NOT start auth."""
        app = _make_app()
        app.start_auth_flow = MagicMock()
        app._pending_reauth_dialog = MagicMock()
        app._on_reauth_response(MagicMock(), "dismiss")
        app.start_auth_flow.assert_not_called()
        assert app._pending_reauth_dialog is None

    def test_session_ready_closes_pending_reauth_dialog(self) -> None:
        """_on_session_ready closes the reauth dialog if still open."""
        app = _make_app()
        mock_dialog = MagicMock()
        app._pending_reauth_dialog = mock_dialog
        app._has_configured_pairs = MagicMock(return_value=True)
        app._engine = MagicMock()
        app._cached_session_data = None
        app._on_session_ready({"display_name": "Test"})
        mock_dialog.close.assert_called_once_with()
        assert app._pending_reauth_dialog is None

    def test_session_ready_no_pending_dialog_is_safe(self) -> None:
        """_on_session_ready with no pending dialog does not raise."""
        app = _make_app()
        assert app._pending_reauth_dialog is None
        app._has_configured_pairs = MagicMock(return_value=True)
        app._engine = MagicMock()
        app._cached_session_data = None
        app._on_session_ready({"display_name": "Test"})  # must not raise


class TestCrashRecovery:
    """Crash recovery flag and session_ready injection (Story 5-4 AC4)."""

    def test_crash_recovery_complete_sets_pending_flag(self) -> None:
        """_on_crash_recovery_complete event sets _pending_crash_recovery."""
        app = _make_app()
        app._on_crash_recovery_complete({})
        assert app._pending_crash_recovery is True

    def test_session_ready_with_flag_calls_on_crash_recovery_complete(self) -> None:
        """_on_session_ready with _pending_crash_recovery=True calls window.on_crash_recovery_complete."""
        app = _make_app()
        app._pending_crash_recovery = True
        app._has_configured_pairs = MagicMock(return_value=True)
        app._engine = MagicMock()
        app._cached_session_data = None
        app._on_session_ready({"display_name": "Test"})
        app._window.on_crash_recovery_complete.assert_called_once()
        assert app._pending_crash_recovery is False  # consumed

    def test_session_ready_without_flag_does_not_call_on_crash_recovery_complete(self) -> None:
        """_on_session_ready without _pending_crash_recovery does not call window.on_crash_recovery_complete."""
        app = _make_app()
        app._pending_crash_recovery = False
        app._has_configured_pairs = MagicMock(return_value=True)
        app._engine = MagicMock()
        app._cached_session_data = None
        app._on_session_ready({"display_name": "Test"})
        app._window.on_crash_recovery_complete.assert_not_called()


class TestOnEngineError:
    """_on_engine_error() dispatches non-fatal pair errors to window (Story 5-5)."""

    def test_non_fatal_with_pair_id_dispatches_to_window(self) -> None:
        app = _make_app()
        app._on_engine_error("Free up space on /path", fatal=False, pair_id="p1")
        app._window.on_pair_error.assert_called_once_with("p1", "Free up space on /path")

    def test_non_fatal_without_pair_id_does_not_dispatch(self) -> None:
        app = _make_app()
        app._on_engine_error("some message", fatal=False, pair_id=None)
        app._window.on_pair_error.assert_not_called()

    def test_fatal_does_not_dispatch(self) -> None:
        app = _make_app()
        app._on_engine_error("fatal error", fatal=True, pair_id="p1")
        app._window.on_pair_error.assert_not_called()

    def test_non_fatal_with_window_none_does_not_crash(self) -> None:
        app = _make_app()
        app._window = None
        # Should not raise even though window is None
        app._on_engine_error("Free up space on /path", fatal=False, pair_id="p1")
