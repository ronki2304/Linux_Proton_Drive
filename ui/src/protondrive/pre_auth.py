"""Pre-auth screen with credential comfort messaging."""

from __future__ import annotations

from typing import Callable

from gi.repository import Adw, GObject, Gtk


@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/pre-auth.ui")
class PreAuthScreen(Adw.Bin):
    """Native GTK4 screen shown before embedded auth browser."""

    __gtype_name__ = "ProtonDrivePreAuthScreen"

    __gsignals__ = {
        "sign-in-requested": (GObject.SignalFlags.RUN_FIRST, None, ()),
    }

    sign_in_button: Gtk.Button = Gtk.Template.Child()

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self.sign_in_button.connect("clicked", self._on_sign_in_clicked)

    def _on_sign_in_clicked(self, button: Gtk.Button) -> None:
        """Emit sign-in-requested signal for window.py to handle."""
        self.emit("sign-in-requested")
