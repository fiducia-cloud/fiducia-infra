{
  description = "Fiducia development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = true; # terraform (BUSL license)
          };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              rustc
              cargo
              rustfmt
              clippy
              rust-analyzer

              git
              direnv
              just
              bacon

              nodejs
              pnpm

              pkg-config
              openssl

              # infra tooling — terraform/envs (hetzner+vultr+civo), the
              # kustomize overlays, and tools/clustermesh.sh
              terraform
              hcloud
              civo
              vultr-cli
              kubectl
              kustomize
              cilium-cli
              jq

              # encrypted env files — env/enc/*.env.enc, see env/README.md
              sops
              age
              python3 # .just/dotenv.py — the shared dotenv parser
            ];

            shellHook = ''
              # `env/dec/` is an ignored plaintext boundary. Entering a dev shell
              # must never create it with a second implementation: recipes that
              # intentionally write plaintext call `ores-sops ensure-dec`, which
              # owns the symlink, ownership, and permission checks. Read-only
              # work only rejects an already-dangerous filesystem shape.
              _repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
              for _rel in env env/enc env/dec; do
                if [ -L "$_repo_root/$_rel" ]; then
                  echo "refusing symlinked $_rel" >&2
                  return 1 2>/dev/null || exit 1
                fi
                if [ -e "$_repo_root/$_rel" ] && [ ! -d "$_repo_root/$_rel" ]; then
                  echo "refusing non-directory $_rel" >&2
                  return 1 2>/dev/null || exit 1
                fi
              done
              unset _rel _repo_root

              echo "Fiducia dev shell (${system})"

              # Point sops at this machine's age key. sops finds the platform
              # default on its own, but exporting it makes the path explicit in
              # error messages and keeps macOS/Linux checkouts interchangeable.
              if [ -z "''${SOPS_AGE_KEY_FILE:-}" ]; then
                for _k in "''${XDG_CONFIG_HOME:-$HOME/.config}/sops/age/keys.txt" \
                          "$HOME/Library/Application Support/sops/age/keys.txt"; do
                  if [ -f "$_k" ]; then export SOPS_AGE_KEY_FILE="$_k"; break; fi
                done
                unset _k
              fi
              if [ -z "''${SOPS_AGE_KEY_FILE:-}" ]; then
                echo "  no age key yet — run 'just env-keygen' to create one"
              fi
            '';
          };
        });
    };
}
