# Funding candidate validation boundary

Tracking: DEN-812. This is a follow-up to the merged DEN-3789 snapshot contract,
not a new provider catalog or an application executor.

## Why decoded validation matters

JSON source spelling is not the value consumed by an application. A credential
prefix written with Unicode escapes must be rejected just like its decoded
spelling. Likewise, a caller-supplied empty or sanitized `rawText` must not turn
off checks of the object actually being validated.

`validateSnapshot` checks every bounded decoded candidate string. Optional raw
source scanning is additional defense only. The file loader reuses the existing
strict parser from `application-operations.mjs` to reject direct, nested, and
Unicode-equivalent duplicate keys before schema validation. No dependency is
installed and no network request is performed.

## Inputs and output

The schema remains version 2. Existing historical snapshots and their evidence
are unchanged. Validation does not establish eligibility, official domain
ownership, provider acceptance, or approval to submit.

The validator rejects credential and mailbox-header patterns, email addresses,
control/format characters and unpaired surrogates. Candidate and category counts
are bounded, as are identifiers and all free-text fields. Files are limited to
1,000,000 bytes and must contain valid UTF-8 and unambiguous JSON.

Public links must use canonical HTTPS spelling with no credentials, query,
fragment, custom port, IP literal, trailing-dot hostname, or private/reserved DNS
suffix. Encoded path components receive bounded decoding and sensitive-content
checks. This is a static catalog check, **not** an SSRF-safe fetcher: it does not
resolve DNS, validate redirects, prove that a hostname is publicly routable, or
establish that a program is official. Those checks belong at an independently
reviewed network boundary before fetching a link.

Directory ingestion inspects every entry beginning with `candidates-`. A malformed
candidate-looking filename now fails instead of being silently skipped. Snapshots
must be regular files, not symlinks, and the filename date must match `verified_on`.
This is a repository-input validation boundary, not a concurrent filesystem
sandbox or a guarantee against replacement races by a local privileged actor.

The CLI emits a generic failure message so malformed JSON keys, credential-bearing
paths, and filesystem errors cannot be copied into public CI output. Library
validation errors identify fields and failure classes without echoing their
contents; callers must not indiscriminately publish native filesystem exceptions.

## Compatibility and validation

Callers may still use `validateSnapshot(snapshot)` or pass supplementary raw text.
Inputs previously accepted only because of ambiguous JSON or noncanonical URLs
must be corrected through a reviewed change; the validator does not rewrite
records automatically. No status, company fact, mailbox identity, approval gate,
application count, or historical observation is changed by this hardening.

Run from the repository root:

```sh
node tools/validate-funding-candidates.mjs funding
node --test tools/validate-funding-candidates.test.mjs tools/application-operations.test.mjs
```

The existing funding workflow already covers both source/test paths and their
shared parser. Regression tests include escaped credential families, raw-text
bypass, standalone headers, Unicode controls, duplicate JSON keys, unsafe URLs,
multiple snapshots, malformed filenames, file bounds, input immutability, and
redacted CLI diagnostics. A passing check is not permission to send email,
submit an application, accept terms, or incur costs.
