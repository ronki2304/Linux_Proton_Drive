# Root flake.nix — thin entry point, delegates outputs to packaging/nix/flake.nix
#
# Usage:
#   nix build .#protondrive        # build the CLI binary
#   nix run .                      # run protondrive
#   nix develop                    # enter dev shell with bun, nodejs, git
#
# Home-manager integration:
#   inputs.protondrive.url = "github:ronki2304/ProtonDrive-LinuxClient/v1.0.0";
#   environment.systemPackages = [ inputs.protondrive.packages.${system}.default ];
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.flake-utils.url = "github:numtide/flake-utils";

  outputs = { nixpkgs, flake-utils, ... }:
    (import ./packaging/nix/flake.nix) { inherit nixpkgs flake-utils; };
}
