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

# --- GResource bundle ---
resource_conf = configuration_data()
gresource = gnome.compile_resources(
  'protondrive-resources',
  'data/protondrive.gresource.xml',
  dependencies: [blueprints_window, blueprints_pre_auth, blueprints_auth_window, blueprints_account_header_bar, blueprints_settings],
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
  'src/protondrive/main.py',
  'src/protondrive/window.py',
  'src/protondrive/engine.py',
  'src/protondrive/credential_store.py',
  'src/protondrive/auth.py',
  'src/protondrive/pre_auth.py',
  'src/protondrive/auth_window.py',
  'src/protondrive/widgets/__init__.py',
  'src/protondrive/widgets/account_header_bar.py',
  'src/protondrive/widgets/settings.py',
]

install_data(
  python_sources,
  install_dir: py_installation.get_install_dir() / 'protondrive',
)

# --- Desktop file ---
install_data(
  '../flatpak' / app_id + '.desktop',
  install_dir: get_option('datadir') / 'applications',
)

# --- AppStream metainfo ---
install_data(
  '../flatpak' / app_id + '.metainfo.xml',
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
