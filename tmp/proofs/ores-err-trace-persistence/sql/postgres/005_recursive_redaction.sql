-- Redact common secret-bearing keys recursively and case-insensitively before
-- retaining optional sample/meta/context payloads.

create or replace function public.ores_err_trace_redact_json(value jsonb)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  out_value jsonb;
  key_name text;
  child jsonb;
begin
  if value is null then return null; end if;

  case jsonb_typeof(value)
    when 'object' then
      out_value := '{}'::jsonb;
      for key_name, child in select key, val from jsonb_each(value) as entry(key, val)
      loop
        if lower(key_name) = any(array[
          'password','passwd','secret','client_secret','token','session_token',
          'access_token','refresh_token','authorization','proxy-authorization',
          'cookie','set-cookie','api_key','apikey','x-api-key','private_key'
        ]::text[]) then
          out_value := out_value || jsonb_build_object(key_name, '<redacted>');
        else
          out_value := out_value || jsonb_build_object(key_name, public.ores_err_trace_redact_json(child));
        end if;
      end loop;
      return out_value;
    when 'array' then
      select coalesce(jsonb_agg(public.ores_err_trace_redact_json(item.value) order by item.ord), '[]'::jsonb)
        into out_value
      from jsonb_array_elements(value) with ordinality as item(value, ord);
      return out_value;
    else
      return value;
  end case;
end;
$$;

create or replace function public.ores_err_trace_redact_object(value jsonb)
returns jsonb
language sql
immutable
set search_path = pg_catalog, public
as $$
  select coalesce(public.ores_err_trace_redact_json(value), '{}'::jsonb);
$$;

-- These validators are also the structured-retention boundary. Once this
-- migration is installed, every object/object-array accepted by the ingestion
-- function is recursively redacted before persistence.
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
  return public.ores_err_trace_redact_json(value);
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
  return public.ores_err_trace_redact_json(value);
end;
$$;

-- Scrub structured values retained by earlier versions too. Error-message strings
-- remain producer-owned and must already be sanitized by ores-otel/application code.
update public.error_tracking
set
  sample_event = case when sample_event is null then null else public.ores_err_trace_redact_json(sample_event) end,
  event_data_list = public.ores_err_trace_redact_json(event_data_list),
  affected_users_info = public.ores_err_trace_redact_json(affected_users_info),
  meta = public.ores_err_trace_redact_json(meta),
  provider_refs = public.ores_err_trace_redact_json(provider_refs);
