# .nix — reproducible dev environment

The Nix flake that pins this repo's toolchain (Node, kubectl/kustomize, Terraform,
the flags-2-env build deps, etc.) so every contributor and CI get the same versions.

- `flake.nix` — the dev shell definition.
- `flake.lock` — pinned input revisions (generated; do not hand-edit).

Entered via `nix develop ./.nix` — the repo's `./shell` wrapper and `.envrc`
(direnv) both point here.
