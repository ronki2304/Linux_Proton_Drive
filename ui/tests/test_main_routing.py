"""Tests for Application._on_session_ready routing logic (Story 2-4)."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import yaml

# GI mocks installed by conftest.py before any import.
import protondrive.main as _main_mod


def _make_application() -> _main_mod.Application:
    """Build an Application bypassing Adw.Application.__init__."""
    app = object.__new__(_main_mod.Application)
    app._settings = None
    app._engine = MagicMock()
    app._credential_manager = None
    app._window = MagicMock()
    app._token_validation_timer_id = None
    app._cached_session_data = None
    return app


class TestOnSessionReadyRouting:

    def _make_app_with_config(
        self, pairs: list | None, *, corrupt: bool = False
    ) -> tuple[_main_mod.Application, str]:
        """Return (app, tmpdir) with XDG_CONFIG_HOME pointing at tmpdir.

        ``pairs`` = None means config file absent.
        ``pairs`` = [] means file exists but pairs list is empty.
        ``corrupt`` = True means the file contains invalid YAML.
        """
        tmpdir = tempfile.mkdtemp()
        app = _make_application()
        config_dir = Path(tmpdir) / "protondrive"

        if pairs is not None or corrupt:
            config_dir.mkdir(parents=True)
            config_path = config_dir / "config.yaml"
            if corrupt:
                config_path.write_text("{ invalid: [[[", encoding="utf-8")
            else:
                config_path.write_text(
                    yaml.dump({"pairs": pairs}), encoding="utf-8"
                )

        return app, tmpdir

    def _call_session_ready(
        self, app: _main_mod.Application, tmpdir: str
    ) -> None:
        payload = {
            "display_name": "Test User",
            "email": "test@proton.me",
        }
        orig = os.environ.get("XDG_CONFIG_HOME")
        try:
            os.environ["XDG_CONFIG_HOME"] = tmpdir
            # _cancel_validation_timeout calls GLib.source_remove if timer set
            app._token_validation_timer_id = None
            _main_mod.Application._on_session_ready(app, payload)
        finally:
            if orig is None:
                os.environ.pop("XDG_CONFIG_HOME", None)
            else:
                os.environ["XDG_CONFIG_HOME"] = orig
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_routes_to_wizard_when_config_absent(self) -> None:
        app, tmpdir = self._make_app_with_config(None)
        self._call_session_ready(app, tmpdir)
        app._window.show_setup_wizard.assert_called_once()
        app._window.show_main.assert_not_called()

    def test_routes_to_wizard_when_pairs_list_empty(self) -> None:
        app, tmpdir = self._make_app_with_config([])
        self._call_session_ready(app, tmpdir)
        app._window.show_setup_wizard.assert_called_once()
        app._window.show_main.assert_not_called()

    def test_routes_to_main_when_pair_exists(self) -> None:
        pair = {
            "pair_id": "abc-123",
            "local_path": "/home/user/Docs",
            "remote_path": "/Documents",
            "created_at": "2026-04-10T00:00:00.000Z",
        }
        app, tmpdir = self._make_app_with_config([pair])
        self._call_session_ready(app, tmpdir)
        app._window.show_main.assert_called_once()
        app._window.show_setup_wizard.assert_not_called()

    def test_yaml_parse_failure_routes_to_wizard_no_exception(self) -> None:
        app, tmpdir = self._make_app_with_config(None, corrupt=True)
        # Must not raise
        self._call_session_ready(app, tmpdir)
        app._window.show_setup_wizard.assert_called_once()
        app._window.show_main.assert_not_called()


class TestOnWizardComplete:

    def test_calls_show_main_and_on_session_ready(self) -> None:
        app = _make_application()
        app._cached_session_data = {"display_name": "Jeremy", "email": "j@proton.me"}

        _main_mod.Application._on_wizard_complete(app, "pair-xyz")

        app._window.show_main.assert_called_once()
        app._window.on_session_ready.assert_called_once_with(app._cached_session_data)

    def test_uses_empty_dict_when_no_cached_session_data(self) -> None:
        app = _make_application()
        app._cached_session_data = None

        _main_mod.Application._on_wizard_complete(app, "pair-xyz")

        app._window.on_session_ready.assert_called_once_with({})
