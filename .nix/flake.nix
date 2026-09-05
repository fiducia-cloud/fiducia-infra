{
  description = "Fiducia development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # Pin the organization-wide encrypted-env contract. Updating this revision
    # is a reviewed supply-chain change, not an implicit network-time upgrade.
    ores-sops.url = "github:ORESoftware/ores-sops/f152c11f76cc14b2af440b47c756b6c97c0aa36b";
    ores-sops.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { nixpkgs, ores-sops, ... }:
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

              # encrypted env files — env/enc/{dev,prod}.env.enc. The helper
              # owns env/dec creation, verification, hooks, and activation.
              ores-sops.packages.${system}.default
              python3 # .just/dotenv.py — the shared dotenv parser
            ];

            # Never duplicate env/dec mkdir/chmod logic in a consumer. The
            # pinned helper performs symlink-safe creation and mode checks,
            # installs its managed hooks, and refreshes only an already-selected
            # environment. It does not auto-select or auto-decrypt a default.
            shellHook = ores-sops.lib.shellHook + ''
              echo "Fiducia dev shell (${system})"
            '';
          };
        });
    };
}
