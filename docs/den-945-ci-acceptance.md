# DEN-945 CI merge gate

PR #22 may be merged only when all of the following are true for the same final
head commit:

- the laptop-fleet workflow succeeds;
- the full repository CI workflow succeeds;
- the dedicated JetStream contract test is present and executed;
- generated messaging and provenance artifacts are current;
- every laptop and canonical cloud overlay builds;
- workflow and shell syntax validation succeeds;
- there are no unresolved review threads;
- GitHub reports the branch mergeable;
- the pull-request description and Linear issue preserve the distinction between
  software evidence and live physical-fleet evidence.

A cancelled, skipped, stale-head, or superseded workflow is not successful merge
evidence.
