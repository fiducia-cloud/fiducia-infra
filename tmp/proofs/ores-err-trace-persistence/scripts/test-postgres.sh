#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"

F1='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
F2='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

expect_fail() {
  local label="$1"
  local sql="$2"
  if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "$sql" >/dev/null 2>&1; then
    echo "expected failure succeeded: $label" >&2
    exit 1
  fi
}

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
truncate table error_tracking;

select (record_error_trace(jsonb_build_object(
  'fingerprint_version','v1',
  'fingerprint','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'service','  API   Service  ',
  'environment','prod',
  'repository','repo-a',
  'parent_trace_id','ores-trace-ParentTraceA12',
  'otel_trace_id','11111111111111111111111111111111',
  'otel_span_id','1111111111111111',
  'error_code','E_DB',
  'error_type','database',
  'tags',jsonb_build_array('first'),
  'related_trace_ids',jsonb_build_array('r1'),
  'error_list',jsonb_build_array('one'),
  'event_data_list',jsonb_build_array(jsonb_build_object('attempt',1)),
  'meta',jsonb_build_object('source','first')
))).id;

select (record_error_trace(jsonb_build_object(
  'fingerprint_version','v1',
  'fingerprint','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'service','api service',
  'environment','prod',
  'repository','repo-a',
  'trace_id','ores-trace-b',
  'parent_trace_id','ores-trace-ParentTraceB12',
  'otel_trace_id','22222222222222222222222222222222',
  'otel_span_id','2222222222222222',
  'release_sha','bbbbbbbb',
  'priority_level',3,
  'tags',jsonb_build_array('second'),
  'related_trace_ids',jsonb_build_array('r2','r1'),
  'error_list',jsonb_build_array('two'),
  'event_data_list',jsonb_build_array(jsonb_build_object(
    'attempt',2,
    'credentials',jsonb_build_object('client_secret','do-not-store')
  )),
  'affected_users_info',jsonb_build_array(jsonb_build_object(
    'loggedInUser','u1',
    'token','do-not-store'
  )),
  'provider_refs',jsonb_build_object('cloudwatch','group-a','api_key','do-not-store'),
  'meta',jsonb_build_object('last','second','Authorization','top-secret'),
  'sample_event',jsonb_build_object(
    'note','safe',
    'PASSWORD','do-not-store',
    'nested',jsonb_build_object('access_token','do-not-store-either')
  )
))).id;

do $$
declare r error_tracking;
begin
  select * into strict r from error_tracking
    where fingerprint_version='v1'
      and fingerprint='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  if r.service <> 'api service' then raise exception 'service was not normalized'; end if;
  if r.occurrence_count <> 2 then raise exception 'expected occurrence_count=2, got %', r.occurrence_count; end if;
  if r.first_trace_id <> 'ores-trace-b' or r.last_trace_id <> 'ores-trace-b' then raise exception 'first non-null trace was not retained'; end if;
  if r.first_parent_trace_id <> 'ores-trace-ParentTraceA12' or r.last_parent_trace_id <> 'ores-trace-ParentTraceB12' then raise exception 'parent trace first/last mismatch'; end if;
  if r.first_otel_trace_id <> '11111111111111111111111111111111' or r.last_otel_trace_id <> '22222222222222222222222222222222' then raise exception 'OTel trace first/last mismatch'; end if;
  if r.first_otel_span_id <> '1111111111111111' or r.last_otel_span_id <> '2222222222222222' then raise exception 'OTel span first/last mismatch'; end if;
  if r.first_release_sha <> 'bbbbbbbb' or r.last_release_sha <> 'bbbbbbbb' then raise exception 'first non-null release was not retained'; end if;
  if jsonb_array_length(r.trace_ids) <> 1 or not (r.trace_ids ? 'ores-trace-b') then raise exception 'trace aggregate mismatch'; end if;
  if jsonb_array_length(r.parent_trace_ids) <> 2 or not (r.parent_trace_ids ? 'ores-trace-ParentTraceA12' and r.parent_trace_ids ? 'ores-trace-ParentTraceB12') then raise exception 'parent trace aggregate mismatch'; end if;
  if jsonb_array_length(r.otel_trace_ids) <> 2 or not (r.otel_trace_ids ? '11111111111111111111111111111111' and r.otel_trace_ids ? '22222222222222222222222222222222') then raise exception 'OTel trace aggregate mismatch'; end if;
  if jsonb_array_length(r.otel_contexts) <> 2 or not (r.otel_contexts ? '11111111111111111111111111111111:1111111111111111' and r.otel_contexts ? '22222222222222222222222222222222:2222222222222222') then raise exception 'OTel context aggregate mismatch'; end if;
  if r.sample_event->>'parent_trace_id' <> 'ores-trace-ParentTraceB12' then raise exception 'parent trace missing from safe sample'; end if;
  if r.sample_event->>'otel_trace_id' <> '22222222222222222222222222222222' then raise exception 'OTel trace missing from safe sample'; end if;
  if r.sample_event->>'otel_span_id' <> '2222222222222222' then raise exception 'OTel span missing from safe sample'; end if;
  if jsonb_array_length(r.release_shas) <> 1 or not (r.release_shas ? 'bbbbbbbb') then raise exception 'release aggregate mismatch'; end if;
  if not (r.tags ? 'first' and r.tags ? 'second') then raise exception 'tags were not unioned'; end if;
  if jsonb_array_length(r.related_trace_ids) <> 2 then raise exception 'related trace IDs were not deduped'; end if;
  if jsonb_array_length(r.error_list) <> 2 then raise exception 'error list did not accumulate'; end if;
  if r.meta->>'source' <> 'first' or r.meta->>'last' <> 'second' then raise exception 'meta was not merged'; end if;
  if r.meta->>'Authorization' <> '<redacted>' then raise exception 'secret-bearing meta value was not redacted'; end if;
  if r.event_data_list#>>'{1,credentials,client_secret}' <> '<redacted>' then raise exception 'event-data secret was not redacted'; end if;
  if r.affected_users_info#>>'{0,token}' <> '<redacted>' then raise exception 'affected-user secret was not redacted'; end if;
  if r.provider_refs->>'api_key' <> '<redacted>' then raise exception 'provider-ref secret was not redacted'; end if;
  if r.sample_event->>'PASSWORD' <> '<redacted>' then raise exception 'sample password was not redacted'; end if;
  if r.sample_event#>>'{nested,access_token}' <> '<redacted>' then raise exception 'nested sample token was not redacted'; end if;
  if r.sample_event->>'note' <> 'safe' then raise exception 'safe sample value was lost'; end if;
  if r.raw_event_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'normalized event digest missing'; end if;
