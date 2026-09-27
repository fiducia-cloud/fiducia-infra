create extension if not exists pgcrypto;

create table if not exists error_tracking (
  id uuid primary key default gen_random_uuid(),
  fingerprint_version text not null,
  fingerprint text not null,
  service text not null,
  repository text,
  environment text,
  exception_type text,
  normalized_message text,
  normalized_top_frame text,
  operation text,
  severity text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrence_count bigint not null default 1,
  first_release_sha text,
  last_release_sha text,
  first_trace_id text,
  last_trace_id text,
  sample_event jsonb,
  provider_refs jsonb not null default '{}'::jsonb,
  status text not null default 'open',
  unique (fingerprint_version, fingerprint)
);

create index if not exists error_tracking_service_last_seen_idx
  on error_tracking(service, last_seen_at desc);
create index if not exists error_tracking_last_release_idx
  on error_tracking(last_release_sha);
create index if not exists error_tracking_last_trace_idx
  on error_tracking(last_trace_id);

create or replace function record_error_trace(event jsonb)
returns error_tracking
language plpgsql
security invoker
set search_path = public
as $$
declare
  row_out error_tracking;
begin
  if coalesce(event->>'fingerprint_version', '') = '' then
    raise exception 'fingerprint_version is required';
  end if;
  if coalesce(event->>'fingerprint', '') = '' then
    raise exception 'fingerprint is required';
  end if;
  if coalesce(event->>'service', '') = '' then
    raise exception 'service is required';
  end if;

  insert into error_tracking (
    fingerprint_version, fingerprint, service, repository, environment,
    exception_type, normalized_message, normalized_top_frame, operation,
    severity, first_release_sha, last_release_sha,
    first_trace_id, last_trace_id, sample_event, provider_refs
  ) values (
    event->>'fingerprint_version', event->>'fingerprint', event->>'service',
    event->>'repository', event->>'environment', event->>'exception_type',
    event->>'normalized_message', event->>'normalized_top_frame', event->>'operation',
    event->>'severity', event->>'release_sha', event->>'release_sha',
    event->>'trace_id', event->>'trace_id', event,
    coalesce(event->'provider_refs', '{}'::jsonb)
  )
  on conflict (fingerprint_version, fingerprint) do update set
    last_seen_at = now(),
    occurrence_count = error_tracking.occurrence_count + 1,
    last_release_sha = coalesce(excluded.last_release_sha, error_tracking.last_release_sha),
    last_trace_id = coalesce(excluded.last_trace_id, error_tracking.last_trace_id),
    severity = coalesce(excluded.severity, error_tracking.severity),
    sample_event = excluded.sample_event,
    provider_refs = error_tracking.provider_refs || excluded.provider_refs
  returning * into row_out;

  return row_out;
end;
$$;
