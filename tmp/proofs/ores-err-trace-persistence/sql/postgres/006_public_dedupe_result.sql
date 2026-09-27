-- Stable public result boundary for callers that should not couple to the
-- internal error_tracking table. record_error_trace() remains the internal
-- rich-row primitive; this wrapper projects the peer TypeSpec/JSON Schema
-- DedupeRecordResult contract exactly.

create or replace function public.record_error_trace_result(event jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  row_out public.error_tracking;
begin
  row_out := public.record_error_trace(event);

  return jsonb_build_object(
    'id', row_out.id::text,
    'policy', row_out.fingerprint_version,
    'fingerprint', row_out.fingerprint,
    'occurrence_count', row_out.occurrence_count,
    'inserted', row_out.occurrence_count = 1,
    'first_seen_at', row_out.first_seen_at,
    'last_seen_at', row_out.last_seen_at
  );
end;
$$;

comment on function public.record_error_trace_result(jsonb) is
  'Public ores-err-trace DedupeRecordResult projection; hides internal error_tracking columns.';
