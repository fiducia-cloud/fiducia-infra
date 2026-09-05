\set ON_ERROR_STOP on

DROP ROLE IF EXISTS fiducia_contract_test;
CREATE ROLE fiducia_contract_test NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA fiducia_commercial TO fiducia_contract_test;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA fiducia_commercial TO fiducia_contract_test;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA fiducia_commercial TO fiducia_contract_test;

BEGIN;
SET LOCAL ROLE fiducia_contract_test;
SET LOCAL app.tenant_id = 'tenant_a';

DO $$
BEGIN
  IF fiducia_commercial.current_tenant_id() IS DISTINCT FROM 'tenant_a' THEN
    RAISE EXCEPTION 'tenant context was not propagated';
  END IF;
END;
$$;

INSERT INTO fiducia_commercial.organizations (
  tenant_id,
  organization_id,
  legal_name_ciphertext,
  website_hostname,
  jurisdiction,
  entity_type
) VALUES (
  'tenant_a',
  'org_01J7FQ2M9A4K8D3N6P0R',
  'ciphertext:example-organization',
  'example.com',
  'US',
  'corporation'
);

INSERT INTO fiducia_commercial.contacts (
  tenant_id,
  contact_id,
  full_name_ciphertext,
  work_email_ciphertext,
  work_email_lookup_hash,
  title_ciphertext,
  preferred_language,
  time_zone
) VALUES (
  'tenant_a',
  'ctc_01J7FQ2M9A4K8D3N6P0R',
  'ciphertext:example-name',
  'ciphertext:example-email',
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'ciphertext:example-title',
  'en-US',
  'America/New_York'
);

DO $$
DECLARE
  visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count
  FROM fiducia_commercial.organizations;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'tenant_a expected one organization, observed %', visible_count;
  END IF;
END;
$$;

SET LOCAL app.tenant_id = 'tenant_b';

DO $$
DECLARE
  visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count
  FROM fiducia_commercial.organizations;
  IF visible_count <> 0 THEN
    RAISE EXCEPTION 'tenant_b observed tenant_a rows';
  END IF;

  BEGIN
    INSERT INTO fiducia_commercial.organizations (
      tenant_id,
      organization_id,
      legal_name_ciphertext,
      website_hostname,
      jurisdiction,
      entity_type
    ) VALUES (
      'tenant_a',
      'org_01J7FQ2M9A4K8D3N6P1S',
      'ciphertext:cross-tenant-attempt',
      'example.com',
      'US',
      'corporation'
    );
    RAISE EXCEPTION 'cross-tenant insert unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END;
$$;

SET LOCAL app.tenant_id = 'tenant_a';

INSERT INTO fiducia_commercial.applications (
  tenant_id,
  application_id,
  organization_id,
  current_version,
  current_status,
  current_etag
) VALUES (
  'tenant_a',
  'app_01J7FQ2M9A4K8D3N6P0R',
  'org_01J7FQ2M9A4K8D3N6P0R',
  1,
  'application_draft',
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
);

INSERT INTO fiducia_commercial.application_versions (
  tenant_id,
  application_id,
  version,
  status,
  document_ciphertext,
  content_sha256,
  created_by_contact_id,
  created_by_subject_hash
) VALUES (
  'tenant_a',
  'app_01J7FQ2M9A4K8D3N6P0R',
  1,
  'application_draft',
  '{"ciphertext":"example"}'::jsonb,
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ctc_01J7FQ2M9A4K8D3N6P0R',
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
);

DO $$
BEGIN
  BEGIN
    UPDATE fiducia_commercial.application_versions
    SET status = 'application_submitted'
    WHERE tenant_id = 'tenant_a'
      AND application_id = 'app_01J7FQ2M9A4K8D3N6P0R'
      AND version = 1;
    RAISE EXCEPTION 'append-only application version unexpectedly changed';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN
      NULL;
  END;
END;
$$;

INSERT INTO fiducia_commercial.workflow_events (
  tenant_id,
  event_id,
  aggregate_type,
  aggregate_id,
  sequence,
  from_state,
  to_state,
  reason_code,
  actor_type,
  actor_subject_hash,
  request_id,
  idempotency_key_hash,
  after_version
) VALUES (
  'tenant_a',
  'evt_01J7FQ2M9A4K8D3N6P0R',
  'commercial_case',
  'case_01J7FQ2M9A4K8D3N6P0R',
  1,
  NULL,
  'interest_draft',
  'case-created',
  'system',
  'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  'req_01J7FQ2M9A4K8D3N6P0R',
  'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  1
);

INSERT INTO fiducia_commercial.workflow_events (
  tenant_id,
  event_id,
  aggregate_type,
  aggregate_id,
  sequence,
  from_state,
  to_state,
  reason_code,
  actor_type,
  actor_subject_hash,
  request_id,
  idempotency_key_hash,
  before_version,
  after_version
) VALUES (
  'tenant_a',
  'evt_01J7FQ2M9A4K8D3N6P1S',
  'commercial_case',
  'case_01J7FQ2M9A4K8D3N6P0R',
  2,
  'interest_draft',
  'email_verification_pending',
  'verification-requested',
  'service',
  'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  'req_01J7FQ2M9A4K8D3N6P1S',
  'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  1,
  2
);

DO $$
BEGIN
  BEGIN
    INSERT INTO fiducia_commercial.workflow_events (
      tenant_id,
      event_id,
      aggregate_type,
      aggregate_id,
      sequence,
      from_state,
      to_state,
      reason_code,
      actor_type,
      actor_subject_hash,
      request_id,
      idempotency_key_hash,
      before_version,
      after_version
    ) VALUES (
      'tenant_a',
      'evt_01J7FQ2M9A4K8D3N6P2T',
      'commercial_case',
      'case_01J7FQ2M9A4K8D3N6P0R',
      3,
      'interest_draft',
      'active',
      'invalid-shortcut',
      'system',
      'sha256:3333333333333333333333333333333333333333333333333333333333333333',
      'req_01J7FQ2M9A4K8D3N6P2T',
      'sha256:4444444444444444444444444444444444444444444444444444444444444444',
      2,
      3
    );
    RAISE EXCEPTION 'invalid workflow transition unexpectedly succeeded';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;
END;
$$;

INSERT INTO fiducia_commercial.idempotency_records (
  tenant_id,
  scope,
  idempotency_key_hash,
  request_sha256,
  state,
  expires_at
) VALUES (
  'tenant_a',
  'POST /v1/applications',
  'sha256:5555555555555555555555555555555555555555555555555555555555555555',
  'sha256:6666666666666666666666666666666666666666666666666666666666666666',
  'processing',
  clock_timestamp() + interval '24 hours'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO fiducia_commercial.idempotency_records (
      tenant_id,
      scope,
      idempotency_key_hash,
      request_sha256,
      state,
      expires_at
    ) VALUES (
      'tenant_a',
      'POST /v1/applications',
      'sha256:5555555555555555555555555555555555555555555555555555555555555555',
      'sha256:7777777777777777777777777777777777777777777777777777777777777777',
      'processing',
      clock_timestamp() + interval '24 hours'
    );
    RAISE EXCEPTION 'duplicate idempotency key unexpectedly succeeded';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;
END;
$$;

ROLLBACK;
