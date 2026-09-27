-- Preserve ORES parent-trace and native OpenTelemetry correlation through the
-- rich deduplicated error_tracking store. These identifiers describe an
-- occurrence and are deliberately not fingerprint inputs.

alter table public.error_tracking add column if not exists first_parent_trace_id text;
alter table public.error_tracking add column if not exists last_parent_trace_id text;
alter table public.error_tracking add column if not exists parent_trace_ids jsonb not null default '[]'::jsonb;
alter table public.error_tracking add column if not exists first_otel_trace_id text;
alter table public.error_tracking add column if not exists last_otel_trace_id text;
alter table public.error_tracking add column if not exists first_otel_span_id text;
alter table public.error_tracking add column if not exists last_otel_span_id text;
alter table public.error_tracking add column if not exists otel_trace_ids jsonb not null default '[]'::jsonb;
alter table public.error_tracking add column if not exists otel_contexts jsonb not null default '[]'::jsonb;

create or replace function public.ores_err_trace_safe_sample(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare extra jsonb;
declare base jsonb;
begin
  extra := public.ores_err_trace_require_object(event->'sample_event', 'sample_event');
  if octet_length(extra::text) > 16384 then
    raise exception 'sample_event exceeds 16 KiB' using errcode = '22023';
  end if;
  extra := public.ores_err_trace_redact_object(extra);
  base := jsonb_strip_nulls(jsonb_build_object(
    'service', event->>'service',
    'repository', coalesce(event->>'repository', event->>'repoName'),
    'environment', event->>'environment',
    'trace_id', coalesce(event->>'trace_id', event->>'traceId'),
    'parent_trace_id', coalesce(event->>'parent_trace_id', event->>'parentTraceId'),
    'otel_trace_id', coalesce(event->>'otel_trace_id', event->>'otelTraceId'),
    'otel_span_id', coalesce(event->>'otel_span_id', event->>'otelSpanId'),
    'release_sha', coalesce(event->>'release_sha', event->>'commitId'),
    'error_code', coalesce(event->>'error_code', event->>'errorCode'),
    'error_type', coalesce(event->>'error_type', event->>'errorType'),
    'severity', event->>'severity',
    'runtime', event->>'runtime',
    'source', event->>'source',
    'routine_id', coalesce(event->>'routine_id', event->>'routineId'),
    'file_name', coalesce(event->>'file_name', event->>'fileName')
  ));
  return extra || base;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'error_tracking_parent_trace_shape_check') then
    alter table public.error_tracking add constraint error_tracking_parent_trace_shape_check check (
      (first_parent_trace_id is null or first_parent_trace_id ~ '^ores-trace-[A-Za-z0-9_-]{12,64}$') and
      (last_parent_trace_id is null or last_parent_trace_id ~ '^ores-trace-[A-Za-z0-9_-]{12,64}$') and
      jsonb_typeof(parent_trace_ids) = 'array'
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'error_tracking_otel_shape_check') then
    alter table public.error_tracking add constraint error_tracking_otel_shape_check check (
      (first_otel_trace_id is null or first_otel_trace_id ~ '^[0-9a-f]{32}$') and
      (last_otel_trace_id is null or last_otel_trace_id ~ '^[0-9a-f]{32}$') and
      (first_otel_span_id is null or first_otel_span_id ~ '^[0-9a-f]{16}$') and
      (last_otel_span_id is null or last_otel_span_id ~ '^[0-9a-f]{16}$') and
      (first_otel_span_id is null or first_otel_trace_id is not null) and
      (last_otel_span_id is null or last_otel_trace_id is not null) and
      jsonb_typeof(otel_trace_ids) = 'array' and
      jsonb_typeof(otel_contexts) = 'array'
    ) not valid;
  end if;
end $$;

create index if not exists error_tracking_last_otel_trace_idx
  on public.error_tracking(last_otel_trace_id)
  where last_otel_trace_id is not null;
create index if not exists error_tracking_parent_trace_ids_gin_idx
  on public.error_tracking using gin(parent_trace_ids);
create index if not exists error_tracking_otel_trace_ids_gin_idx
  on public.error_tracking using gin(otel_trace_ids);
create index if not exists error_tracking_otel_contexts_gin_idx
  on public.error_tracking using gin(otel_contexts);

