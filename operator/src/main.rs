use std::env;
use std::sync::{Arc, atomic::Ordering};

use anyhow::Context as _;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use fiducia_operator::{Context, FiduciaCluster, Metrics, error_policy, reconcile};
use futures::StreamExt;
use kube::Api;
use kube::runtime::{Controller, watcher};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

async fn healthz() -> &'static str {
    "ok\n"
}

async fn readyz(State(metrics): State<Arc<Metrics>>) -> impl IntoResponse {
    if metrics.ready.load(Ordering::Relaxed) {
        (StatusCode::OK, "ready\n")
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "not ready\n")
    }
}

async fn metrics(State(metrics): State<Arc<Metrics>>) -> String {
    metrics.prometheus()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("fiducia_operator=info,kube=info")),
        )
        .json()
        .init();

    let namespace = env::var("POD_NAMESPACE").unwrap_or_else(|_| "fiducia".to_owned());
    let http_addr =
        env::var("FIDUCIA_OPERATOR_HTTP_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_owned());
    let client = kube::Client::try_default()
        .await
        .context("initialize Kubernetes client")?;
    let metrics_state = Arc::new(Metrics::default());
    let context = Arc::new(Context {
        client: client.clone(),
        namespace: namespace.clone(),
        metrics: metrics_state.clone(),
    });
    let clusters: Api<FiduciaCluster> = Api::namespaced(client, &namespace);

    let controller = Controller::new(clusters, watcher::Config::default())
        .run(reconcile, error_policy, context)
        .for_each(|result| async move {
            match result {
                Ok((object, action)) => {
                    tracing::debug!(?object, ?action, "observer reconciliation completed");
                }
                Err(error) => {
                    tracing::warn!(%error, "controller stream error");
                }
            }
        });

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/metrics", get(metrics))
        .with_state(metrics_state.clone());
    let listener = TcpListener::bind(&http_addr)
        .await
        .with_context(|| format!("bind observer HTTP server to {http_addr}"))?;

    metrics_state.ready.store(true, Ordering::Relaxed);
    tracing::info!(%namespace, %http_addr, mode = "observer-only", "fiducia operator started");

    tokio::select! {
        () = controller => {
            anyhow::bail!("controller stream ended unexpectedly");
        }
        result = axum::serve(listener, app) => {
            result.context("serve observer HTTP endpoints")?;
        }
        result = tokio::signal::ctrl_c() => {
            result.context("wait for shutdown signal")?;
            tracing::info!("shutdown signal received");
        }
    }

    Ok(())
}
