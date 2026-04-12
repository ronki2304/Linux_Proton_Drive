project(
  'protondrive',
  version: '0.1.0',
  meson_version: '>= 0.62.0',
)

app_id = 'io.github.ronki2304.ProtonDriveLinuxClient'

python = import('python')
py_installation = python.find_installation('python3')
gnome = import('gnome')

# --- Blueprint compilation ---
blueprint_compiler = find_program('blueprint-compiler')

blueprints_window = custom_target(
  'blueprint-window',
  input: files('data/ui/window.blp'),
  output: 'window.ui',
  command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
)

blueprints_pre_auth = custom_target(
  'blueprint-pre-auth',
  input: files('data/ui/pre-auth.blp'),
  output: 'pre-auth.ui',
  command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
)

blueprints_auth_window = custom_target(
  'blueprint-auth-window',
  input: files('data/ui/auth-window.blp'),
  output: 'auth-window.ui',
  command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
)

blueprints_account_header_bar = custom_target(
  'blueprint-account-header-bar',
  input: files('data/ui/account-header-bar.blp'),
  output: 'account-header-bar.ui',
  command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
)

blueprints_settings = custom_target(
  'blueprint-settings',
  input: files('data/ui/settings.blp'),
  output: 'settings.ui',
  command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
)

blueprints_remote_folder_picker = custom_target(
  'blueprint-remote-folder-picker',
  input: files('data/ui/remote-folder-picker.blp'),
  output: 'remote-folder-picker.ui',
  command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
)

blueprints_setup_wizard = custom_target(
  'blueprint-setup-wizard',
  input: files('data/ui/setup-wizard.blp'),
  output: 'setup-wizard.ui',
  command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
)

blueprints_sync_pair_row = custom_target(
  'blueprint-sync-pair-row',
  input: files('data/ui/sync-pair-row.blp'),
  output: 'sync-pair-row.ui',
  command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
)

blueprints_status_footer_bar = custom_target(
  'blueprint-status-footer-bar',
  input: files('data/ui/status-footer-bar.blp'),
  output: 'status-footer-bar.ui',
  command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
)

blueprints_sync_progress_card = custom_target(
  'blueprint-sync-progress-card',
  input: files('data/ui/sync-progress-card.blp'),
  output: 'sync-progress-card.ui',
  command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
)

blueprints_pair_detail_panel = custom_target(
  'blueprint-pair-detail-panel',
  input: files('data/ui/pair-detail-panel.blp'),
  output: 'pair-detail-panel.ui',
  command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
)

blueprints_key_unlock_dialog = custom_target(
  'blueprint-key-unlock-dialog',
  input: files('data/ui/key-unlock-dialog.blp'),
  output: 'key-unlock-dialog.ui',
  command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
)

# --- GResource bundle ---
resource_conf = configuration_data()
gresource = gnome.compile_resources(
  'protondrive-resources',
  'data/protondrive.gresource.xml',
  dependencies: [blueprints_window, blueprints_pre_auth, blueprints_auth_window, blueprints_account_header_bar, blueprints_settings, blueprints_remote_folder_picker, blueprints_setup_wizard, blueprints_sync_pair_row, blueprints_status_footer_bar, blueprints_sync_progress_card, blueprints_pair_detail_panel, blueprints_key_unlock_dialog],
  gresource_bundle: true,
  source_dir: [meson.current_build_dir(), 'data'],
  install: true,
  install_dir: py_installation.get_install_dir() / 'protondrive',
)

# --- GSettings schema ---
install_data(
  'data' / app_id + '.gschema.xml',
  install_dir: get_option('datadir') / 'glib-2.0' / 'schemas',
)
gnome.compile_schemas(
  depend_files: files('data' / app_id + '.gschema.xml'),
)

# --- Python sources ---
python_sources = [
  'src/protondrive/__init__.py',
  'src/protondrive/__main__.py',
  'src/protondrive/main.py',
  'src/protondrive/window.py',
  'src/protondrive/errors.py',
  'src/protondrive/engine.py',
  'src/protondrive/credential_store.py',
  'src/protondrive/auth.py',
  'src/protondrive/pre_auth.py',
  'src/protondrive/auth_window.py',
]

python_widget_sources = [
  'src/protondrive/widgets/__init__.py',
  'src/protondrive/widgets/account_header_bar.py',
  'src/protondrive/widgets/settings.py',
  'src/protondrive/widgets/remote_folder_picker.py',
  'src/protondrive/widgets/setup_wizard.py',
  'src/protondrive/widgets/sync_pair_row.py',
  'src/protondrive/widgets/status_footer_bar.py',
  'src/protondrive/widgets/sync_progress_card.py',
  'src/protondrive/widgets/pair_detail_panel.py',
  'src/protondrive/widgets/key_unlock_dialog.py',
]

install_data(
  python_sources,
  install_dir: py_installation.get_install_dir() / 'protondrive',
)

install_data(
  python_widget_sources,
  install_dir: py_installation.get_install_dir() / 'protondrive' / 'widgets',
)

# --- Launcher script ---
configure_file(
  input: 'data/protondrive.in',
  output: 'protondrive',
  configuration: {'PYTHON': py_installation.full_path()},
  install: true,
  install_dir: get_option('bindir'),
  install_mode: 'rwxr-xr-x',
)

# --- Desktop file ---
install_data(
  'data' / app_id + '.desktop',
  install_dir: get_option('datadir') / 'applications',
)

# --- AppStream metainfo ---
install_data(
  'data' / app_id + '.metainfo.xml',
  install_dir: get_option('datadir') / 'metainfo',
)

# --- Icons ---
install_data(
  'data/icons' / app_id + '.svg',
  install_dir: get_option('datadir') / 'icons' / 'hicolor' / 'scalable' / 'apps',
)
install_data(
  'data/icons' / app_id + '-symbolic.svg',
  install_dir: get_option('datadir') / 'icons' / 'hicolor' / 'symbolic' / 'apps',
)
