# observability — per-cluster telemetry agent

`otel-agent.yaml`: the OpenTelemetry Collector DaemonSet each cluster inherits. It
receives OTLP from fiducia services, tails JSON pod logs, redacts known sensitive
attributes, batches, and uses a file-backed queue before forwarding to the central
gateway (where tail sampling and durable storage fan-out live). See `docs/observability.md`.
