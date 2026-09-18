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
            ];

            shellHook = ''
              echo "Fiducia dev shell (${system})"
            '';
          };
        });
    };
}
