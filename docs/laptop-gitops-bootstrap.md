# Laptop-cluster GitOps bootstrap and promotion

Governing issue: `DEN-944`.

This procedure gives each dedicated laptop cluster its own pull-based Argo CD
control loop. No laptop registers the other two clusters, and no central laptop
is required to deploy or reconcile its peers.

The laptop root points at `fiducia-cloud/fiducia-infra`, but it never follows a
mutable branch or tag. The root Application is rendered for one exact
40-character Git commit. Production synchronization is manual because the
current laptop overlay contains both stateless services and quorum-bearing
StatefulSets. Unconstrained automated self-heal would be able to replace multiple
members without observing Fiducia or JetStream leadership and catch-up state.

## Inputs and trust boundary

A bootstrap operator needs four independently reviewable inputs:

1. the kube context for exactly one single-node laptop cluster;
2. a local, pinned Argo CD installation manifest plus its expected SHA-256;
3. a local Argo CD repository Secret stored outside Git;
4. the exact `fiducia-infra` commit selected for that cluster.

The script does not download upstream manifests, follow `main`, or print secret
content. An Argo CD installation bundle can be retained in the encrypted
operator/recovery repository or another approved artifact store. Record its
upstream version, source URL, retrieval date, and SHA-256 in the release evidence
without placing credentials in Linear or Git.

The cluster must expose exactly one node with both labels:

```text
fiducia.cloud/cluster=<laptop-*-sim>
fiducia.cloud/substrate=laptop-k3s
```

That check prevents an accidentally selected developer, staging, or peer-cluster
context from receiving production resources.

## Repository Secret

Store the repository Secret outside this repository. A redacted structural
example is:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: fiducia-infra-repository
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
stringData:
  type: git
  url: https://github.com/fiducia-cloud/fiducia-infra.git
  username: <external-secret-reference-or-deploy-identity>
  password: <external-secret-reference-or-token>
```

For a public repository the credential fields may be omitted, but the explicit
repository record is still useful for scope and future trust configuration. For
a private repository, use the cross-organization read-only GitHub App/deploy
identity and materialize it through the approved SOPS/age plus External Secrets
bootstrap path. Never commit the rendered Secret.

The bootstrap script verifies the repository label and exact repository URL
before applying it. It deliberately does not display or diff the file.

## Render-only review

Before touching a cluster, render the exact root bundle:

```sh
scripts/bootstrap-laptop-gitops.sh \
  --cluster laptop-aws-sim \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  > /tmp/laptop-aws-sim-root.yaml
```

The output contains:

- one `AppProject` restricted to the Fiducia repository, the local Kubernetes
  API, the `fiducia` namespace, and the resource kinds rendered by the base;
- one cluster-local `Application` targeting only that laptop overlay;
- an exact Git commit in `targetRevision`;
- no `Secret` and no production credential;
- no `automated` sync policy.

Review the bundle and its printed SHA-256 before applying it.

## Apply bootstrap

```sh
scripts/bootstrap-laptop-gitops.sh \
  --cluster laptop-aws-sim \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --context fiducia-laptop-aws-sim \
  --argocd-install /secure/artifacts/argocd-install.yaml \
  --argocd-sha256 <recorded-64-character-sha256> \
  --repo-secret /secure/bootstrap/laptop-aws-sim-repository.secret.yaml \
  --apply
```

The script performs these steps in order:

1. renders the root bundle and validates the cluster/revision contract;
2. verifies the local Argo CD manifest checksum;
3. verifies the external repository Secret's label and repository scope;
4. checks that the kube context contains exactly one correctly labeled laptop
   node;
5. server-side dry-runs the Argo CD install and repository Secret;
6. installs Argo CD and waits for its CRDs and Deployments;
7. applies the repository Secret without printing it;
8. server-side dry-runs and applies the revision-pinned project/root bundle;
9. reports the Application's requested revision, path, sync, and health status.

Repeat with the corresponding context and cluster identity on the other two
laptops. Do not register remote laptop clusters into a central Argo CD instance.

## Promotion model

Every production revision is promoted to one cluster at a time. The script has
two explicit phases.

### Stateless phase

```sh
scripts/promote-laptop-cluster.sh \
  --cluster laptop-aws-sim \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --context fiducia-laptop-aws-sim \
  --phase stateless \
  --apply
