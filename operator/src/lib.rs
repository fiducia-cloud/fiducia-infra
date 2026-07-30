//! Observer-only reconciliation for Fiducia's stateful Kubernetes workloads.
//!
//! Phase 1 deliberately has no code path that updates `StatefulSets`, deletes
//! Pods, reads Secrets, or mutates PVCs. It observes the Kubernetes half of the
//! durability contract and writes a deterministic summary to `FiduciaCluster`
//! status.

use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::Duration;

use k8s_openapi::api::apps::v1::StatefulSet;
use k8s_openapi::api::core::v1::PersistentVolumeClaim;
use kube::api::{Api, ListParams, Patch, PatchParams};
use kube::runtime::controller::Action;
use kube::{Client, CustomResource, ResourceExt};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

const FIELD_MANAGER: &str = "fiducia-operator";

#[derive(CustomResource, Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[kube(
    group = "operator.fiducia.cloud",
    version = "v1alpha1",
    kind = "FiduciaCluster",
    plural = "fiduciaclusters",
    namespaced,
    status = "FiduciaClusterStatus",
    shortname = "fcluster"
)]
#[serde(rename_all = "camelCase")]
pub struct FiduciaClusterSpec {
    /// Local data-plane `StatefulSet`. The observer never changes it.
    #[serde(default = "default_node_stateful_set")]
    pub node_stateful_set: String,

    /// Optional local brain member. Node-only clusters leave this unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brain_stateful_set: Option<String>,

    /// Periodic resync protects against a missed watch event.
    #[serde(default = "default_requeue_seconds")]
    #[schemars(range(min = 10, max = 3600))]
    pub requeue_seconds: u64,
}

fn default_node_stateful_set() -> String {
    "fiducia-node".to_owned()
}

