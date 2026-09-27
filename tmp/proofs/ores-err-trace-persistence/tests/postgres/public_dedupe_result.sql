\set ON_ERROR_STOP on

truncate table public.error_tracking;

do $$
declare
  result jsonb;
  key_count integer;
begin
  result := public.record_error_trace_result(jsonb_build_object(
    'fingerprint_version','v1',
    'fingerprint','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'service','api',
    'trace_id','ores-trace-public-result'
  ));

  select count(*) into key_count from jsonb_object_keys(result);
  if key_count <> 7 then
    raise exception 'DedupeRecordResult must expose exactly 7 keys, got %: %', key_count, result;
  end if;
  if result->>'policy' <> 'v1' then raise exception 'policy mismatch: %', result; end if;
  if result->>'fingerprint' <> 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' then raise exception 'fingerprint mismatch'; end if;
  if (result->>'occurrence_count')::bigint <> 1 then raise exception 'initial occurrence count mismatch'; end if;
  if (result->>'inserted')::boolean is not true then raise exception 'first public result must report inserted=true'; end if;
  if coalesce(result->>'id','') = '' then raise exception 'public result id missing'; end if;
  if coalesce(result->>'first_seen_at','') = '' or coalesce(result->>'last_seen_at','') = '' then raise exception 'public result timestamps missing'; end if;
  if result ? 'service' or result ? 'sample_event' or result ? 'provider_refs' or result ? 'meta' then
    raise exception 'public result leaked internal error_tracking fields: %', result;
  end if;

  result := public.record_error_trace_result(jsonb_build_object(
    'fingerprint_version','v1',
    'fingerprint','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'service','api',
    'trace_id','ores-trace-public-result-2'
  ));
  if (result->>'occurrence_count')::bigint <> 2 then raise exception 'recurrence count mismatch'; end if;
  if (result->>'inserted')::boolean is not false then raise exception 'recurrence must report inserted=false'; end if;
end $$;
