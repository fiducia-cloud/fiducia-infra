# observability — per-cluster telemetry agent

`otel-agent.yaml`: the OpenTelemetry Collector DaemonSet each cluster inherits. It
receives OTLP from fiducia services, tails JSON pod logs, redacts known sensitive
attributes, batches, and uses a file-backed queue before forwarding to the central
gateway (where tail sampling and durable storage fan-out live). See `docs/observability.md`.

`networkpolicy.yaml` permits only the agent's required out-of-namespace egress:
OTLP/HTTP `:4318` to the gateway and Kubernetes API `:443`/`:6443` for enrichment.
OTLP and collector metrics remain reachable only through same-namespace traffic.
