"""Shared fixtures for UI tests."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add source to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))


@pytest.fixture()
def mock_gi():
    """Mock GI repository modules for tests that don't need real GTK."""
    gi_mock = MagicMock()

    with (
        patch.dict("sys.modules", {
            "gi": gi_mock,
            "gi.repository": gi_mock.repository,
            "gi.repository.Gio": gi_mock.repository.Gio,
            "gi.repository.GLib": gi_mock.repository.GLib,
            "gi.repository.Gtk": gi_mock.repository.Gtk,
            "gi.repository.Adw": gi_mock.repository.Adw,
        }),
    ):
        yield gi_mock