end $$;

-- Mark the incident resolved, preserving prior resolution history, then prove a
-- recurrence atomically reopens it without deleting that historical evidence.
update error_tracking
set is_resolved=true,
    resolved_at=now(),
    resolved_by='agent-a',
    resolution_notes='fixed once',
    resolved_info='{"agentType":"ai-agent","agentName":"agent-a"}'::jsonb,
    resolution_history='[{"resolvedBy":"agent-a","resolvedAt":"2026-09-15T12:00:00Z"}]'::jsonb,
    triggered_notifs=true
where fingerprint='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

select (record_error_trace(jsonb_build_object(
  'fingerprint_version','v1',
  'fingerprint','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'service','api service',
  'environment','stage',
  'repository','repo-b',
  'trace_id','ores-trace-c',
  'parent_trace_id','ores-trace-ParentTraceC12',
  'otel_trace_id','33333333333333333333333333333333',
  'otel_span_id','3333333333333333',
  'release_sha','cccccccc',
  'priority_level',5
))).id;

do $$
declare r error_tracking;
begin
  select * into strict r from error_tracking where fingerprint='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  if r.occurrence_count <> 3 then raise exception 'reopen occurrence was not counted'; end if;
  if r.is_resolved then raise exception 'recurrence did not reopen resolved fingerprint'; end if;
  if r.reopened_count <> 1 or r.last_reopened_at is null then raise exception 'reopen metadata missing'; end if;
  if r.resolved_at is not null or r.resolved_by is not null or r.resolved_info is not null then raise exception 'current resolution state was not cleared'; end if;
  if jsonb_array_length(r.resolution_history) <> 1 then raise exception 'resolution history was lost'; end if;
  if r.triggered_notifs then raise exception 'notification latch was not reset on reopen'; end if;
  if r.priority_level <> 5 then raise exception 'higher recurrence priority was not retained'; end if;
  if not (r.trace_ids ? 'ores-trace-b' and r.trace_ids ? 'ores-trace-c') then raise exception 'trace history did not aggregate'; end if;
  if jsonb_array_length(r.parent_trace_ids) <> 3 or not (r.parent_trace_ids ? 'ores-trace-ParentTraceC12') then raise exception 'parent trace history did not aggregate'; end if;
  if jsonb_array_length(r.otel_trace_ids) <> 3 or not (r.otel_trace_ids ? '33333333333333333333333333333333') then raise exception 'OTel trace history did not aggregate'; end if;
  if jsonb_array_length(r.otel_contexts) <> 3 or not (r.otel_contexts ? '33333333333333333333333333333333:3333333333333333') then raise exception 'OTel context history did not aggregate'; end if;
  if r.last_otel_trace_id <> '33333333333333333333333333333333' or r.last_otel_span_id <> '3333333333333333' then raise exception 'latest OTel context did not advance'; end if;
  if not (r.release_shas ? 'bbbbbbbb' and r.release_shas ? 'cccccccc') then raise exception 'release history did not aggregate'; end if;
  if not (r.environments ? 'prod' and r.environments ? 'stage') then raise exception 'environment history did not aggregate'; end if;
  if not (r.repositories ? 'repo-a' and r.repositories ? 'repo-b') then raise exception 'repository history did not aggregate'; end if;