-- Replace the ingestion procedure so correlation metadata is validated and
-- retained without changing the unique-index/upsert linearization boundary.

create or replace function public.record_error_trace(event jsonb)
returns public.error_tracking
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  row_out public.error_tracking;
  event_version text;
  event_fingerprint text;
  event_service text;
  event_trace_id text;
  event_parent_trace_id text;
  event_otel_trace_id text;
  event_otel_span_id text;
  event_otel_context text;
  event_release text;
  event_repository text;
  event_environment text;
  event_error_list jsonb;
  event_data_list_value jsonb;
  affected_users_value jsonb;
  related_trace_ids_value jsonb;
  tags_value jsonb;
  meta_value jsonb;
  provider_refs_value jsonb;
  safe_sample jsonb;
  line_value integer;
  priority_value integer;
  ignore_value timestamptz;
  raw_digest text;
begin
  if event is null or jsonb_typeof(event) <> 'object' then
    raise exception 'event must be a JSON object' using errcode = '22023';
  end if;
  if octet_length(event::text) > 65536 then
    raise exception 'event exceeds 64 KiB ingestion limit' using errcode = '22023';
  end if;

  event_version := event->>'fingerprint_version';
  event_fingerprint := event->>'fingerprint';
  event_service := lower(regexp_replace(btrim(coalesce(event->>'service', '')), '[[:space:]]+', ' ', 'g'));
  event_trace_id := coalesce(event->>'trace_id', event->>'traceId');
  event_parent_trace_id := coalesce(event->>'parent_trace_id', event->>'parentTraceId');
  event_otel_trace_id := coalesce(event->>'otel_trace_id', event->>'otelTraceId');
  event_otel_span_id := coalesce(event->>'otel_span_id', event->>'otelSpanId');
  event_otel_context := case
    when event_otel_trace_id is null then null
    when event_otel_span_id is null then event_otel_trace_id
    else event_otel_trace_id || ':' || event_otel_span_id
  end;
  event_release := coalesce(event->>'release_sha', event->>'commitId');
  event_repository := coalesce(event->>'repository', event->>'repoName');
  event_environment := event->>'environment';

  if event_version not in ('v1', 'dd-next-compat-v2') then
    raise exception 'unsupported fingerprint_version' using errcode = '22023';
  end if;
  if event_version = 'v1' and coalesce(event_fingerprint, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'v1 fingerprint must be 64 lowercase hex characters' using errcode = '22023';
  end if;
  if event_version = 'dd-next-compat-v2' and coalesce(event_fingerprint, '') !~ '^dd-next-compat-v2:[0-9a-f]{64}$' then
    raise exception 'dd-next-compat-v2 fingerprint is malformed' using errcode = '22023';
  end if;
  if length(event_service) < 1 or length(event_service) > 256 then
    raise exception 'service must contain 1..256 characters' using errcode = '22023';
  end if;
  if event_trace_id is not null and length(event_trace_id) > 256 then
    raise exception 'trace_id exceeds 256 characters' using errcode = '22023';
  end if;
  if event_parent_trace_id is not null and event_parent_trace_id !~ '^ores-trace-[A-Za-z0-9_-]{12,64}$' then
    raise exception 'parent_trace_id is malformed' using errcode = '22023';
  end if;
  if event_otel_trace_id is not null and event_otel_trace_id !~ '^[0-9a-f]{32}$' then
    raise exception 'otel_trace_id must be 32 lowercase hex characters' using errcode = '22023';
  end if;
  if event_otel_span_id is not null and event_otel_span_id !~ '^[0-9a-f]{16}$' then
    raise exception 'otel_span_id must be 16 lowercase hex characters' using errcode = '22023';
  end if;
  if event_otel_span_id is not null and event_otel_trace_id is null then
    raise exception 'otel_span_id requires otel_trace_id' using errcode = '22023';
  end if;
  if event_release is not null and length(event_release) > 128 then
    raise exception 'release_sha exceeds 128 characters' using errcode = '22023';
  end if;

  event_error_list := public.ores_err_trace_require_string_array(coalesce(event->'error_list', event->'errorList'), 'error_list');
  event_data_list_value := public.ores_err_trace_require_object_array(coalesce(event->'event_data_list', event->'eventDataList'), 'event_data_list');
  affected_users_value := public.ores_err_trace_require_object_array(coalesce(event->'affected_users_info', event->'affectedUsersInfo'), 'affected_users_info');
  related_trace_ids_value := public.ores_err_trace_require_string_array(coalesce(event->'related_trace_ids', event->'relatedTraceIds'), 'related_trace_ids');
  tags_value := public.ores_err_trace_require_string_array(event->'tags', 'tags');
  meta_value := public.ores_err_trace_redact_object(public.ores_err_trace_require_object(event->'meta', 'meta'));
  provider_refs_value := public.ores_err_trace_require_object(event->'provider_refs', 'provider_refs');
  safe_sample := public.ores_err_trace_safe_sample(event);
  line_value := public.ores_err_trace_safe_integer(coalesce(event->>'line_number', event->>'lineNumber'), 'line_number', 0, 2147483647, null);
  priority_value := public.ores_err_trace_safe_integer(coalesce(event->>'priority_level', event->>'priorityLevel'), 'priority_level', 1, 5, 2);
  ignore_value := public.ores_err_trace_safe_timestamptz(coalesce(event->>'ignore_until', event->>'ignoreUntil'), 'ignore_until');
  raw_digest := encode(digest(event::text, 'sha256'), 'hex');

  insert into public.error_tracking (
    fingerprint_version, fingerprint, service, repository, environment,
    exception_type, normalized_message, normalized_top_frame, operation,
    severity, first_release_sha, last_release_sha, first_trace_id, last_trace_id,
    first_parent_trace_id, last_parent_trace_id,
    first_otel_trace_id, last_otel_trace_id, first_otel_span_id, last_otel_span_id,
    sample_event, provider_refs, routine_id, error_code, error_type,
    error_list, event_data_list, affected_users_info, related_trace_ids, tags, meta,
    file_name, line_number, priority_level, ignore_until, raw_event_sha256,
    trace_ids, parent_trace_ids, otel_trace_ids, otel_contexts,
    release_shas, environments, repositories
  ) values (
    event_version, event_fingerprint, event_service, event_repository, event_environment,
    event->>'exception_type', event->>'normalized_message', event->>'normalized_top_frame', event->>'operation',
    event->>'severity', event_release, event_release, event_trace_id, event_trace_id,
    event_parent_trace_id, event_parent_trace_id,
    event_otel_trace_id, event_otel_trace_id, event_otel_span_id, event_otel_span_id,
    safe_sample, provider_refs_value,
    coalesce(event->>'routine_id', event->>'routineId'),
    coalesce(event->>'error_code', event->>'errorCode'),
    coalesce(event->>'error_type', event->>'errorType'),
    event_error_list, event_data_list_value, affected_users_value, related_trace_ids_value, tags_value, meta_value,
    coalesce(event->>'file_name', event->>'fileName'),
    line_value, priority_value, ignore_value, raw_digest,
    case when event_trace_id is null then '[]'::jsonb else jsonb_build_array(event_trace_id) end,
    case when event_parent_trace_id is null then '[]'::jsonb else jsonb_build_array(event_parent_trace_id) end,
    case when event_otel_trace_id is null then '[]'::jsonb else jsonb_build_array(event_otel_trace_id) end,
    case when event_otel_context is null then '[]'::jsonb else jsonb_build_array(event_otel_context) end,
    case when event_release is null then '[]'::jsonb else jsonb_build_array(event_release) end,
    case when event_environment is null then '[]'::jsonb else jsonb_build_array(event_environment) end,
    case when event_repository is null then '[]'::jsonb else jsonb_build_array(event_repository) end
  )
  on conflict (fingerprint_version, fingerprint) do update set
    last_seen_at = now(),
    occurrence_count = public.error_tracking.occurrence_count + 1,
    first_release_sha = coalesce(public.error_tracking.first_release_sha, excluded.first_release_sha),
    last_release_sha = coalesce(excluded.last_release_sha, public.error_tracking.last_release_sha),
    first_trace_id = coalesce(public.error_tracking.first_trace_id, excluded.first_trace_id),
    last_trace_id = coalesce(excluded.last_trace_id, public.error_tracking.last_trace_id),
    first_parent_trace_id = coalesce(public.error_tracking.first_parent_trace_id, excluded.first_parent_trace_id),
    last_parent_trace_id = coalesce(excluded.last_parent_trace_id, public.error_tracking.last_parent_trace_id),
    first_otel_trace_id = coalesce(public.error_tracking.first_otel_trace_id, excluded.first_otel_trace_id),
    last_otel_trace_id = coalesce(excluded.last_otel_trace_id, public.error_tracking.last_otel_trace_id),
    first_otel_span_id = coalesce(public.error_tracking.first_otel_span_id, excluded.first_otel_span_id),
    last_otel_span_id = coalesce(excluded.last_otel_span_id, public.error_tracking.last_otel_span_id),
    trace_ids = public.ores_err_trace_string_union_cap(public.error_tracking.trace_ids, excluded.trace_ids, 200),
    parent_trace_ids = public.ores_err_trace_string_union_cap(public.error_tracking.parent_trace_ids, excluded.parent_trace_ids, 200),
    otel_trace_ids = public.ores_err_trace_string_union_cap(public.error_tracking.otel_trace_ids, excluded.otel_trace_ids, 200),
    otel_contexts = public.ores_err_trace_string_union_cap(public.error_tracking.otel_contexts, excluded.otel_contexts, 500),
    release_shas = public.ores_err_trace_string_union_cap(public.error_tracking.release_shas, excluded.release_shas, 100),
    environments = public.ores_err_trace_string_union_cap(public.error_tracking.environments, excluded.environments, 32),
    repositories = public.ores_err_trace_string_union_cap(public.error_tracking.repositories, excluded.repositories, 64),
    routine_id = coalesce(excluded.routine_id, public.error_tracking.routine_id),
    error_code = coalesce(excluded.error_code, public.error_tracking.error_code),
    error_type = coalesce(excluded.error_type, public.error_tracking.error_type),
    severity = coalesce(excluded.severity, public.error_tracking.severity),
    error_list = public.ores_err_trace_concat_cap(public.error_tracking.error_list, excluded.error_list, 200),
    event_data_list = public.ores_err_trace_concat_cap(public.error_tracking.event_data_list, excluded.event_data_list, 100),
    affected_users_info = public.ores_err_trace_concat_cap(public.error_tracking.affected_users_info, excluded.affected_users_info, 100),
    related_trace_ids = public.ores_err_trace_string_union_cap(public.error_tracking.related_trace_ids, excluded.related_trace_ids, 200),
    tags = public.ores_err_trace_string_union_cap(public.error_tracking.tags, excluded.tags, 200),
    meta = public.error_tracking.meta || excluded.meta,
    file_name = coalesce(excluded.file_name, public.error_tracking.file_name),
    line_number = coalesce(excluded.line_number, public.error_tracking.line_number),
    priority_level = greatest(public.error_tracking.priority_level, excluded.priority_level),
    ignore_until = case
      when public.error_tracking.ignore_until is null then excluded.ignore_until
      when excluded.ignore_until is null then public.error_tracking.ignore_until
      else greatest(public.error_tracking.ignore_until, excluded.ignore_until)
    end,
    reopened_count = public.error_tracking.reopened_count + case when public.error_tracking.is_resolved then 1 else 0 end,
    last_reopened_at = case when public.error_tracking.is_resolved then now() else public.error_tracking.last_reopened_at end,
    is_resolved = false,
    resolved_at = case when public.error_tracking.is_resolved then null else public.error_tracking.resolved_at end,
    resolved_by = case when public.error_tracking.is_resolved then null else public.error_tracking.resolved_by end,
    resolution_notes = case when public.error_tracking.is_resolved then null else public.error_tracking.resolution_notes end,
    resolved_info = case when public.error_tracking.is_resolved then null else public.error_tracking.resolved_info end,
    triggered_notifs = case when public.error_tracking.is_resolved then false else public.error_tracking.triggered_notifs end,
    sample_event = excluded.sample_event,
    raw_event_sha256 = excluded.raw_event_sha256,
    provider_refs = public.error_tracking.provider_refs || excluded.provider_refs
  returning * into row_out;

  return row_out;
end;
$$;
