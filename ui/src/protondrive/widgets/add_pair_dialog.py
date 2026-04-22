"""AddPairDialog — floating dialog for adding subsequent sync pairs.

Widget composition exception: imports RemoteFolderPicker because it is
structurally embedded in the dialog (not a coordination dependency).
"""

from __future__ import annotations

from typing import Any

from gi.repository import Adw, Gio, GLib, GObject, Gtk

from protondrive.widgets.remote_folder_picker import RemoteFolderPicker


@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/add-pair-dialog.ui")
class AddPairDialog(Adw.Dialog):
    """Lightweight dialog for adding a subsequent sync pair without wizard chrome."""

    __gtype_name__ = "ProtonDriveAddPairDialog"

    __gsignals__ = {
        "pair-created": (GObject.SignalFlags.RUN_FIRST, None, (str,)),
    }

    choose_local_button: Gtk.Button = Gtk.Template.Child()
    local_path_label: Gtk.Label = Gtk.Template.Child()
    remote_picker_box: Gtk.Box = Gtk.Template.Child()
    error_label: Gtk.Label = Gtk.Template.Child()
    spinner: Gtk.Spinner = Gtk.Template.Child()
    cancel_button: Gtk.Button = Gtk.Template.Child()
    add_pair_button: Gtk.Button = Gtk.Template.Child()

    def __init__(self, engine_client: Any, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._engine_client = engine_client
        self._local_path: str | None = None
        self._remote_picker: RemoteFolderPicker | None = None

        self.choose_local_button.connect("clicked", self._on_choose_local_clicked)
        self.add_pair_button.connect("clicked", self._on_add_pair_clicked)
        self.cancel_button.connect("clicked", self._on_cancel_clicked)

    # ---- Signal handlers ----

    def _on_choose_local_clicked(self, _button: Gtk.Button) -> None:
        dialog = Gtk.FileDialog()
        dialog.select_folder(
            parent=self.get_root(),
            cancellable=None,
            callback=self._on_folder_chosen,
        )

    def _on_folder_chosen(self, dialog: Gtk.FileDialog, result: Gio.AsyncResult) -> None:
        try:
            gio_file = dialog.select_folder_finish(result)
        except GLib.Error:
            return
        if gio_file is None:
            return
        self._local_path = gio_file.get_path()
        self.local_path_label.set_label(self._local_path or "(no folder selected)")
        self._rebuild_remote_picker()
        self._update_add_button()

    def _on_add_pair_clicked(self, _button: Gtk.Button) -> None:
        self.add_pair_button.set_sensitive(False)
        self.spinner.set_visible(True)
        self.spinner.start()
        self.error_label.set_visible(False)
        self._engine_client.send_command_with_response(
            {
                "type": "add_pair",
                "payload": {
                    "local_path": self._local_path,
                    "remote_path": self._get_remote_path(),
                },
            },
            self._on_pair_created,
        )

    def _on_pair_created(self, payload: dict[str, Any]) -> None:
        self.spinner.stop()
        self.spinner.set_visible(False)
        if "pair_id" in payload:
            self.emit("pair-created", payload["pair_id"])
            self.close()
        else:
            self.error_label.set_label("Failed to add sync pair. Please try again.")
            self.error_label.set_visible(True)
            self.add_pair_button.set_sensitive(True)

    def _on_cancel_clicked(self, _button: Gtk.Button) -> None:
        self.close()

    # ---- Internal helpers ----

    def _rebuild_remote_picker(self) -> None:
        child = self.remote_picker_box.get_first_child()
        while child is not None:
            next_child = child.get_next_sibling()
            self.remote_picker_box.remove(child)
            child = next_child
        self._remote_picker = RemoteFolderPicker(
            engine_client=self._engine_client,
            local_folder_path=self._local_path,
        )
        self.remote_picker_box.append(self._remote_picker)

    def _get_remote_path(self) -> str:
        if self._remote_picker is None:
            return "/"
        return self._remote_picker.get_remote_path()

    def _update_add_button(self) -> None:
        self.add_pair_button.set_sensitive(
            self._local_path is not None
            and len(self._get_remote_path().strip("/")) > 0
        )