```

This stages the Application at the new immutable revision and selectively syncs
Deployments, DaemonSets, ConfigMaps, Services, service accounts, RBAC, and
NetworkPolicies. It does not prune and does not sync StatefulSets. Validate
external HTTP health, authentication/session behavior, logs, metrics, and error
rates before continuing.

### Stateful phase

First observe the live Fiducia and JetStream member roles and replication/catch-
up state. Then promote one follower cluster only:

```sh
scripts/promote-laptop-cluster.sh \
  --cluster laptop-aws-sim \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --context fiducia-laptop-aws-sim \
  --phase stateful \
  --member-role follower \
  --ack-one-member-at-a-time \
  --apply
```

Wait for full catch-up and restore eligibility before touching a second member.
Promote the current leader last and only after leadership has been transferred or
its loss has been explicitly accepted:

```sh
scripts/promote-laptop-cluster.sh \
  --cluster laptop-azure-sim \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --context fiducia-laptop-azure-sim \
  --phase stateful \
  --member-role leader \
  --ack-one-member-at-a-time \
  --ack-leader-last \
  --apply
```

The acknowledgement flags are not a substitute for observing live state. They
make unsafe sequencing intentional and reviewable instead of an accidental
side-effect of a generic `argocd app sync`.

## Rollback

Rollback is another immutable promotion. Select the previously proven commit and
run the same stateless-first, follower-first, leader-last procedure. Never switch
an Application to a mutable branch to make rollback faster.

For a failed stateless canary:

1. stop progression to the other clusters;
2. promote the prior exact commit to the affected cluster's stateless phase;
3. validate health and session compatibility;
4. record the failed revision and evidence.

For a stateful failure:

1. stop all other member changes;
2. preserve logs and snapshots;
3. determine whether rolling forward or backward is compatible with persisted
   state;
4. restore or replace only one member at a time;
5. keep the current majority untouched until the repaired member is caught up.

## Drift and emergency changes

Argo CD may report drift, but the production Application does not automatically
heal it. This is intentional for quorum safety.

Normal drift handling:

1. identify whether drift is an emergency live edit, an operator mutation, or an
   unmanaged controller field;
2. encode the intended result in Git;
3. review and merge it;
4. promote the exact commit through the guarded procedure;
5. remove temporary live changes only after the desired revision is healthy.

During an incident, a live edit must carry an incident/reference annotation and
must be reconciled into Git immediately after containment. Do not normalize
permanent `kubectl edit` operations as the deployment mechanism.

## Clean rebuild proof

A rebuild exercise for one laptop cluster should use only:

- versioned host/K3s configuration;
- the pinned Argo CD installation artifact and checksum;
- the independently recoverable repository/secret bootstrap material;
- Git at an exact reviewed commit;
- external K3s/Fiducia/database/messaging backups.

Acceptance evidence should show that no mutable state was copied from another
live laptop and no peer laptop was required to reconcile the replacement. After
the root Application is present, restore authoritative data according to
`DEN-437`, wait for member catch-up, and add the replacement to traffic only after
`DEN-946` health and failure tests pass.

## CI contract

The `laptop-fleet` workflow verifies:

- all generated laptop topology files are current;
- all three Kustomize overlays build;
- every root Application renders with an exact revision and local destination;
- no rendered root contains a Secret, wildcard destination, mutable revision, or
  automated synchronization policy;
- the bootstrap cannot download mutable content and requires checksum-verified
  local inputs;
- stateless and stateful promotion resource sets remain separated;
- stateful and leader promotion acknowledgements remain mandatory;
- both shell scripts parse with `bash -n`.

These checks prove the software contract. Physical installation, secret access,
live sync, failover, clean-room restore, and the seven-day soak remain separate
evidence gates in `DEN-943`, `DEN-946`, and the parent `DEN-941`.
