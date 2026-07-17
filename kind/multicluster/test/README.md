# Multicluster acceptance test

`run.sh` exercises the live three-cluster emulator through each exposed node
endpoint. The default pass checks reachability, shard leadership, quorum, and
cross-cluster data flow. `run.sh --scenarios` also injects WAN latency, a
single-cluster network partition, and a reversible pause of one entire Kind
control plane. It proves the two survivors retain quorum and can commit through
their load balancers within the bounded 10-second leader-table refresh window,
then verifies the resumed cluster catches up with all three replicas healthy.

Start the environment with `../up.sh` first. The script uses only the emulator
credentials created by that launcher and must not be pointed at production
endpoints.
