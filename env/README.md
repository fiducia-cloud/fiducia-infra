# Encrypted runtime configuration

Fiducia follows one repository convention for deploy-specific secrets:

```text
env/enc/dev.env.enc    # SOPS + age ciphertext; may be committed
env/enc/prod.env.enc   # SOPS + age ciphertext; may be committed
env/dec/dev.env        # ignored local plaintext, mode 0600
env/dec/prod.env       # ignored local plaintext, mode 0600
.env -> env/dec/<dev|prod>.env
```

There are exactly two tracked secret stores: `dev` and `prod`. Do not add
`local`, `staging`, `production`, per-person, or per-provider ciphertext files.
A deployment may bind different values through its platform secret manager, but
those values must implement the same documented variable-name contract.

`env/dec/` is a disposable runtime boundary. It is never represented by a
tracked placeholder and must be created only through `ores-sops ensure-dec`.
The helper rejects symlink/non-directory redirection and applies mode `0700`.

## Commands

Enter the pinned Nix shell first:

```sh
nix develop
```

Then use the canonical helper:

```sh
ores-sops verify        # keyless policy audit; safe for pull-request CI
ores-sops edit dev      # edit ciphertext through SOPS
ores-sops edit prod
ores-sops use dev       # decrypt atomically and activate the managed .env link
ores-sops use prod
ores-sops diff dev      # changed variable names only; never values
ores-sops status
ores-sops lock          # remove managed plaintext and the managed .env link
```

`just env-verify` is the repository alias for the keyless audit. Pull-request CI
has no age identity and must not decrypt a secret. Trusted release/runtime jobs
may separately prove decryptability through protected workload identity.

## Configuration ownership

The application contract owns variable **names**, types, required/optional
status, defaults, and precedence. The deployment owns values. Parse runtime
configuration once at process startup into an immutable typed value; reject
unknown flags and malformed or missing required values before serving traffic.
Do not call `std::env::var`, `process.env`, or equivalent throughout business
logic, and do not hide deploy-specific values in source-code constants.

Not every runtime setting is secret. Safe public settings may be supplied by
flags, ConfigMaps, or deployment manifests. Credentials, signing/encryption
material, database URLs containing credentials, private provider tokens, and
other secret-bearing values belong in the encrypted store or the platform
secret manager. Never encrypt a magic default merely to avoid documenting it.

## Secret-safe build and runtime rules

- Never decrypt during `docker build`; image layers and build metadata persist.
- Inject secrets at container/process start, not as build arguments.
- Never print values in CI, logs, shell tracing, Linear, GitHub descriptions, or
  evidence artifacts. Variable names and redacted presence/shape checks are the
  maximum permitted diagnostic surface.
- Keep the application as PID 1 so SIGTERM reaches it directly and graceful
  shutdown can drain work.
- Reject malformed dotenv, duplicate names, unsafe filesystem shapes, and
  unexpected files below `env/enc/`.
- Give humans and workloads separate identities; keep dev and prod recipient
  sets distinct before production reliance; maintain an independently
  controlled recovery path.
- Removing a recipient prevents future access only after `sops updatekeys` and
  application credentials/data keys are rotated by their owners.

SOPS dotenv values are single-line. Store multiline material using escaped
newlines, for example a value assembled from a public header label and `\n`
escapes; do not place a complete private-key signature in documentation or test
source. Tests that need one must construct the signature at runtime so repository
secret scanners remain fail-closed.

## Source-control policy

The repository enforces all of the following:

```gitignore
*.env
*/*.env
*/**/*.env
.env.*
*.env.*
!.env.example
/env/dec/
/env/enc/*
!/env/enc/dev.env.enc
!/env/enc/prod.env.enc
```

`.sops.yaml` has separate exact creation rules for the two approved ciphertext
paths. `.gitattributes` normalizes ciphertext to LF so reviews and SOPS MACs are
portable across platforms.

## Incident handling

A credential or private identity that appears in source, logs, an issue, a pull
request, chat, or an artifact is exposed. Remove it from active code and evidence,
record only the affected provider/path/name, and assign rotation to the credential
owner. Do not copy the value into another system and do not revoke or rotate a
shared credential without the owner's explicit authorization.
