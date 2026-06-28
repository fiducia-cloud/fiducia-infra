-- CockroachDB contract for high-value recent observability events.
--
-- This is not a raw log sink. Raw logs should land in Loki, ClickHouse, or
-- object storage through the observability gateway. Cockroach stores compact
-- structured events that are worth querying transactionally: outages, failed
-- auth, quorum changes, scheduler decisions, security/audit markers, and event
-- summaries linked to trace IDs.

create database if not exists fiducia_observability;

use fiducia_observability;

create table if not exists important_events (
  id uuid primary key default gen_random_uuid(),
  event_time timestamptz not null,
  observed_at timestamptz not null default now(),
  cluster_id string not null,
  cluster_name string not null,
  service_namespace string not null default 'fiducia-cloud',
  service_name string not null,
  service_instance string,
  severity string not null,
  event_name string not null,
  trace_id string,
  span_id string,
  request_id string,
  subject_type string,
  subject_id string,
  attributes jsonb not null default '{}'::jsonb,
  body string,
  constraint important_events_severity_chk
    check (severity in ('TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL')),
  constraint important_events_attributes_object_chk
    check (jsonb_typeof(attributes) = 'object')
) with (
  ttl_expire_after = '14 days',
  ttl_job_cron = '0 */4 * * *'
);

create index if not exists important_events_time_idx
  on important_events (event_time desc);

create index if not exists important_events_service_time_idx
  on important_events (service_name, event_time desc);

create index if not exists important_events_cluster_time_idx
  on important_events (cluster_name, event_time desc);

create index if not exists important_events_trace_idx
  on important_events (trace_id)
  where trace_id is not null;

create table if not exists observability_ingest_errors (
  id uuid primary key default gen_random_uuid(),
  observed_at timestamptz not null default now(),
  source string not null,
  reason string not null,
  payload jsonb not null default '{}'::jsonb,
  constraint observability_ingest_errors_payload_object_chk
    check (jsonb_typeof(payload) = 'object')
) with (
  ttl_expire_after = '7 days',
  ttl_job_cron = '0 */4 * * *'
);

create index if not exists observability_ingest_errors_observed_idx
  on observability_ingest_errors (observed_at desc);