end $$;

-- A bounded union must preserve the newest unique values rather than freezing
-- after the first cap entries.
do $$
declare got jsonb;
begin
  got := ores_err_trace_string_union_cap('["a","b","c"]'::jsonb, '["d","c"]'::jsonb, 3);
  if got <> '["b","d","c"]'::jsonb then
    raise exception 'newest capped union mismatch: %', got;
  end if;
end $$;
SQL

# Prove UNIQUE + ON CONFLICT, not an application/distributed lock, linearizes 16 writers.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'truncate table error_tracking' >/dev/null
for i in $(seq 1 16); do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "select (record_error_trace(jsonb_build_object('fingerprint_version','v1','fingerprint','${F2}','service','api','trace_id','ores-trace-${i}'))).id" >/dev/null &
done
wait
result="$(psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "select (select count(*) from error_tracking where fingerprint='${F2}')::text || ':' || occurrence_count::text || ':' || jsonb_array_length(trace_ids)::text from error_tracking where fingerprint='${F2}'")"
[[ "$result" == "1:16:16" ]] || { echo "concurrent dedupe failed: $result" >&2; exit 1; }

expect_fail 'empty event' "select record_error_trace('{}'::jsonb)"
expect_fail 'malformed fingerprint' "select record_error_trace('{\"fingerprint_version\":\"v1\",\"fingerprint\":\"nope\",\"service\":\"api\"}'::jsonb)"
expect_fail 'unsupported fingerprint version' "select record_error_trace('{\"fingerprint_version\":\"v9\",\"fingerprint\":\"${F1}\",\"service\":\"api\"}'::jsonb)"
expect_fail 'tags wrong JSON shape' "select record_error_trace('{\"fingerprint_version\":\"v1\",\"fingerprint\":\"${F1}\",\"service\":\"api\",\"tags\":{}}'::jsonb)"
expect_fail 'event data wrong element shape' "select record_error_trace('{\"fingerprint_version\":\"v1\",\"fingerprint\":\"${F1}\",\"service\":\"api\",\"event_data_list\":[\"bad\"]}'::jsonb)"
expect_fail 'priority out of range' "select record_error_trace('{\"fingerprint_version\":\"v1\",\"fingerprint\":\"${F1}\",\"service\":\"api\",\"priority_level\":9}'::jsonb)"
expect_fail 'sample event wrong shape' "select record_error_trace('{\"fingerprint_version\":\"v1\",\"fingerprint\":\"${F1}\",\"service\":\"api\",\"sample_event\":[]}'::jsonb)"
expect_fail 'malformed parent trace id' "select record_error_trace('{\"fingerprint_version\":\"v1\",\"fingerprint\":\"${F1}\",\"service\":\"api\",\"parent_trace_id\":\"bad\"}'::jsonb)"
expect_fail 'malformed OTel trace id' "select record_error_trace('{\"fingerprint_version\":\"v1\",\"fingerprint\":\"${F1}\",\"service\":\"api\",\"otel_trace_id\":\"not-hex\"}'::jsonb)"
expect_fail 'malformed OTel span id' "select record_error_trace('{\"fingerprint_version\":\"v1\",\"fingerprint\":\"${F1}\",\"service\":\"api\",\"otel_trace_id\":\"11111111111111111111111111111111\",\"otel_span_id\":\"short\"}'::jsonb)"
expect_fail 'orphan OTel span id' "select record_error_trace('{\"fingerprint_version\":\"v1\",\"fingerprint\":\"${F1}\",\"service\":\"api\",\"otel_span_id\":\"1111111111111111\"}'::jsonb)"
expect_fail 'oversized event' "select record_error_trace(jsonb_build_object('fingerprint_version','v1','fingerprint','${F1}','service','api','message',repeat('x',70000)))"

echo 'postgres ingestion, recurrence, privacy, OTel correlation, and atomic dedupe tests passed'
