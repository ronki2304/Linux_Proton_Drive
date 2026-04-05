# Nix outputs module — imported by the root flake.nix as a plain Nix file.
# Not a standalone flake; the inputs block below is never evaluated by Nix's
# flake machinery. Inputs are passed in by the root flake.nix.
{ nixpkgs, flake-utils, ... }:
  flake-utils.lib.eachSystem [ "x86_64-linux" ] (system:
    let
      pkgs = nixpkgs.legacyPackages.${system};
      version = "0.1.0";

      src = pkgs.fetchFromGitHub {
        owner = "ronki2304";
        repo = "ProtonDrive-LinuxClient";
        rev = "v${version}";
        # Update with: nix-prefetch-url --unpack <tarball-url>
        sha256 = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      };

      # Fixed-output derivation to fetch npm dependencies.
      # Nix derivation builds run in a network-isolated sandbox; this FOD runs
      # bun install with network access and caches the result by content hash.
      #
      # To compute outputHash after changing package.json / bun.lock:
      #   1. Set outputHash = "" and run: nix build .#packages.x86_64-linux.protondrive
      #   2. The error output will contain: got: sha256-<hash>
      #   3. Set outputHash to that value.
      nodeModules = pkgs.stdenv.mkDerivation {
        name = "protondrive-node_modules-${version}";
        inherit src;
        nativeBuildInputs = [ pkgs.bun ];
        buildPhase = ''
          export HOME=$(mktemp -d)
          bun install --frozen-lockfile
        '';
        installPhase = ''
          cp -r node_modules $out
        '';
        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        # Update this hash whenever package.json or bun.lock changes.
        outputHash = "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
      };

      protondrive = pkgs.stdenv.mkDerivation {
        pname = "protondrive";
        inherit version src;

        nativeBuildInputs = [ pkgs.bun ];

        buildPhase = ''
          export HOME=$(mktemp -d)
          cp -r ${nodeModules} node_modules
          chmod -R u+w node_modules
          bun build --compile --target=bun-linux-x64 src/cli.ts --outfile protondrive
        '';

        installPhase = ''
          mkdir -p $out/bin
          install -Dm755 protondrive $out/bin/protondrive
        '';

        meta = with pkgs.lib; {
          description = "A command-line client for Proton Drive";
          homepage = "https://github.com/ronki2304/ProtonDrive-LinuxClient";
          license = licenses.mit;
          maintainers = [];
          platforms = [ "x86_64-linux" ];
        };
      };
    in
    {
      packages = {
        inherit protondrive;
        default = protondrive;
      };

      apps.default = {
        type = "app";
        program = "${protondrive}/bin/protondrive";
      };

      devShells.default = pkgs.mkShell {
        buildInputs = [
          pkgs.bun
          pkgs.nodejs
          pkgs.git
        ];

        shellHook = ''
          echo "ProtonDrive development environment"
          echo "Run 'bun install' to install dependencies."
          echo "Run 'bun test' to run tests."
        '';
      };
    }
  )
