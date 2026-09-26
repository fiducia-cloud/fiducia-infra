-- GENERATED STORAGE PROJECTION CANDIDATE. DO NOT HAND-EDIT AFTER REGENERATION.
-- schema: ores.err-trace.storage-projection/v1
-- authorities: ORESoftware/ores-err-trace@abdc25469c224bef0c9a4c2c8e3a504d549d68a5
-- generator: ORESoftware/ores-err-trace@bc985ffe1fec66887a4c92c8c13fad804c69882d (draft PR #7)
-- tjsv: ORESoftware/typespec-json-schema-validator@a9db1298cd4c993744a7b24bbc8f0ae9d1d0a33a
-- source lanes: contracts/typespec/main.tsp + contracts/json-schema/contract.schema.json
-- merge gate: rebuild an admissible TJSV Contract IR, run scripts/generate-storage-projections.mjs,
-- and require byte/column parity with generated Postgres, Diesel, and SeaORM outputs before this draft is ready.

create extension if not exists pgcrypto;

create table if not exists public.ores_err_trace_fingerprints (
  id uuid primary key default gen_random_uuid(),
  policy text not null check (policy in ('v1', 'dd-next-compat-v2')),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$|^dd-next-compat-v2:[0-9a-f]{64}$'),
  service text not null check (length(service) between 1 and 256),
  occurrence_count bigint not null default 1 check (occurrence_count >= 1),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (policy, fingerprint, service)
);

create table if not exists public.ores_err_trace_events (
  id uuid primary key default gen_random_uuid(),
  policy text not null check (policy in ('v1', 'dd-next-compat-v2')),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$|^dd-next-compat-v2:[0-9a-f]{64}$'),
  service text not null check (length(service) between 1 and 256),
  exception_type text,
  error_type text,
  error_code text,
  message text,
  error_list jsonb not null default '[]'::jsonb check (jsonb_typeof(error_list) = 'array'),
  top_frame text,
  operation text,
  repository text,
  environment text,
  release_sha text,
  trace_id text,
  severity text,
  runtime text,
  source text,
  routine_id text,
  file_name text,
  occurred_at timestamptz not null default now(),
  foreign key (policy, fingerprint, service)
    references public.ores_err_trace_fingerprints(policy, fingerprint, service)
    on update cascade on delete restrict
);

create index if not exists ores_err_trace_events_service_time_idx
  on public.ores_err_trace_events(service, occurred_at desc);
create index if not exists ores_err_trace_events_trace_idx
  on public.ores_err_trace_events(trace_id) where trace_id is not null;
create index if not exists ores_err_trace_events_repo_idx
  on public.ores_err_trace_events(repository, occurred_at desc) where repository is not null;
create index if not exists ores_err_trace_fingerprints_last_seen_idx
  on public.ores_err_trace_fingerprints(last_seen_at desc);

-- Supabase is PostgreSQL. Enable fail-closed RLS only when Supabase client roles exist;
-- generic PostgreSQL deployments keep their existing role model unchanged.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    alter table public.ores_err_trace_fingerprints enable row level security;
    alter table public.ores_err_trace_events enable row level security;
  end if;
end $$;

comment on table public.ores_err_trace_fingerprints is
  'Generated dedupe projection from ORESoftware/ores-err-trace peer TypeSpec + JSON Schema authorities.';
comment on table public.ores_err_trace_events is
  'Generated event projection from ORESoftware/ores-err-trace peer TypeSpec + JSON Schema authorities.';
