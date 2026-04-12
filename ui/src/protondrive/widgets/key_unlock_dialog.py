"""KeyUnlockDialog — GTK dialog for collecting Proton password to unlock sync keys."""

from __future__ import annotations

from gi.repository import Adw, GObject, Gtk


@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/key-unlock-dialog.ui")
class KeyUnlockDialog(Adw.Dialog):
    """Modal dialog prompting the user for their Proton password to decrypt keys.

    Emits ``unlock-confirmed(password: str)`` when the user submits a password,
    or ``unlock-cancelled`` when the user cancels (routes back to pre-auth).
    """

    __gtype_name__ = "ProtonDriveKeyUnlockDialog"

    __gsignals__ = {
        "unlock-confirmed": (GObject.SignalFlags.RUN_FIRST, None, (str,)),
        "unlock-cancelled": (GObject.SignalFlags.RUN_FIRST, None, ()),
    }

    password_entry: Gtk.PasswordEntry = Gtk.Template.Child()
    unlock_button: Gtk.Button = Gtk.Template.Child()
    cancel_button: Gtk.Button = Gtk.Template.Child()
    error_label: Gtk.Label = Gtk.Template.Child()

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self.unlock_button.connect("clicked", self._on_unlock_clicked)
        self.cancel_button.connect("clicked", self._on_cancel_clicked)
        self.password_entry.connect("activate", self._on_entry_activate)

    # ---- Public API ----

    def show_error(self, message: str) -> None:
        """Display an inline error and clear the password field."""
        self.error_label.set_label(message)
        self.error_label.set_visible(True)
        self.password_entry.set_text("")

    # ---- Signal handlers ----

    def _on_unlock_clicked(self, _button: Gtk.Button | None) -> None:
        password = self.password_entry.get_text()
        if not password:
            return
        self.error_label.set_visible(False)
        self.emit("unlock-confirmed", password)

    def _on_cancel_clicked(self, _button: Gtk.Button) -> None:
        self.emit("unlock-cancelled")

    def _on_entry_activate(self, _entry: Gtk.PasswordEntry) -> None:
        self._on_unlock_clicked(None)