const fn default_requeue_seconds() -> u64 {
    30
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FiduciaClusterStatus {
    pub observed_generation: Option<i64>,
    pub phase: String,
    pub mutation_enabled: bool,
    pub workloads: Vec<WorkloadObservation>,
    pub conditions: Vec<StatusCondition>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadObservation {
    pub name: String,
    pub exists: bool,
    pub expected_replicas: i32,
    pub ready_replicas: i32,
    pub expected_pvcs: i32,
    pub bound_pvcs: i32,
    pub rollout_guarded: bool,
    pub storage_contract: bool,
    pub issues: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusCondition {
    #[serde(rename = "type")]
    pub condition_type: String,
    pub status: String,
    pub reason: String,
    pub message: String,
    pub observed_generation: Option<i64>,
}

#[derive(Debug, Default)]
pub struct Metrics {
    pub ready: AtomicBool,
    pub reconciliations: AtomicU64,
    pub reconcile_errors: AtomicU64,
    pub status_updates: AtomicU64,
}

impl Metrics {
    #[must_use]
    pub fn prometheus(&self) -> String {
        format!(
            concat!(
                "# HELP fiducia_operator_ready Whether the observer initialized successfully.\n",
                "# TYPE fiducia_operator_ready gauge\n",
                "fiducia_operator_ready {}\n",
                "# HELP fiducia_operator_reconciliations_total Reconciliation attempts.\n",
                "# TYPE fiducia_operator_reconciliations_total counter\n",
                "fiducia_operator_reconciliations_total {}\n",
                "# HELP fiducia_operator_reconcile_errors_total Failed reconciliation attempts.\n",
                "# TYPE fiducia_operator_reconcile_errors_total counter\n",
                "fiducia_operator_reconcile_errors_total {}\n",
                "# HELP fiducia_operator_status_updates_total FiduciaCluster status patches.\n",
                "# TYPE fiducia_operator_status_updates_total counter\n",
                "fiducia_operator_status_updates_total {}\n",
            ),
            u8::from(self.ready.load(Ordering::Relaxed)),
            self.reconciliations.load(Ordering::Relaxed),
            self.reconcile_errors.load(Ordering::Relaxed),
            self.status_updates.load(Ordering::Relaxed),
        )
    }
}

#[derive(Clone)]
pub struct Context {
    pub client: Client,
    pub namespace: String,
    pub metrics: Arc<Metrics>,
}

#[derive(Debug, thiserror::Error)]
pub enum ReconcileError {
    #[error("Kubernetes API error: {0}")]
    Kubernetes(#[from] kube::Error),
}

/// Inspect one `StatefulSet` and its stable data PVCs without mutating either.
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn observe_stateful_set(
    name: &str,
    workload: Option<&StatefulSet>,
    pvcs: &[PersistentVolumeClaim],
) -> WorkloadObservation {
    let Some(workload) = workload else {
        return WorkloadObservation {
            name: name.to_owned(),
            exists: false,
            expected_replicas: 0,
            ready_replicas: 0,
            expected_pvcs: 0,
            bound_pvcs: 0,
            rollout_guarded: false,
            storage_contract: false,
            issues: vec!["StatefulSetNotFound".to_owned()],
        };
    };

    let mut issues = Vec::new();
    let Some(spec) = workload.spec.as_ref() else {
        return WorkloadObservation {
            name: name.to_owned(),
            exists: true,
            expected_replicas: 0,
            ready_replicas: 0,
            expected_pvcs: 0,
            bound_pvcs: 0,
            rollout_guarded: false,
            storage_contract: false,
            issues: vec!["StatefulSetSpecMissing".to_owned()],
        };
    };

    let expected_replicas = spec.replicas.unwrap_or(1).max(0);
    let ready_replicas = workload
        .status
        .as_ref()
        .and_then(|status| status.ready_replicas)
        .unwrap_or(0);

    let rollout_guarded = spec
        .update_strategy
        .as_ref()
        .and_then(|strategy| strategy.type_.as_deref())
        == Some("OnDelete");
    if !rollout_guarded {
        issues.push("AutomaticRolloutEnabled".to_owned());
    }

    let retained = spec
        .persistent_volume_claim_retention_policy
        .as_ref()
        .is_some_and(|policy| {
            policy.when_deleted.as_deref() == Some("Retain")
                && policy.when_scaled.as_deref() == Some("Retain")
        });
    if !retained {
        issues.push("PvcRetentionNotExplicit".to_owned());
    }

    let claims = spec.volume_claim_templates.as_deref().unwrap_or_default();
    let data_claim = claims
        .iter()
        .find(|claim| claim.metadata.name.as_deref() == Some("data"));
    if data_claim.is_none() {
        issues.push("DataPvcTemplateMissing".to_owned());
    }

    let pod_spec = spec.template.spec.as_ref();
    let primary = pod_spec.and_then(|pod| {
        pod.containers.iter().find(|container| {
            container
                .env
                .as_ref()
                .is_some_and(|env| env.iter().any(|entry| entry.name == "FIDUCIA_DATA_DIR"))
        })
    });
    let data_dir = primary
        .and_then(|container| container.env.as_ref())
        .and_then(|env| env.iter().find(|entry| entry.name == "FIDUCIA_DATA_DIR"))
        .and_then(|entry| entry.value.as_deref());
    let data_mount_matches = primary.is_some_and(|container| {
        container.volume_mounts.as_ref().is_some_and(|mounts| {
            mounts
                .iter()
                .any(|mount| mount.name == "data" && Some(mount.mount_path.as_str()) == data_dir)
        })
    });
    if data_dir.is_none() || !data_mount_matches {
        issues.push("DataDirectoryNotOnPvc".to_owned());
    }
    let data_shadowed_by_ephemeral = pod_spec.is_some_and(|pod| {
        pod.volumes.as_ref().is_some_and(|volumes| {
            volumes
                .iter()
                .any(|volume| volume.name == "data" && volume.empty_dir.is_some())
        })
    });
    if data_shadowed_by_ephemeral {
        issues.push("DataPvcShadowedByEmptyDir".to_owned());
    }

    let storage_contract =
        retained && data_claim.is_some() && data_mount_matches && !data_shadowed_by_ephemeral;
    let prefix = format!("data-{name}-");
    let bound_pvcs = pvcs
        .iter()
        .filter(|pvc| {
            pvc.metadata
                .name
                .as_deref()
                .is_some_and(|pvc_name| pvc_name.starts_with(&prefix))
                && pvc
                    .status
                    .as_ref()
                    .and_then(|status| status.phase.as_deref())
                    == Some("Bound")
        })
        .count()
        .try_into()
        .unwrap_or(i32::MAX);
    if bound_pvcs < expected_replicas {
        issues.push("DataPvcNotBound".to_owned());
    }
    if ready_replicas < expected_replicas {
        issues.push("ReplicasNotReady".to_owned());
    }

    WorkloadObservation {
        name: name.to_owned(),
        exists: true,
        expected_replicas,
        ready_replicas,
        expected_pvcs: expected_replicas,
        bound_pvcs,
        rollout_guarded,
        storage_contract,
        issues,
    }
}

#[must_use]
pub fn build_status(
    cluster: &FiduciaCluster,
    workloads: Vec<WorkloadObservation>,
) -> FiduciaClusterStatus {
    let observed_generation = cluster.metadata.generation;
    let workloads_exist = workloads.iter().all(|workload| workload.exists);
    let rollout_guarded = workloads.iter().all(|workload| workload.rollout_guarded);
    let storage_ready = workloads
        .iter()
        .all(|workload| workload.storage_contract && workload.bound_pvcs >= workload.expected_pvcs);
    let replicas_ready = workloads
        .iter()
        .all(|workload| workload.ready_replicas >= workload.expected_replicas);
    let ready = workloads_exist && rollout_guarded && storage_ready && replicas_ready;

    let condition = |condition_type: &str,
                     value: bool,
                     true_reason: &str,
                     false_reason: &str,
                     message: String| {
        StatusCondition {
            condition_type: condition_type.to_owned(),
            status: if value { "True" } else { "False" }.to_owned(),
            reason: if value { true_reason } else { false_reason }.to_owned(),
            message,
            observed_generation,
        }
    };

    FiduciaClusterStatus {
        observed_generation,
        // The observer cannot prove Raft quorum or service compatibility, so it
        // must not claim the whole Fiducia cluster is Ready.
        phase: if ready { "Observed" } else { "Degraded" }.to_owned(),
        mutation_enabled: false,
        conditions: vec![
            condition(
                "WorkloadsObserved",
                workloads_exist,
                "AllStatefulSetsFound",
                "StatefulSetMissing",
                "The configured local Raft StatefulSets are visible.".to_owned(),
            ),
            condition(
                "RolloutGuarded",
                rollout_guarded,
                "OnDelete",
                "AutomaticRolloutEnabled",
                "Raft StatefulSets must use the OnDelete update strategy.".to_owned(),
            ),
            condition(
                "StorageReady",
                storage_ready,
                "RetainedPvcBound",
                "DurabilityContractIncomplete",
                "Each Raft workload needs an explicitly retained, bound data PVC.".to_owned(),
            ),
            condition(
                "ReplicasReady",
                replicas_ready,
                "DesiredReplicasReady",
                "ReplicaUnavailable",
                "Kubernetes readiness is reported for visibility, not as quorum proof.".to_owned(),
            ),
            condition(
                "OperatorMutationReady",
                false,
                "Impossible",
                "ObserverOnly",
                "Pod deletion, scaling, restore, and membership changes are disabled.".to_owned(),
            ),
        ],
        workloads,
    }
}

/// Reconcile only Kubernetes observations and the custom resource's status.
///
/// The RBAC manifest intentionally makes workload mutation impossible.
///
/// # Errors
///
/// Returns [`ReconcileError::Kubernetes`] when a read or status patch against
/// the local Kubernetes API fails.
pub async fn reconcile(
    cluster: Arc<FiduciaCluster>,
    context: Arc<Context>,
) -> Result<Action, ReconcileError> {
    context
        .metrics
        .reconciliations
        .fetch_add(1, Ordering::Relaxed);

    let stateful_sets: Api<StatefulSet> =
        Api::namespaced(context.client.clone(), &context.namespace);
    let pvcs: Api<PersistentVolumeClaim> =
        Api::namespaced(context.client.clone(), &context.namespace);
    let clusters: Api<FiduciaCluster> = Api::namespaced(context.client.clone(), &context.namespace);

    let pvc_list = pvcs.list(&ListParams::default()).await?;
    let node = stateful_sets
        .get_opt(&cluster.spec.node_stateful_set)
        .await?;
    let mut observations = vec![observe_stateful_set(
        &cluster.spec.node_stateful_set,
        node.as_ref(),
        &pvc_list.items,
    )];

    if let Some(brain_name) = cluster.spec.brain_stateful_set.as_deref() {
        let brain = stateful_sets.get_opt(brain_name).await?;
        observations.push(observe_stateful_set(
            brain_name,
            brain.as_ref(),
            &pvc_list.items,
        ));
    }

    let desired_status = build_status(&cluster, observations);
    if cluster.status.as_ref() != Some(&desired_status) {
        clusters
            .patch_status(
                &cluster.name_any(),
                &PatchParams::apply(FIELD_MANAGER),
                &Patch::Merge(json!({ "status": desired_status })),
            )
            .await?;
        context
            .metrics
            .status_updates
            .fetch_add(1, Ordering::Relaxed);
    }

    Ok(Action::requeue(Duration::from_secs(
        cluster.spec.requeue_seconds.clamp(10, 3600),
    )))
}

#[must_use]
#[allow(clippy::needless_pass_by_value)]
pub fn error_policy(
    _cluster: Arc<FiduciaCluster>,
    error: &ReconcileError,
    context: Arc<Context>,
) -> Action {
    context
        .metrics
        .reconcile_errors
        .fetch_add(1, Ordering::Relaxed);
    tracing::warn!(%error, "observer reconciliation failed");
    Action::requeue(Duration::from_secs(15))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use serde_json::json;

    fn stateful_set(strategy: &str, retained: bool, ready: i32) -> StatefulSet {
        let retention = retained.then(|| {
            json!({
                "whenDeleted": "Retain",
                "whenScaled": "Retain"
            })
        });
        serde_json::from_value(json!({
            "apiVersion": "apps/v1",
            "kind": "StatefulSet",
            "metadata": { "name": "fiducia-node", "namespace": "fiducia" },
            "spec": {
                "serviceName": "fiducia-node",
                "replicas": 3,
                "selector": { "matchLabels": { "app": "fiducia-node" } },
                "updateStrategy": { "type": strategy },
                "persistentVolumeClaimRetentionPolicy": retention,
                "template": {
                    "metadata": { "labels": { "app": "fiducia-node" } },
                    "spec": {
                        "containers": [{
                            "name": "node",
                            "image": "example.invalid/node@sha256:abc",
                            "env": [{ "name": "FIDUCIA_DATA_DIR", "value": "/var/lib/fiducia" }],
                            "volumeMounts": [{ "name": "data", "mountPath": "/var/lib/fiducia" }]
                        }]
                    }
                },
                "volumeClaimTemplates": [{
                    "metadata": { "name": "data" },
                    "spec": {
                        "accessModes": ["ReadWriteOnce"],
                        "resources": { "requests": { "storage": "10Gi" } }
                    }
                }]
            },
            "status": { "readyReplicas": ready }
        }))
        .expect("valid StatefulSet fixture")
    }

    fn pvc(ordinal: u8, phase: &str) -> PersistentVolumeClaim {
        serde_json::from_value(json!({
            "apiVersion": "v1",
            "kind": "PersistentVolumeClaim",
            "metadata": { "name": format!("data-fiducia-node-{ordinal}") },
            "spec": {
                "accessModes": ["ReadWriteOnce"],
                "resources": { "requests": { "storage": "10Gi" } }
            },
            "status": { "phase": phase }
        }))
        .expect("valid PVC fixture")
    }

    fn cluster() -> FiduciaCluster {
        serde_json::from_value(json!({
            "apiVersion": "operator.fiducia.cloud/v1alpha1",
            "kind": "FiduciaCluster",
            "metadata": { "name": "fiducia", "namespace": "fiducia", "generation": 7 },
            "spec": {
                "nodeStatefulSet": "fiducia-node",
                "requeueSeconds": 30
            }
        }))
        .expect("valid FiduciaCluster fixture")
    }

    #[test]
    fn healthy_storage_contract_is_ready_but_mutation_stays_disabled() {
        let workload = stateful_set("OnDelete", true, 3);
        let pvcs = [pvc(0, "Bound"), pvc(1, "Bound"), pvc(2, "Bound")];
        let observation = observe_stateful_set("fiducia-node", Some(&workload), &pvcs);

        assert!(observation.storage_contract);
        assert!(observation.rollout_guarded);
        assert!(observation.issues.is_empty());

        let status = build_status(&cluster(), vec![observation]);
        assert_eq!(status.phase, "Observed");
        assert!(!status.mutation_enabled);
        assert_eq!(
            status
                .conditions
                .iter()
                .find(|condition| condition.condition_type == "OperatorMutationReady")
                .map(|condition| condition.status.as_str()),
            Some("False"),
        );
    }

    #[test]
    fn automatic_rollout_and_missing_retention_fail_closed() {
        let workload = stateful_set("RollingUpdate", false, 3);
        let pvcs = [pvc(0, "Bound"), pvc(1, "Bound"), pvc(2, "Pending")];
        let observation = observe_stateful_set("fiducia-node", Some(&workload), &pvcs);

        assert!(!observation.storage_contract);
        assert!(!observation.rollout_guarded);
        assert_eq!(
            observation.issues,
            vec![
                "AutomaticRolloutEnabled",
                "PvcRetentionNotExplicit",
                "DataPvcNotBound",
            ],
        );

        let status = build_status(&cluster(), vec![observation]);
        assert_eq!(status.phase, "Degraded");
        assert!(!status.mutation_enabled);
    }

    #[test]
    fn data_empty_dir_cannot_shadow_the_declared_pvc() {
        let mut workload = stateful_set("OnDelete", true, 3);
        workload
            .spec
            .as_mut()
            .and_then(|spec| spec.template.spec.as_mut())
            .expect("fixture pod spec")
            .volumes = Some(vec![k8s_openapi::api::core::v1::Volume {
            name: "data".to_owned(),
            empty_dir: Some(k8s_openapi::api::core::v1::EmptyDirVolumeSource::default()),
            ..Default::default()
        }]);
        let pvcs = [pvc(0, "Bound"), pvc(1, "Bound"), pvc(2, "Bound")];

        let observation = observe_stateful_set("fiducia-node", Some(&workload), &pvcs);

        assert!(!observation.storage_contract);
        assert!(
            observation
                .issues
                .contains(&"DataPvcShadowedByEmptyDir".to_owned())
        );
    }

    #[test]
    fn missing_stateful_set_is_reported_without_inventing_health() {
        let observation = observe_stateful_set("fiducia-node", None, &[]);
        assert_eq!(observation.issues, vec!["StatefulSetNotFound"]);

        let status = build_status(&cluster(), vec![observation]);
        assert_eq!(status.phase, "Degraded");
        assert_eq!(
            status
                .conditions
                .iter()
                .find(|condition| condition.condition_type == "WorkloadsObserved")
                .map(|condition| condition.reason.as_str()),
            Some("StatefulSetMissing"),
        );
    }
}
