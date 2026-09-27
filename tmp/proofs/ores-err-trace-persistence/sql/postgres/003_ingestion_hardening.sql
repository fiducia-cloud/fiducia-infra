-- Harden the ingestion boundary without adding distributed locking to the hot path.
-- PostgreSQL remains the linearization point through UNIQUE + ON CONFLICT.

alter table public.error_tracking add column if not exists raw_event_sha256 text;
alter table public.error_tracking add column if not exists trace_ids jsonb not null default '[]'::jsonb;
alter table public.error_tracking add column if not exists release_shas jsonb not null default '[]'::jsonb;
alter table public.error_tracking add column if not exists environments jsonb not null default '[]'::jsonb;
alter table public.error_tracking add column if not exists repositories jsonb not null default '[]'::jsonb;
alter table public.error_tracking add column if not exists reopened_count bigint not null default 0;
alter table public.error_tracking add column if not exists last_reopened_at timestamptz;
alter table public.error_tracking add column if not exists triggered_notifs boolean not null default false;
alter table public.error_tracking add column if not exists resolved_info jsonb;

-- Keep the most recent unique values. The previous helper kept the oldest values,
-- which meant a full trace list could silently drop every new trace id.
create or replace function public.ores_err_trace_string_union_cap(a jsonb, b jsonb, cap integer)
returns jsonb
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(to_jsonb(value) order by last_ord), '[]'::jsonb)
  from (
    select value, max(ord) as last_ord
    from (
      select value #>> '{}' as value, ord
      from jsonb_array_elements(coalesce(a, '[]'::jsonb) || coalesce(b, '[]'::jsonb))
        with ordinality as e(value, ord)
      where jsonb_typeof(value) = 'string'
    ) flattened
    where value <> ''
    group by value
    order by last_ord desc
    limit greatest(cap, 0)
  ) newest;
$$;

create or replace function public.ores_err_trace_require_string_array(value jsonb, field_name text)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
begin
  if value is null then return '[]'::jsonb; end if;
  if jsonb_typeof(value) <> 'array' then
    raise exception '% must be a JSON array', field_name using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(value) item where jsonb_typeof(item) <> 'string') then
    raise exception '% must contain only strings', field_name using errcode = '22023';
  end if;
  return value;
end;
$$;

create or replace function public.ores_err_trace_require_object_array(value jsonb, field_name text)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
begin
  if value is null then return '[]'::jsonb; end if;
  if jsonb_typeof(value) <> 'array' then
    raise exception '% must be a JSON array', field_name using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(value) item where jsonb_typeof(item) <> 'object') then
    raise exception '% must contain only objects', field_name using errcode = '22023';
  end if;
  return value;
end;
$$;

create or replace function public.ores_err_trace_require_object(value jsonb, field_name text)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
begin
  if value is null then return '{}'::jsonb; end if;
  if jsonb_typeof(value) <> 'object' then
    raise exception '% must be a JSON object', field_name using errcode = '22023';
  end if;
  return value;
end;
$$;

create or replace function public.ores_err_trace_safe_integer(value text, field_name text, minimum_value integer, maximum_value integer, default_value integer)
returns integer
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare parsed bigint;
begin
  if value is null or btrim(value) = '' then return default_value; end if;
  if value !~ '^-?[0-9]+$' then
    raise exception '% must be an integer', field_name using errcode = '22023';
  end if;
  parsed := value::bigint;
  if parsed < minimum_value or parsed > maximum_value then
    raise exception '% is outside the admitted range', field_name using errcode = '22023';
  end if;
  return parsed::integer;
exception
  when numeric_value_out_of_range then
    raise exception '% is outside the admitted range', field_name using errcode = '22023';
end;
$$;

create or replace function public.ores_err_trace_safe_timestamptz(value text, field_name text)
returns timestamptz
language plpgsql
stable
set search_path = pg_catalog, public
as $$
begin
  if value is null or btrim(value) = '' then return null; end if;
  if length(value) > 128 then raise exception '% is too long', field_name using errcode = '22023'; end if;
  return value::timestamptz;
exception when others then
  raise exception '% must be a valid timestamp', field_name using errcode = '22023';
end;
$$;

create or replace function public.ores_err_trace_redact_object(value jsonb)
returns jsonb
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select coalesce(value, '{}'::jsonb) - array[
    'password','passwd','secret','token','access_token','refresh_token',
    'authorization','cookie','set-cookie','api_key','apikey','private_key'
  ]::text[];
$$;

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

-- Backfill bounded aggregate dimensions for rows created before this migration.
update public.error_tracking
set
  trace_ids = case when last_trace_id is null then trace_ids else public.ores_err_trace_string_union_cap(trace_ids, jsonb_build_array(last_trace_id), 200) end,
  release_shas = case when last_release_sha is null then release_shas else public.ores_err_trace_string_union_cap(release_shas, jsonb_build_array(last_release_sha), 100) end,
  environments = case when environment is null then environments else public.ores_err_trace_string_union_cap(environments, jsonb_build_array(environment), 32) end,
  repositories = case when repository is null then repositories else public.ores_err_trace_string_union_cap(repositories, jsonb_build_array(repository), 64) end;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'error_tracking_fingerprint_policy_check') then
    alter table public.error_tracking add constraint error_tracking_fingerprint_policy_check check (
      (fingerprint_version = 'v1' and fingerprint ~ '^[0-9a-f]{64}$') or
      (fingerprint_version = 'dd-next-compat-v2' and fingerprint ~ '^dd-next-compat-v2:[0-9a-f]{64}$')
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'error_tracking_service_length_check') then
    alter table public.error_tracking add constraint error_tracking_service_length_check check (length(service) between 1 and 256) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'error_tracking_priority_check') then
    alter table public.error_tracking add constraint error_tracking_priority_check check (priority_level between 1 and 5) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'error_tracking_json_shape_check') then
    alter table public.error_tracking add constraint error_tracking_json_shape_check check (
      jsonb_typeof(error_list) = 'array' and jsonb_typeof(event_data_list) = 'array' and
      jsonb_typeof(affected_users_info) = 'array' and jsonb_typeof(related_trace_ids) = 'array' and
      jsonb_typeof(tags) = 'array' and jsonb_typeof(meta) = 'object' and
      jsonb_typeof(provider_refs) = 'object' and jsonb_typeof(trace_ids) = 'array' and
      jsonb_typeof(release_shas) = 'array' and jsonb_typeof(environments) = 'array' and
      jsonb_typeof(repositories) = 'array' and (sample_event is null or jsonb_typeof(sample_event) = 'object') and
      (resolved_info is null or jsonb_typeof(resolved_info) = 'object')
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'error_tracking_raw_event_digest_check') then
    alter table public.error_tracking add constraint error_tracking_raw_event_digest_check check (
      raw_event_sha256 is null or raw_event_sha256 ~ '^[0-9a-f]{64}$'
    ) not valid;
  end if;
end $$;

create index if not exists error_tracking_unresolved_priority_idx
  on public.error_tracking(is_resolved, priority_level desc, last_seen_at desc);
create index if not exists error_tracking_environment_gin_idx on public.error_tracking using gin(environments);
create index if not exists error_tracking_trace_ids_gin_idx on public.error_tracking using gin(trace_ids);
