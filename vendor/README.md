# vendor — pinned third-party code

Git submodules vendored at a pinned revision.

- `flags-2-env/` — the [flags-2-env](https://github.com/ORESoftware/flags-2-env) tool,
  used to turn `.cli-flags.toml` into environment variables (see `scripts/with-flags2env.sh`)
  and audited by the `cli-flags` CI workflow. It is a submodule — do not edit its contents
  here; update the pin instead.
