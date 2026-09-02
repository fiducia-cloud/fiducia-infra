BEGIN;

CREATE SCHEMA IF NOT EXISTS fiducia_commercial;

CREATE OR REPLACE FUNCTION fiducia_commercial.current_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '');
$$;

CREATE OR REPLACE FUNCTION fiducia_commercial.reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = format('%I.%I is append-only; create a superseding version or event', TG_TABLE_SCHEMA, TG_TABLE_NAME);
END;
$$;

CREATE TABLE IF NOT EXISTS fiducia_commercial.organizations (
  tenant_id text NOT NULL,
  organization_id text NOT NULL CHECK (organization_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  legal_name_ciphertext text NOT NULL,
  website_hostname text NOT NULL CHECK (length(website_hostname) BETWEEN 1 AND 253),
  jurisdiction char(2) NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  entity_type text NOT NULL CHECK (entity_type IN (
    'corporation', 'llc', 'partnership', 'nonprofit', 'government',
    'educational', 'sole_proprietorship', 'other'
  )),
  lifecycle_status text NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'inactive', 'redacted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, organization_id)
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.contacts (
  tenant_id text NOT NULL,
  contact_id text NOT NULL CHECK (contact_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  full_name_ciphertext text NOT NULL,
  work_email_ciphertext text NOT NULL,
  work_email_lookup_hash text NOT NULL CHECK (work_email_lookup_hash ~ '^sha256:[0-9a-f]{64}$'),
  title_ciphertext text NOT NULL,
  preferred_language text NOT NULL CHECK (length(preferred_language) BETWEEN 2 AND 35),
  time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 100),
  lifecycle_status text NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'inactive', 'redacted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, contact_id),
  UNIQUE (tenant_id, work_email_lookup_hash)
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.organization_contact_roles (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  contact_id text NOT NULL,
  role text NOT NULL CHECK (role IN (
    'requester', 'business_owner', 'technical_owner', 'security_owner',
    'legal_owner', 'procurement_owner', 'billing_owner',
    'executive_sponsor', 'signer'
  )),
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz,
  PRIMARY KEY (tenant_id, organization_id, contact_id, role, valid_from),
  FOREIGN KEY (tenant_id, organization_id)
    REFERENCES fiducia_commercial.organizations (tenant_id, organization_id),
  FOREIGN KEY (tenant_id, contact_id)
    REFERENCES fiducia_commercial.contacts (tenant_id, contact_id),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.pre_interest_registrations (
  tenant_id text NOT NULL,
  submission_id text NOT NULL CHECK (submission_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  organization_id text NOT NULL,
  requester_contact_id text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'interest_draft', 'email_verification_pending', 'interest_verified',
    'qualified', 'needs_information', 'declined', 'withdrawn', 'expired'
  )),
  schema_version text NOT NULL DEFAULT 'fiducia.pre-interest.v1',
  document_ciphertext jsonb NOT NULL CHECK (jsonb_typeof(document_ciphertext) = 'object'),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  consent_version text NOT NULL CHECK (length(consent_version) BETWEEN 1 AND 100),
  privacy_policy_version text NOT NULL CHECK (length(privacy_policy_version) BETWEEN 1 AND 100),
  email_verified_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, submission_id),
  FOREIGN KEY (tenant_id, organization_id)
    REFERENCES fiducia_commercial.organizations (tenant_id, organization_id),
  FOREIGN KEY (tenant_id, requester_contact_id)
    REFERENCES fiducia_commercial.contacts (tenant_id, contact_id),
  CHECK (expires_at > created_at)
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.applications (
  tenant_id text NOT NULL,
  application_id text NOT NULL CHECK (application_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  organization_id text NOT NULL,
  originating_submission_id text,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  current_status text NOT NULL CHECK (current_status IN (
    'application_draft', 'application_submitted', 'needs_information',
    'security_review', 'solution_design', 'pricing_review', 'quote_issued',
    'legal_procurement', 'signed', 'provisioning', 'active', 'withdrawn',
    'expired', 'declined', 'superseded'
  )),
  current_etag text NOT NULL CHECK (current_etag ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, application_id),
  FOREIGN KEY (tenant_id, organization_id)
    REFERENCES fiducia_commercial.organizations (tenant_id, organization_id),
  FOREIGN KEY (tenant_id, originating_submission_id)
    REFERENCES fiducia_commercial.pre_interest_registrations (tenant_id, submission_id)
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.application_versions (
  tenant_id text NOT NULL,
  application_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN (
    'application_draft', 'application_submitted', 'needs_information',
    'security_review', 'solution_design', 'pricing_review', 'quote_issued',
    'legal_procurement', 'signed', 'provisioning', 'active', 'withdrawn',
    'expired', 'declined', 'superseded'
  )),
  schema_version text NOT NULL DEFAULT 'fiducia.application.v1',
  document_ciphertext jsonb NOT NULL CHECK (jsonb_typeof(document_ciphertext) = 'object'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  supersedes_version integer,
  created_by_contact_id text,
  created_by_subject_hash text NOT NULL CHECK (created_by_subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz,
  PRIMARY KEY (tenant_id, application_id, version),
  UNIQUE (tenant_id, application_id, content_sha256),
  FOREIGN KEY (tenant_id, application_id)
    REFERENCES fiducia_commercial.applications (tenant_id, application_id),
  FOREIGN KEY (tenant_id, created_by_contact_id)
    REFERENCES fiducia_commercial.contacts (tenant_id, contact_id),
  CHECK (supersedes_version IS NULL OR (supersedes_version > 0 AND supersedes_version < version))
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.attachments (
  tenant_id text NOT NULL,
  attachment_id text NOT NULL CHECK (attachment_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  application_id text NOT NULL,
  application_version integer NOT NULL,
  purpose text NOT NULL CHECK (purpose IN (
    'architecture', 'security-questionnaire', 'compliance-report',
    'requirements', 'rfp', 'legal-redline', 'pricing-input', 'other'
  )),
  object_key_ciphertext text NOT NULL,
  filename_ciphertext text NOT NULL,
  media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 255),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 52428800),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  malware_scan_status text NOT NULL CHECK (malware_scan_status IN ('pending', 'clean', 'rejected', 'error')),
  malware_scan_provider text,
  malware_scan_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attachment_id),
  UNIQUE (tenant_id, application_id, application_version, content_sha256),
  FOREIGN KEY (tenant_id, application_id, application_version)
    REFERENCES fiducia_commercial.application_versions (tenant_id, application_id, version)
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.support_plans (
  tenant_id text NOT NULL,
  support_plan_id text NOT NULL CHECK (support_plan_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  current_version integer NOT NULL CHECK (current_version > 0),
  current_status text NOT NULL CHECK (current_status IN ('draft', 'approved', 'retired', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, support_plan_id)
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.support_plan_versions (
  tenant_id text NOT NULL,
  support_plan_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'retired', 'superseded')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  tier text NOT NULL CHECK (tier IN ('self-service', 'business', 'enterprise', 'mission-critical', 'custom')),
  coverage text NOT NULL CHECK (coverage IN ('business-hours', 'extended-hours', '24x5', '24x7')),
  policy_document jsonb NOT NULL CHECK (jsonb_typeof(policy_document) = 'object'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  supersedes_version integer,
  approved_by_subject_hash text CHECK (approved_by_subject_hash IS NULL OR approved_by_subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, support_plan_id, version),
  UNIQUE (tenant_id, support_plan_id, content_sha256),
  FOREIGN KEY (tenant_id, support_plan_id)
    REFERENCES fiducia_commercial.support_plans (tenant_id, support_plan_id),
  CHECK (supersedes_version IS NULL OR (supersedes_version > 0 AND supersedes_version < version)),
  CHECK ((status = 'approved') = (approved_at IS NOT NULL AND approved_by_subject_hash IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.sla_policies (
  tenant_id text NOT NULL,
  sla_policy_id text NOT NULL CHECK (sla_policy_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  current_version integer NOT NULL CHECK (current_version > 0),
  current_status text NOT NULL CHECK (current_status IN ('draft', 'approved', 'retired', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, sla_policy_id)
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.sla_policy_versions (
  tenant_id text NOT NULL,
  sla_policy_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'retired', 'superseded')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  availability_target_bps integer NOT NULL CHECK (availability_target_bps BETWEEN 9000 AND 10000),
  measurement_window text NOT NULL CHECK (measurement_window IN ('calendar-month', 'rolling-30-days', 'calendar-quarter')),
  policy_document jsonb NOT NULL CHECK (jsonb_typeof(policy_document) = 'object'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  supersedes_version integer,
  approved_by_subject_hash text CHECK (approved_by_subject_hash IS NULL OR approved_by_subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, sla_policy_id, version),
  UNIQUE (tenant_id, sla_policy_id, content_sha256),
  FOREIGN KEY (tenant_id, sla_policy_id)
    REFERENCES fiducia_commercial.sla_policies (tenant_id, sla_policy_id),
  CHECK (supersedes_version IS NULL OR (supersedes_version > 0 AND supersedes_version < version)),
  CHECK ((status = 'approved') = (approved_at IS NOT NULL AND approved_by_subject_hash IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.contract_templates (
  tenant_id text NOT NULL,
  contract_template_id text NOT NULL CHECK (contract_template_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  kind text NOT NULL CHECK (kind IN (
    'msa', 'order-form', 'dpa', 'baa', 'sla', 'support-policy',
    'security-addendum', 'subprocessor-list'
  )),
  current_version integer NOT NULL CHECK (current_version > 0),
  current_status text NOT NULL CHECK (current_status IN ('draft', 'approved', 'retired', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, contract_template_id),
  UNIQUE (tenant_id, contract_template_id, kind)
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.contract_template_versions (
  tenant_id text NOT NULL,
  contract_template_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'retired', 'superseded')),
  document_object_key_ciphertext text NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  supersedes_version integer,
  approved_by_subject_hash text CHECK (approved_by_subject_hash IS NULL OR approved_by_subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, contract_template_id, version),
  UNIQUE (tenant_id, contract_template_id, content_sha256),
  FOREIGN KEY (tenant_id, contract_template_id)
    REFERENCES fiducia_commercial.contract_templates (tenant_id, contract_template_id),
  CHECK (supersedes_version IS NULL OR (supersedes_version > 0 AND supersedes_version < version)),
  CHECK ((status = 'approved') = (approved_at IS NOT NULL AND approved_by_subject_hash IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.quotes (
  tenant_id text NOT NULL,
  quote_id text NOT NULL CHECK (quote_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  application_id text NOT NULL,
  organization_id text NOT NULL,
  current_version integer NOT NULL CHECK (current_version > 0),
  current_status text NOT NULL CHECK (current_status IN (
    'draft', 'pricing_review', 'approved', 'issued', 'accepted',
    'declined', 'expired', 'superseded', 'withdrawn'
  )),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, quote_id),
  FOREIGN KEY (tenant_id, application_id)
    REFERENCES fiducia_commercial.applications (tenant_id, application_id),
  FOREIGN KEY (tenant_id, organization_id)
    REFERENCES fiducia_commercial.organizations (tenant_id, organization_id)
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.quote_versions (
  tenant_id text NOT NULL,
  quote_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN (
    'draft', 'pricing_review', 'approved', 'issued', 'accepted',
    'declined', 'expired', 'superseded', 'withdrawn'
  )),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  term_months integer NOT NULL CHECK (term_months BETWEEN 1 AND 120),
  subtotal_minor_units bigint NOT NULL CHECK (subtotal_minor_units >= 0),
  discount_minor_units bigint NOT NULL DEFAULT 0 CHECK (discount_minor_units >= 0),
  tax_minor_units bigint NOT NULL DEFAULT 0 CHECK (tax_minor_units >= 0),
  total_minor_units bigint NOT NULL CHECK (total_minor_units >= 0),
  minimum_commitment_minor_units bigint CHECK (minimum_commitment_minor_units IS NULL OR minimum_commitment_minor_units >= 0),
  support_plan_id text NOT NULL,
  support_plan_version integer NOT NULL CHECK (support_plan_version > 0),
  support_plan_sha256 text NOT NULL CHECK (support_plan_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  sla_policy_id text NOT NULL,
  sla_policy_version integer NOT NULL CHECK (sla_policy_version > 0),
  sla_policy_sha256 text NOT NULL CHECK (sla_policy_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  quote_document jsonb NOT NULL CHECK (jsonb_typeof(quote_document) = 'object'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  issued_at timestamptz,
  valid_until timestamptz,
  supersedes_version integer,
  approved_by_subject_hash text CHECK (approved_by_subject_hash IS NULL OR approved_by_subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, quote_id, version),
  UNIQUE (tenant_id, quote_id, content_sha256),
  FOREIGN KEY (tenant_id, quote_id)
    REFERENCES fiducia_commercial.quotes (tenant_id, quote_id),
  FOREIGN KEY (tenant_id, support_plan_id, support_plan_version)
    REFERENCES fiducia_commercial.support_plan_versions (tenant_id, support_plan_id, version),
  FOREIGN KEY (tenant_id, sla_policy_id, sla_policy_version)
    REFERENCES fiducia_commercial.sla_policy_versions (tenant_id, sla_policy_id, version),
  CHECK (total_minor_units = subtotal_minor_units - discount_minor_units + tax_minor_units),
  CHECK (supersedes_version IS NULL OR (supersedes_version > 0 AND supersedes_version < version)),
  CHECK (valid_until IS NULL OR (issued_at IS NOT NULL AND valid_until > issued_at)),
  CHECK ((status IN ('approved', 'issued', 'accepted')) = (approved_at IS NOT NULL AND approved_by_subject_hash IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.quote_line_items (
  tenant_id text NOT NULL,
  quote_id text NOT NULL,
  quote_version integer NOT NULL,
  line_item_id text NOT NULL CHECK (line_item_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  display_order integer NOT NULL CHECK (display_order >= 0),
  category text NOT NULL CHECK (category IN (
    'subscription', 'usage', 'minimum-commitment', 'support', 'onboarding',
    'professional-services', 'migration', 'training', 'discount', 'tax',
    'credit', 'other'
  )),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  metric text NOT NULL CHECK (length(metric) BETWEEN 1 AND 300),
  quantity numeric(24,6) NOT NULL CHECK (quantity >= 0),
  unit_price_minor_units bigint NOT NULL CHECK (unit_price_minor_units >= 0),
  extended_price_minor_units bigint NOT NULL CHECK (extended_price_minor_units >= 0),
  billing_frequency text NOT NULL CHECK (billing_frequency IN ('one-time', 'monthly', 'quarterly', 'annual', 'milestone')),
  pricing_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(pricing_metadata) = 'object'),
  PRIMARY KEY (tenant_id, quote_id, quote_version, line_item_id),
  UNIQUE (tenant_id, quote_id, quote_version, display_order),
  FOREIGN KEY (tenant_id, quote_id, quote_version)
    REFERENCES fiducia_commercial.quote_versions (tenant_id, quote_id, version)
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.quote_contract_references (
  tenant_id text NOT NULL,
  quote_id text NOT NULL,
  quote_version integer NOT NULL,
  contract_template_id text NOT NULL,
  contract_version integer NOT NULL CHECK (contract_version > 0),
  kind text NOT NULL CHECK (kind IN (
    'msa', 'order-form', 'dpa', 'baa', 'sla', 'support-policy',
    'security-addendum', 'subprocessor-list'
  )),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, quote_id, quote_version, contract_template_id, contract_version),
  FOREIGN KEY (tenant_id, quote_id, quote_version)
    REFERENCES fiducia_commercial.quote_versions (tenant_id, quote_id, version),
  FOREIGN KEY (tenant_id, contract_template_id, contract_version)
    REFERENCES fiducia_commercial.contract_template_versions (tenant_id, contract_template_id, version)
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.contract_acceptances (
  tenant_id text NOT NULL,
  acceptance_id text NOT NULL CHECK (acceptance_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  organization_id text NOT NULL,
  quote_id text NOT NULL,
  quote_version integer NOT NULL CHECK (quote_version > 0),
  quote_sha256 text NOT NULL CHECK (quote_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  signer_contact_id text NOT NULL,
  signer_authority_attested boolean NOT NULL CHECK (signer_authority_attested),
  signature_provider text NOT NULL CHECK (length(signature_provider) BETWEEN 1 AND 300),
  signature_evidence_id text NOT NULL CHECK (signature_evidence_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  signature_evidence_sha256 text NOT NULL CHECK (signature_evidence_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  source_ip_hash text NOT NULL CHECK (source_ip_hash ~ '^sha256:[0-9a-f]{64}$'),
  user_agent_hash text NOT NULL CHECK (user_agent_hash ~ '^sha256:[0-9a-f]{64}$'),
  accepted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, acceptance_id),
  UNIQUE (tenant_id, quote_id, quote_version),
  FOREIGN KEY (tenant_id, organization_id)
    REFERENCES fiducia_commercial.organizations (tenant_id, organization_id),
  FOREIGN KEY (tenant_id, quote_id, quote_version)
    REFERENCES fiducia_commercial.quote_versions (tenant_id, quote_id, version),
  FOREIGN KEY (tenant_id, signer_contact_id)
    REFERENCES fiducia_commercial.contacts (tenant_id, contact_id)
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.workflow_transition_rules (
  from_state text NOT NULL,
  to_state text NOT NULL,
  aggregate_type text NOT NULL DEFAULT 'commercial_case' CHECK (aggregate_type = 'commercial_case'),
  PRIMARY KEY (aggregate_type, from_state, to_state)
);

INSERT INTO fiducia_commercial.workflow_transition_rules (from_state, to_state)
VALUES
  ('interest_draft', 'email_verification_pending'),
  ('interest_draft', 'withdrawn'),
  ('interest_draft', 'expired'),
  ('email_verification_pending', 'interest_verified'),
  ('email_verification_pending', 'withdrawn'),
  ('email_verification_pending', 'expired'),
  ('interest_verified', 'qualified'),
  ('interest_verified', 'declined'),
  ('interest_verified', 'needs_information'),
  ('interest_verified', 'withdrawn'),
  ('interest_verified', 'expired'),
  ('qualified', 'application_draft'),
  ('qualified', 'declined'),
  ('qualified', 'withdrawn'),
  ('application_draft', 'application_submitted'),
  ('application_draft', 'withdrawn'),
  ('application_draft', 'expired'),
  ('application_submitted', 'needs_information'),
  ('application_submitted', 'security_review'),
  ('application_submitted', 'declined'),
  ('application_submitted', 'withdrawn'),
  ('needs_information', 'application_draft'),
  ('needs_information', 'application_submitted'),
  ('needs_information', 'declined'),
  ('needs_information', 'withdrawn'),
  ('needs_information', 'expired'),
  ('security_review', 'needs_information'),
  ('security_review', 'solution_design'),
  ('security_review', 'declined'),
  ('security_review', 'withdrawn'),
  ('solution_design', 'needs_information'),
  ('solution_design', 'pricing_review'),
  ('solution_design', 'declined'),
  ('solution_design', 'withdrawn'),
  ('pricing_review', 'quote_issued'),
  ('pricing_review', 'solution_design'),
  ('pricing_review', 'declined'),
  ('pricing_review', 'withdrawn'),
  ('quote_issued', 'legal_procurement'),
  ('quote_issued', 'pricing_review'),
  ('quote_issued', 'expired'),
  ('quote_issued', 'declined'),
  ('quote_issued', 'withdrawn'),
  ('quote_issued', 'superseded'),
  ('legal_procurement', 'signed'),
  ('legal_procurement', 'pricing_review'),
  ('legal_procurement', 'declined'),
  ('legal_procurement', 'withdrawn'),
  ('legal_procurement', 'expired'),
  ('legal_procurement', 'superseded'),
  ('signed', 'provisioning'),
  ('provisioning', 'active'),
  ('provisioning', 'needs_information')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS fiducia_commercial.workflow_events (
  tenant_id text NOT NULL,
  event_id text NOT NULL CHECK (event_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('pre_interest', 'application', 'quote', 'contract', 'commercial_case')),
  aggregate_id text NOT NULL CHECK (aggregate_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  sequence bigint NOT NULL CHECK (sequence > 0),
  from_state text,
  to_state text NOT NULL,
  reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 200),
  actor_type text NOT NULL CHECK (actor_type IN ('anonymous', 'contact', 'staff', 'service', 'system')),
  actor_subject_hash text NOT NULL CHECK (actor_subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^sha256:[0-9a-f]{64}$'),
  before_version integer,
  after_version integer,
  source_ip_hash text CHECK (source_ip_hash IS NULL OR source_ip_hash ~ '^sha256:[0-9a-f]{64}$'),
  session_hash text CHECK (session_hash IS NULL OR session_hash ~ '^sha256:[0-9a-f]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, aggregate_type, aggregate_id, sequence),
  CHECK (before_version IS NULL OR before_version > 0),
  CHECK (after_version IS NULL OR after_version > 0),
  CHECK (before_version IS NULL OR after_version IS NULL OR after_version >= before_version)
);

CREATE OR REPLACE FUNCTION fiducia_commercial.validate_workflow_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, fiducia_commercial
AS $$
BEGIN
  IF NEW.from_state IS NULL THEN
    IF NEW.to_state <> 'interest_draft' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'the initial commercial workflow state must be interest_draft';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM fiducia_commercial.workflow_transition_rules AS rule
    WHERE rule.aggregate_type = 'commercial_case'
      AND rule.from_state = NEW.from_state
      AND rule.to_state = NEW.to_state
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('invalid commercial workflow transition: %s -> %s', NEW.from_state, NEW.to_state);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_workflow_transition ON fiducia_commercial.workflow_events;
CREATE TRIGGER validate_workflow_transition
BEFORE INSERT ON fiducia_commercial.workflow_events
FOR EACH ROW EXECUTE FUNCTION fiducia_commercial.validate_workflow_transition();

CREATE TABLE IF NOT EXISTS fiducia_commercial.idempotency_records (
  tenant_id text NOT NULL,
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 300),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^sha256:[0-9a-f]{64}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_sha256 text CHECK (response_sha256 IS NULL OR response_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  resource_type text,
  resource_id text,
  state text NOT NULL DEFAULT 'processing' CHECK (state IN ('processing', 'completed', 'failed', 'expired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, scope, idempotency_key_hash),
  CHECK (expires_at > created_at),
  CHECK ((state = 'completed') = (response_status IS NOT NULL AND response_sha256 IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS fiducia_commercial.outbox_events (
  tenant_id text NOT NULL,
  outbox_event_id text NOT NULL CHECK (outbox_event_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  aggregate_type text NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 100),
  aggregate_id text NOT NULL CHECK (aggregate_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 200),
  payload_ciphertext jsonb NOT NULL CHECK (jsonb_typeof(payload_ciphertext) = 'object'),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, outbox_event_id),
  CHECK (NOT (delivered_at IS NOT NULL AND dead_lettered_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS applications_by_organization_status
  ON fiducia_commercial.applications (tenant_id, organization_id, current_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS application_versions_by_hash
  ON fiducia_commercial.application_versions (tenant_id, content_sha256);
CREATE INDEX IF NOT EXISTS attachments_pending_scan
  ON fiducia_commercial.attachments (tenant_id, malware_scan_status, created_at)
  WHERE malware_scan_status IN ('pending', 'error');
CREATE INDEX IF NOT EXISTS quotes_by_application_status
  ON fiducia_commercial.quotes (tenant_id, application_id, current_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS quote_versions_by_validity
  ON fiducia_commercial.quote_versions (tenant_id, status, valid_until)
  WHERE status IN ('issued', 'approved');
CREATE INDEX IF NOT EXISTS workflow_events_by_aggregate
  ON fiducia_commercial.workflow_events (tenant_id, aggregate_type, aggregate_id, sequence);
CREATE INDEX IF NOT EXISTS idempotency_expiration
  ON fiducia_commercial.idempotency_records (tenant_id, expires_at);
CREATE INDEX IF NOT EXISTS outbox_delivery_queue
  ON fiducia_commercial.outbox_events (available_at, attempt_count)
  WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;

DO $$
DECLARE
  table_name text;
  policy_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'organizations',
    'contacts',
    'organization_contact_roles',
    'pre_interest_registrations',
    'applications',
    'application_versions',
    'attachments',
    'support_plans',
    'support_plan_versions',
    'sla_policies',
    'sla_policy_versions',
    'contract_templates',
    'contract_template_versions',
    'quotes',
    'quote_versions',
    'quote_line_items',
    'quote_contract_references',
    'contract_acceptances',
    'workflow_events',
    'idempotency_records',
    'outbox_events'
  ] LOOP
    EXECUTE format('ALTER TABLE fiducia_commercial.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE fiducia_commercial.%I FORCE ROW LEVEL SECURITY', table_name);
    policy_name := table_name || '_tenant_isolation';
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'fiducia_commercial'
        AND tablename = table_name
        AND policyname = policy_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON fiducia_commercial.%I USING (tenant_id = fiducia_commercial.current_tenant_id()) WITH CHECK (tenant_id = fiducia_commercial.current_tenant_id())',
        policy_name,
        table_name
      );
    END IF;
  END LOOP;
END;
$$;

DO $$
DECLARE
  table_name text;
  trigger_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'application_versions',
    'support_plan_versions',
    'sla_policy_versions',
    'contract_template_versions',
    'quote_versions',
    'quote_line_items',
    'quote_contract_references',
    'contract_acceptances',
    'workflow_events'
  ] LOOP
    trigger_name := table_name || '_append_only';
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger
      JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'fiducia_commercial'
        AND relation.relname = table_name
        AND trigger.tgname = trigger_name
        AND NOT trigger.tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON fiducia_commercial.%I FOR EACH ROW EXECUTE FUNCTION fiducia_commercial.reject_immutable_mutation()',
        trigger_name,
        table_name
      );
    END IF;
  END LOOP;
END;
$$;

COMMENT ON SCHEMA fiducia_commercial IS
  'Tenant-scoped commercial intake, application, quote, support, SLA, contract, and audit records. Sensitive document fields contain application-layer ciphertext, not plaintext.';
COMMENT ON FUNCTION fiducia_commercial.current_tenant_id() IS
  'Returns the tenant selected by SET LOCAL app.tenant_id; an unset tenant matches no tenant-scoped rows.';
COMMENT ON TABLE fiducia_commercial.application_versions IS
  'Append-only encrypted application versions. Corrections create a higher version and supersession link.';
COMMENT ON TABLE fiducia_commercial.quote_versions IS
  'Append-only quote versions bound to exact support-plan and SLA-policy versions and content hashes.';
COMMENT ON TABLE fiducia_commercial.contract_acceptances IS
  'Append-only acceptance evidence binding an authorized signer to exact quote and contract hashes; raw IP addresses and user agents are not stored.';
COMMENT ON TABLE fiducia_commercial.outbox_events IS
  'Transactional notification/integration outbox with retry and dead-letter metadata. Payloads are encrypted and logs must use reason codes only.';

COMMIT;
