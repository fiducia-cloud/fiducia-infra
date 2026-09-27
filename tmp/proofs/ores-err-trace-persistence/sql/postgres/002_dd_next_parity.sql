-- Recurrence/context fields retained from dancing-dragons/dd-next-1 while
-- preserving ORE's atomic UNIQUE + ON CONFLICT hot path.

alter table error_tracking add column if not exists routine_id text;
alter table error_tracking add column if not exists error_code text;
alter table error_tracking add column if not exists error_type text;
alter table error_tracking add column if not exists error_list jsonb not null default '[]'::jsonb;
alter table error_tracking add column if not exists event_data_list jsonb not null default '[]'::jsonb;
alter table error_tracking add column if not exists affected_users_info jsonb not null default '[]'::jsonb;
alter table error_tracking add column if not exists related_trace_ids jsonb not null default '[]'::jsonb;
alter table error_tracking add column if not exists tags jsonb not null default '[]'::jsonb;
alter table error_tracking add column if not exists meta jsonb not null default '{}'::jsonb;
alter table error_tracking add column if not exists file_name text;
alter table error_tracking add column if not exists line_number integer;
alter table error_tracking add column if not exists priority_level integer not null default 2;
alter table error_tracking add column if not exists ignore_until timestamptz;
alter table error_tracking add column if not exists is_resolved boolean not null default false;
alter table error_tracking add column if not exists resolved_at timestamptz;
alter table error_tracking add column if not exists resolved_by text;
alter table error_tracking add column if not exists resolution_notes text;
alter table error_tracking add column if not exists resolution_history jsonb not null default '[]'::jsonb;

create index if not exists error_tracking_routine_idx on error_tracking(routine_id);
create index if not exists error_tracking_code_idx on error_tracking(error_code);
create index if not exists error_tracking_resolution_idx on error_tracking(is_resolved, last_seen_at desc);

create or replace function ores_err_trace_concat_cap(a jsonb, b jsonb, cap integer)
returns jsonb
language sql
immutable
parallel safe
as $$
  select coalesce(jsonb_agg(value order by ord), '[]'::jsonb)
  from (
    select value, ord
    from jsonb_array_elements(coalesce(a, '[]'::jsonb) || coalesce(b, '[]'::jsonb))
      with ordinality as e(value, ord)
    order by ord desc
    limit greatest(cap, 0)
  ) kept;
$$;

create or replace function ores_err_trace_string_union_cap(a jsonb, b jsonb, cap integer)
returns jsonb
language sql
immutable
parallel safe
as $$
  select coalesce(jsonb_agg(to_jsonb(value) order by first_ord), '[]'::jsonb)
  from (
    select value, min(ord) as first_ord
    from (
      select trim(both '"' from value::text) as value, ord
      from jsonb_array_elements(coalesce(a, '[]'::jsonb) || coalesce(b, '[]'::jsonb))
        with ordinality as e(value, ord)
    ) flattened
    where value <> ''
    group by value
    order by first_ord
    limit greatest(cap, 0)
  ) uniq;
$$;

create or replace function record_error_trace(event jsonb)
returns error_tracking
language plpgsql
security invoker
set search_path = public
as $$
declare
  row_out error_tracking;
  event_trace_id text := coalesce(event->>'trace_id', event->>'traceId');
  event_release text := coalesce(event->>'release_sha', event->>'commitId');
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
    severity, first_release_sha, last_release_sha, first_trace_id, last_trace_id,
    sample_event, provider_refs, routine_id, error_code, error_type,
    error_list, event_data_list, affected_users_info, related_trace_ids, tags, meta,
    file_name, line_number, priority_level, ignore_until
  ) values (
    event->>'fingerprint_version', event->>'fingerprint', event->>'service',
    coalesce(event->>'repository', event->>'repoName'), event->>'environment',
    event->>'exception_type', event->>'normalized_message', event->>'normalized_top_frame', event->>'operation',
    event->>'severity', event_release, event_release, event_trace_id, event_trace_id,
    event, coalesce(event->'provider_refs', '{}'::jsonb),
    coalesce(event->>'routine_id', event->>'routineId'),
    coalesce(event->>'error_code', event->>'errorCode'),
    coalesce(event->>'error_type', event->>'errorType'),
    coalesce(event->'error_list', event->'errorList', '[]'::jsonb),
    coalesce(event->'event_data_list', event->'eventDataList', '[]'::jsonb),
    coalesce(event->'affected_users_info', event->'affectedUsersInfo', '[]'::jsonb),
    coalesce(event->'related_trace_ids', event->'relatedTraceIds', '[]'::jsonb),
    coalesce(event->'tags', '[]'::jsonb), coalesce(event->'meta', '{}'::jsonb),
    coalesce(event->>'file_name', event->>'fileName'),
    nullif(coalesce(event->>'line_number', event->>'lineNumber'), '')::integer,
    coalesce(nullif(event->>'priority_level', '')::integer, nullif(event->>'priorityLevel', '')::integer, 2),
    nullif(coalesce(event->>'ignore_until', event->>'ignoreUntil'), '')::timestamptz
  )
  on conflict (fingerprint_version, fingerprint) do update set
    last_seen_at = now(),
    occurrence_count = error_tracking.occurrence_count + 1,
    last_release_sha = coalesce(excluded.last_release_sha, error_tracking.last_release_sha),
    last_trace_id = coalesce(excluded.last_trace_id, error_tracking.last_trace_id),
    routine_id = coalesce(excluded.routine_id, error_tracking.routine_id),
    error_code = coalesce(excluded.error_code, error_tracking.error_code),
    error_type = coalesce(excluded.error_type, error_tracking.error_type),
    severity = coalesce(excluded.severity, error_tracking.severity),
    error_list = ores_err_trace_concat_cap(error_tracking.error_list, excluded.error_list, 200),
    event_data_list = ores_err_trace_concat_cap(error_tracking.event_data_list, excluded.event_data_list, 100),
    affected_users_info = ores_err_trace_concat_cap(error_tracking.affected_users_info, excluded.affected_users_info, 100),
    related_trace_ids = ores_err_trace_string_union_cap(error_tracking.related_trace_ids, excluded.related_trace_ids, 200),
    tags = ores_err_trace_string_union_cap(error_tracking.tags, excluded.tags, 200),
    meta = error_tracking.meta || excluded.meta,
    file_name = coalesce(excluded.file_name, error_tracking.file_name),
    line_number = coalesce(excluded.line_number, error_tracking.line_number),
    priority_level = greatest(error_tracking.priority_level, excluded.priority_level),
    sample_event = excluded.sample_event,
    provider_refs = error_tracking.provider_refs || excluded.provider_refs
  returning * into row_out;

  return row_out;
end;
$$;
