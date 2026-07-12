# scripts — helper scripts

- `with-flags2env.sh` — turns `.cli-flags.toml` flags into environment variables (via
  the flags-2-env submodule) and execs a command with them applied:
  `scripts/with-flags2env.sh [flags...] -- command [args...]`.
