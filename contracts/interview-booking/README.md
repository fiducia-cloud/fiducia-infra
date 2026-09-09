# Interview auto-booking contract

Tracking: DEN-3931, related to DEN-812.

This directory defines the language-neutral data contract for engineering-interview auto-booking. The two source authorities are deliberately independent:

- `main.tsp` is the authored TypeSpec authority.
- `authored.schema.json` is the authored JSON Schema Draft 2020-12 authority.

Neither file is generated from the other. `ORESoftware/typespec-json-schema-validator` (`tjsv`) generates a temporary TypeSpec witness only for comparison, then compares declaration structure and executes both authorities against the recorded instance corpus. Contract drift must stop evaluation rather than silently promoting either source.

The v1 policy is intentionally narrow: `America/New_York`, a 10:00 through 19:00 Eastern window, existing-calendar conflict avoidance, earliest-slot preference, engineering-job opportunities only, automatic booking only when the execution surface is actually supported, and scheduler-link surfacing when a third-party page cannot be completed safely.

`tools/interview-booking-policy.mjs` is an effect-free planner. It does not click scheduling pages, create calendar events, submit job applications, accept terms, or claim that a reservation exists. An executor must create the external booking/calendar effect and retain the resulting provider/calendar receipt before reporting a booking as complete.

## Validation

The GitHub workflow pins the exact `ORESoftware/typespec-json-schema-validator` source revision instead of consuming an unreviewed moving branch:

```sh
node --test tools/interview-booking-policy.test.mjs
npm exec --yes \
  --package=github:ORESoftware/typespec-json-schema-validator#2281843126ab644607b11cf8281d84f382d68dfc \
  -- tjsv check \
  --typespec=contracts/interview-booking/main.tsp \
  --schema=contracts/interview-booking/authored.schema.json \
  --instances=contracts/interview-booking/instances \
  --report=.typespec-json-schema-validator/interview-booking-report.json \
  --quiet
```

The generated witness/report directory is local CI evidence and is ignored by Git. Recorded valid and invalid instances under this directory remain source-controlled contract evidence.
