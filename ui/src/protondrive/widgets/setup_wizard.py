"""SetupWizard — guided flow for creating the first sync pair.

Widget composition exception: this module imports RemoteFolderPicker because it
is structurally embedded in the wizard (not a coordination dependency). All
session data and pair completion callbacks still flow through window.py → main.py.
See Dev Notes in story 2-4 for rationale.
"""

from __future__ import annotations

from typing import Any, Callable

from gi.repository import Gio, GLib, Gtk

from protondrive.widgets.remote_folder_picker import RemoteFolderPicker


@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/setup-wizard.ui")
class SetupWizard(Gtk.Box):
    """Guided setup widget for local+remote folder selection and first pair creation."""

    __gtype_name__ = "ProtonDriveSetupWizard"

    header_bar: Gtk.Widget = Gtk.Template.Child()
    back_button: Gtk.Button = Gtk.Template.Child()
    wizard_stack: Gtk.Stack = Gtk.Template.Child()
    choose_local_button: Gtk.Button = Gtk.Template.Child()
    local_path_label: Gtk.Label = Gtk.Template.Child()
    remote_picker_box: Gtk.Box = Gtk.Template.Child()
    error_label: Gtk.Label = Gtk.Template.Child()
    spinner: Gtk.Spinner = Gtk.Template.Child()
    create_pair_button: Gtk.Button = Gtk.Template.Child()
    sync_summary_label: Gtk.Label = Gtk.Template.Child()
    done_button: Gtk.Button = Gtk.Template.Child()

    def __init__(
        self,
        engine_client: Any,
        on_pair_created: Callable[[str], None],
        on_back: Callable[[], None],
        **kwargs: object,
    ) -> None:
        super().__init__(**kwargs)
        self._engine_client = engine_client
        self._on_pair_created_cb = on_pair_created
        self._on_back_cb = on_back
        self._local_path: str | None = None
        self._remote_picker: RemoteFolderPicker | None = None
        self._pair_id: str | None = None

        self.back_button.connect("clicked", self._on_back_clicked)
        self.choose_local_button.connect("clicked", self._on_choose_local_clicked)
        self.create_pair_button.connect("clicked", self._on_create_pair_clicked)
        self.done_button.connect("clicked", self._on_done_clicked)

        self._rebuild_remote_picker()

    # ---- Signal handlers ----

    def _on_back_clicked(self, _button: Gtk.Button) -> None:
        self._on_back_cb()

    def _on_choose_local_clicked(self, _button: Gtk.Button) -> None:
        dialog = Gtk.FileDialog()
        dialog.set_title("Choose local folder to sync")
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
        self.local_path_label.set_text(self._local_path or "No folder selected")
        self._rebuild_remote_picker()
        self._update_create_button()

    def _on_create_pair_clicked(self, _button: Gtk.Button) -> None:
        self.create_pair_button.set_sensitive(False)
        self.create_pair_button.set_label("Creating…")
        self.error_label.set_visible(False)
        self.back_button.set_visible(False)
        self.spinner.set_visible(True)
        self.spinner.start()
        local = self._local_path or ""
        remote = self._get_remote_path()
        self._engine_client.send_command_with_response(
            {"type": "add_pair", "payload": {"local_path": local, "remote_path": remote}},
            self._on_pair_created,
        )

    def _on_pair_created(self, payload: dict[str, Any]) -> None:
        self.spinner.stop()
        self.spinner.set_visible(False)
        if "pair_id" in payload:
            self._pair_id = payload["pair_id"]
            self.sync_summary_label.set_text(
                f"{self._local_path} → {self._get_remote_path()}"
            )
            self.wizard_stack.set_visible_child_name("syncing_confirmation")
        else:
            error_msg = payload.get("error", "unknown_error")
            self.error_label.set_text(f"Failed to create sync pair: {error_msg}")
            self.error_label.set_visible(True)
            self.back_button.set_visible(True)
            self.create_pair_button.set_sensitive(True)
            self.create_pair_button.set_label("Create Pair")

    def _on_done_clicked(self, _button: Gtk.Button) -> None:
        if self._pair_id is not None:
            self._on_pair_created_cb(self._pair_id)

    # ---- Internal helpers ----

    def _rebuild_remote_picker(self) -> None:
        # GTK child removal pattern — do NOT use walrus operator
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

    def _update_create_button(self) -> None:
        sensitive = (
            self._local_path is not None
            and len(self._get_remote_path().strip("/")) > 0
        )
        self.create_pair_button.set_sensitive(sensitive)
