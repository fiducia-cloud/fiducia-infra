# Multicluster acceptance test

`run.sh` exercises the live three-cluster emulator through each exposed node
endpoint. The default pass checks reachability, shard leadership, quorum, and
cross-cluster data flow. `run.sh --scenarios` also injects WAN latency and a
single-cluster partition, verifies majority availability, heals the fault, and
checks convergence again.

Start the environment with `../up.sh` first. The script uses only the emulator
credentials created by that launcher and must not be pointed at production
endpoints.
