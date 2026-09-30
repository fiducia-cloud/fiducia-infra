-- GENERATED. DO NOT EDIT.
-- Source: parity-admissible TypeSpec + JSON Schema Contract IR from ORESoftware/ores-err-trace.
-- contract_ir_id=dad1106974d7ccfd23357a5f4881a45ec738393ed497aae609cacce3a3e06a29

create extension if not exists pgcrypto;

create table if not exists public.ores_err_trace_fingerprints (
  "id" uuid primary key default gen_random_uuid(),
  "policy" text not null check (policy in ('v1','dd-next-compat-v2')),
  "fingerprint" text not null check (fingerprint ~ '^[0-9a-f]{64}$|^dd-next-compat-v2:[0-9a-f]{64}$'),
  "service" text not null check (length(service) between 1 and 256),
  "occurrence_count" bigint not null default 1,
  "first_seen_at" timestamptz not null default now(),
  "last_seen_at" timestamptz not null default now(),
  unique (policy, fingerprint, service)
);

create table if not exists public.ores_err_trace_events (
  "id" uuid primary key default gen_random_uuid(),
  "policy" text not null check (policy in ('v1','dd-next-compat-v2')),
  "fingerprint" text not null check (fingerprint ~ '^[0-9a-f]{64}$|^dd-next-compat-v2:[0-9a-f]{64}$'),
  "environment" text,
  "error_code" text,
  "error_list" jsonb,
  "error_type" text,
  "exception_type" text,
  "file_name" text,
  "message" text,
  "operation" text,
  "otel_span_id" text,
  "otel_trace_id" text,
  "parent_trace_id" text,
  "release_sha" text,
  "repository" text,
  "routine_id" text,
  "runtime" text,
  "service" text not null check (length(service) between 1 and 256),
  "severity" text,
  "source" text,
  "top_frame" text,
  "trace_id" text,
  "occurred_at" timestamptz not null default now(),
  foreign key (policy, fingerprint, service) references public.ores_err_trace_fingerprints(policy, fingerprint, service) on update cascade on delete restrict
);

create index if not exists ores_err_trace_events_service_time_idx on public.ores_err_trace_events(service, occurred_at desc);
create index if not exists ores_err_trace_events_trace_idx on public.ores_err_trace_events(trace_id) where trace_id is not null;
create index if not exists ores_err_trace_events_otel_trace_idx on public.ores_err_trace_events(otel_trace_id) where otel_trace_id is not null;
create index if not exists ores_err_trace_events_repo_idx on public.ores_err_trace_events(repository, occurred_at desc) where repository is not null;

do $ores$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    alter table public.ores_err_trace_fingerprints enable row level security;
    alter table public.ores_err_trace_events enable row level security;
    revoke all on table public.ores_err_trace_fingerprints from anon, authenticated;
    revoke all on table public.ores_err_trace_events from anon, authenticated;
  end if;
end $ores$;

comment on table public.ores_err_trace_events is 'Generated from ORESoftware/ores-err-trace parity-admitted contracts; direct client access is denied by default.';
comment on table public.ores_err_trace_fingerprints is 'Generated dedupe projection for ORESoftware/ores-err-trace.';
