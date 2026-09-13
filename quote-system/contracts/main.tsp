// Independently authored TypeSpec authority for the Fiducia commercial intake
// boundary. contracts/commercial-intake.schema.json is the independently
// authored JSON Schema Draft 2020-12 peer authority. Neither file is generated
// from the other; TJSV compares them (see tjsv-declaration-mapping.json).
//
// Wire property names are snake_case, matching the JSON Schema, the examples,
// the SQL migration, and the generated payload types. TypeSpec type names stay
// PascalCase because declaration names are not wire names.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/json-schema";

using TypeSpec.Http;
using TypeSpec.Rest;
using TypeSpec.JsonSchema;

@service(#{ title: "Fiducia Commercial Intake API" })
@server("https://api.{zoneApex}", "Fiducia public API", { zoneApex: string })
namespace Fiducia.CommercialIntake;

// ---------------------------------------------------------------------------
// Shared scalars (peers of named JSON Schema $defs)
// ---------------------------------------------------------------------------

@pattern("^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$")
scalar OpaqueId extends string;

@pattern("^sha256:[0-9a-f]{64}$")
scalar Sha256Digest extends string;

@format("date-time")
scalar Timestamp extends string;

@pattern("^[A-Z]{2}$")
scalar CountryCode extends string;

@pattern("^[A-Z]{3}$")
scalar CurrencyCode extends string;

@format("email")
@maxLength(320)
scalar EmailAddress extends string;

@minLength(1)
@maxLength(10000)
scalar NonEmptyText extends string;

@minLength(1)
@maxLength(500)
scalar BoundedString extends string;

@maxItems(100)
@uniqueItems
model BoundedStringArray is BoundedString[];

@format("hostname")
@maxLength(253)
scalar Hostname extends string;

// Transport-only: the Idempotency-Key header. Document bodies carry
// idempotency_key with the same bounds inline.
@minLength(16)
@maxLength(128)
scalar IdempotencyKey extends string;

// ---------------------------------------------------------------------------
// Closed string vocabularies (inline enums in the JSON Schema)
// ---------------------------------------------------------------------------

alias ApplicationStatus =
  | "application_draft"
  | "application_submitted"
  | "needs_information"
  | "security_review"
  | "solution_design"
  | "pricing_review"
  | "quote_issued"
  | "legal_procurement"
  | "signed"
  | "provisioning"
  | "active"
  | "withdrawn"
  | "expired"
  | "declined"
  | "superseded";

alias QuoteStatus =
  | "draft"
  | "pricing_review"
  | "approved"
  | "issued"
  | "accepted"
  | "declined"
  | "expired"
  | "superseded"
  | "withdrawn";

alias PolicyStatus = "draft" | "approved" | "retired" | "superseded";
alias SupportTier = "self-service" | "business" | "enterprise" | "mission-critical" | "custom";
alias SupportCoverage = "business-hours" | "extended-hours" | "24x5" | "24x7";
alias SupportChannel = "portal" | "email" | "chat" | "phone" | "video" | "incident-bridge";
alias Severity = "P1" | "P2" | "P3" | "P4";
alias ContactChannel = "email" | "phone" | "video" | "secure_portal";
alias ContactRole =
  | "requester"
  | "business_owner"
  | "technical_owner"
  | "security_owner"
  | "legal_owner"
  | "procurement_owner"
  | "billing_owner"
  | "executive_sponsor"
  | "signer";
alias EntityType =
  | "corporation"
  | "llc"
  | "partnership"
  | "nonprofit"
  | "government"
  | "educational"
  | "sole_proprietorship"
  | "other";
alias EmployeeBand = "1-10" | "11-50" | "51-200" | "201-500" | "501-1000" | "1001-5000" | "5001-10000" | "10001+";
alias RevenueBand = "pre-revenue" | "under-1m" | "1m-10m" | "10m-50m" | "50m-250m" | "250m-1b" | "1b-plus" | "not-disclosed";
alias Urgency = "exploratory" | "this-quarter" | "six-months" | "twelve-months" | "urgent";
alias ProcurementStage =
  | "research"
  | "requirements"
  | "rfp"
  | "vendor-selection"
  | "legal-review"
  | "budget-approved"
  | "replacement-emergency";
alias Environment = "development" | "test" | "staging" | "production" | "disaster_recovery" | "regulated";
alias IdentityProtocol = "oidc" | "saml" | "scim" | "webauthn" | "totp" | "3fa";
alias DeploymentModel = "saas" | "single-tenant-saas" | "customer-cloud" | "on-premises" | "hybrid" | "edge";
alias NetworkConnectivity =
  | "public-internet"
  | "ip-allowlist"
  | "vpn"
  | "private-link"
  | "peering"
  | "customer-egress-proxy"
  | "offline";
alias ClientPlatform = "web" | "ios" | "android" | "flutter" | "desktop" | "cli" | "server-to-server";
alias ApiStyle = "rest" | "json-rpc" | "grpc" | "graphql" | "websocket" | "webhook" | "file-transfer";
alias DataClassification = "public" | "internal" | "confidential" | "restricted" | "customer-controlled";
alias RegulatedData =
  | "none"
  | "pii"
  | "phi"
  | "pci"
  | "financial"
  | "biometric"
  | "children"
  | "government"
  | "export-controlled";
alias SecurityAssessment =
  | "questionnaire"
  | "soc2"
  | "iso27001"
  | "penetration-test"
  | "architecture-review"
  | "code-review"
  | "onsite-audit";
alias CutoverStrategy = "not-applicable" | "big-bang" | "phased" | "parallel-run" | "blue-green" | "customer-defined";
alias BudgetBand = "under-10k" | "10k-50k" | "50k-250k" | "250k-1m" | "1m-plus" | "not-disclosed";
alias CommercialBillingFrequency = "monthly" | "quarterly" | "annual" | "prepaid" | "milestone";
alias LineBillingFrequency = "one-time" | "monthly" | "quarterly" | "annual" | "milestone";
alias SignatureMethod = "electronic" | "wet-ink" | "customer-procurement-platform";
alias AttachmentPurpose =
  | "architecture"
  | "security-questionnaire"
  | "compliance-report"
  | "requirements"
  | "rfp"
  | "legal-redline"
  | "pricing-input"
  | "other";
alias MalwareScanStatus = "pending" | "clean" | "rejected" | "error";
alias MeasurementWindow = "calendar-month" | "rolling-30-days" | "calendar-quarter";
alias LatencyPercentile = "p50" | "p90" | "p95" | "p99" | "p99.9";
alias QuoteLineCategory =
  | "subscription"
  | "usage"
  | "minimum-commitment"
  | "support"
  | "onboarding"
  | "professional-services"
  | "migration"
  | "training"
  | "discount"
  | "tax"
  | "credit"
  | "other";
alias ContractKind =
  | "msa"
  | "order-form"
  | "dpa"
  | "baa"
  | "sla"
  | "support-policy"
  | "security-addendum"
  | "subprocessor-list";

// ---------------------------------------------------------------------------
// Payload building blocks
// ---------------------------------------------------------------------------

model Money {
  currency: CurrencyCode;

  @minValue(0)
  @maxValue(9007199254740991)
  minor_units: integer;
}

model Address {
  @maxLength(300) line1?: string;
  @maxLength(300) line2?: string;
  @maxLength(200) city?: string;
  @maxLength(200) region?: string;
  @maxLength(50) postal_code?: string;
  country: CountryCode;
}

model Contact {
  contact_id?: OpaqueId;
  @minLength(1) @maxLength(300) full_name: string;
  @minLength(1) @maxLength(200) title: string;
  @maxLength(200) department?: string;
  work_email: EmailAddress;
  @maxLength(80) phone?: string;
  @pattern("^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$") preferred_language: string;
  @minLength(1) @maxLength(100) time_zone: string;
  preferred_channel?: ContactChannel;
  @maxItems(10) @uniqueItems roles?: ContactRole[];
}

model Organization {
  organization_id?: OpaqueId;
  @minLength(1) @maxLength(500) legal_name: string;
  @maxLength(500) doing_business_as?: string;
  @format("uri") @maxLength(2000) website: string;
  @maxItems(50) @uniqueItems verified_email_domains?: Hostname[];
  jurisdiction: CountryCode;
  entity_type: EntityType;
  @maxLength(200) registration_number?: string;
  @maxLength(200) tax_identifier?: string;
  headquarters: Address;
  @maxItems(250) @uniqueItems operating_countries?: CountryCode[];
  industries: BoundedStringArray;
  employee_band: EmployeeBand;
  annual_revenue_band?: RevenueBand;
  @maxLength(500) parent_organization?: string;
  subsidiaries_in_scope?: BoundedStringArray;
}

model NeedSummary {
  problem_statement: NonEmptyText;
  desired_outcomes: BoundedStringArray;
  use_cases: BoundedStringArray;
  current_systems?: BoundedStringArray;
  current_vendors?: BoundedStringArray;
  @maxLength(10000) business_impact?: string;
  urgency?: Urgency;
  @format("date") target_launch_date: string;
  @format("date") decision_deadline?: string;
  procurement_stage: ProcurementStage;
  success_metrics?: BoundedStringArray;
}

model UsageForecast {
  @minItems(1) @maxItems(20) @uniqueItems environments: Environment[];
  @minValue(1) @maxValue(1000000000) tenants?: integer;
  @minValue(0) @maxValue(1000000000000) monthly_active_users: integer;
  @minValue(0) @maxValue(1000000000000) peak_concurrency: integer;
  @minValue(0) @maxValue(9007199254740991) requests_per_month: integer;
  @minValue(0) @maxValue(1000000000000) storage_gib: float64;
  @minValue(0) @maxValue(1000000000000) egress_gib: float64;
  @minValue(0) @maxValue(1000000000000) events_per_second_peak?: float64;
  @minValue(0) @maxValue(10000) data_growth_percent_monthly?: float64;
  regions: BoundedStringArray;
  @maxLength(5000) seasonality_notes?: string;
}

model TechnicalRequirements {
  @minItems(1) @uniqueItems deployment_models: DeploymentModel[];
  clouds: BoundedStringArray;
  kubernetes_distributions?: BoundedStringArray;
  databases?: BoundedStringArray;
  message_buses?: BoundedStringArray;
  identity: {
    sso_required: boolean;
    scim_required: boolean;
    mfa_required?: boolean;
    providers: BoundedStringArray;
    @uniqueItems protocols?: IdentityProtocol[];
  };
  @uniqueItems network_connectivity?: NetworkConnectivity[];
  integrations: BoundedStringArray;
  @uniqueItems client_platforms?: ClientPlatform[];
  @uniqueItems api_styles?: ApiStyle[];
  observability: {
    logs: boolean;
    metrics: boolean;
    traces: boolean;
    audit_events: boolean;
    otel_required?: boolean;
    destinations?: BoundedStringArray;
  };
  @maxLength(20000) custom_requirements?: string;
}

model DataSecurityRequirements {
  @minItems(1) @uniqueItems classifications: DataClassification[];
  @uniqueItems regulated_data: RegulatedData[];
  @maxItems(250) @uniqueItems residency_countries: CountryCode[];
  encryption: {
    at_rest: boolean;
    in_transit: boolean;
    customer_managed_keys: boolean;
    hsm_required?: boolean;
    @minValue(1) @maxValue(3650) key_rotation_days?: integer;
  };
  retention: {
    @minValue(1) @maxValue(36500) default_days: integer;
    @minValue(0) @maxValue(3650) deletion_sla_days: integer;
    legal_hold_required: boolean;
    @minValue(0) @maxValue(36500) backup_retention_days?: integer;
  };
  compliance_frameworks: BoundedStringArray;
  @uniqueItems security_assessments?: SecurityAssessment[];
  @minValue(1) @maxValue(720) incident_notification_hours?: integer;
  vulnerability_remediation?: {
    @minValue(0) @maxValue(365) critical_days?: integer;
    @minValue(0) @maxValue(730) high_days?: integer;
    @minValue(0) @maxValue(1825) medium_days?: integer;
  };
}

model MigrationRequirements {
  migration_required: boolean;
  source_systems?: BoundedStringArray;
  @minValue(0) @maxValue(1000000000000) data_volume_gib?: float64;
  cutover_strategy: CutoverStrategy;
  @minValue(0) @maxValue(525600) downtime_budget_minutes?: integer;
  rollback_required: boolean;
  @maxLength(10000) validation_plan?: string;
  professional_services_requested?: boolean;
}

model CommercialRequirements {
  budget_band: BudgetBand;
  currency: CurrencyCode;
  @minValue(1) @maxValue(120) term_months: integer;
  billing_frequency: CommercialBillingFrequency;
  @minValue(0) @maxValue(180) payment_terms_days?: integer;
  purchase_order_required?: boolean;
  @maxLength(2000) invoice_portal?: string;
  tax_exempt?: boolean;
  minimum_commitment_acceptable?: boolean;
  pilot_requested?: boolean;
  @minValue(1) @maxValue(365) pilot_duration_days?: integer;
  procurement_stage: ProcurementStage;
}

model SeverityTarget {
  severity: Severity;
  @minValue(1) @maxValue(10080) initial_response_minutes: integer;
  @minValue(1) @maxValue(10080) update_interval_minutes: integer;
  @minValue(1) @maxValue(525600) mitigation_target_minutes: integer;
  @minValue(1) @maxValue(525600) restoration_target_minutes: integer;
}

model SupportRequirements {
  tier: SupportTier;
  coverage: SupportCoverage;
  coverage_time_zones?: BoundedStringArray;
  @minItems(1) @uniqueItems channels: SupportChannel[];
  named_tam?: boolean;
  @minValue(0) @maxValue(100000) onboarding_hours?: integer;
  @minValue(0) @maxValue(100000) training_hours?: integer;
  @minItems(4) @maxItems(4) severity_targets: SeverityTarget[];
  @minValue(0) @maxValue(525600) rto_minutes: integer;
  @minValue(0) @maxValue(525600) rpo_minutes: integer;
  maintenance_window_preferences?: BoundedStringArray;
  service_credit_expected?: boolean;
}

model LegalRequirements {
  msa_required: boolean;
  dpa_required: boolean;
  baa_required?: boolean;
  security_addendum_required?: boolean;
  subprocessor_review_required?: boolean;
  @maxLength(200) accessibility_standard?: string;
  governing_law_preferences: BoundedStringArray;
  @maxLength(1000) liability_cap_preference?: string;
  @maxLength(10000) indemnity_requirements?: string;
  @maxLength(10000) insurance_requirements?: string;
  @maxLength(10000) export_control_requirements?: string;
  signature_method: SignatureMethod;
}

model AttachmentReference {
  attachment_id: OpaqueId;
  purpose: AttachmentPurpose;
  @minLength(1) @maxLength(255) filename: string;
  @minLength(1) @maxLength(255) media_type: string;
  @minValue(1) @maxValue(52428800) size_bytes: integer;
  content_sha256: Sha256Digest;
  malware_scan_status: MalwareScanStatus;
  created_at?: Timestamp;
}

model ConsentEvidence {
  @minLength(1) @maxLength(100) privacy_policy_version: string;
  @minLength(1) @maxLength(100) terms_version: string;
  contact_consent: true;
  marketing_consent?: boolean;
  submitted_at: Timestamp;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

model PreInterestRequest {
  schema: "fiducia.pre-interest.v1";
  document_type: "pre_interest";
  submission_id: OpaqueId;
  @minLength(16) @maxLength(128) idempotency_key: string;
  contact: Contact;
  organization: Organization;
  need: NeedSummary;
  usage_forecast: UsageForecast;
  commercial: CommercialRequirements;
  support: SupportRequirements;
  @maxLength(500) referral_source?: string;
  consent: ConsentEvidence;
}

model ApplicationDocument {
  schema: "fiducia.application.v1";
  document_type: "application";
  application_id: OpaqueId;
  organization_id: OpaqueId;
  @minValue(1) version: integer;
  status: ApplicationStatus;
  etag: Sha256Digest;
  organization: Organization;
  @minItems(1) @maxItems(100) stakeholders: Contact[];
  need: NeedSummary;
  usage_forecast: UsageForecast;
  technical: TechnicalRequirements;
  data_security: DataSecurityRequirements;
  migration: MigrationRequirements;
  commercial: CommercialRequirements;
  support: SupportRequirements;
  legal: LegalRequirements;
  @maxItems(200) attachments: AttachmentReference[];
  attestations: {
    authorized_to_submit: true;
    information_accurate: true;
    @minLength(1) @maxLength(100) privacy_policy_version: string;
  };
  updated_at: Timestamp;
  submitted_at?: Timestamp;
}

model SupportPlanDocument {
  schema: "fiducia.support-plan.v1";
  document_type: "support_plan";
  support_plan_id: OpaqueId;
  @minValue(1) version: integer;
  status: PolicyStatus;
  @minLength(1) @maxLength(300) name: string;
  tier: SupportTier;
  coverage: SupportCoverage;
  coverage_time_zones?: BoundedStringArray;
  @minItems(1) @uniqueItems channels: SupportChannel[];
  @minItems(4) @maxItems(4) severity_targets: SeverityTarget[];
  onboarding: {
    @minValue(0) @maxValue(100000) included_hours: integer;
    @minValue(0) @maxValue(100000) training_hours: integer;
    named_tam: boolean;
  };
  content_sha256: Sha256Digest;
  @minValue(1) supersedes_version?: integer;
}

model CreditTier {
  @minValue(0) @maxValue(10000) availability_below_bps: integer;
  @minValue(0) @maxValue(100) credit_percent: float64;
}

model SlaPolicyDocument {
  schema: "fiducia.sla-policy.v1";
  document_type: "sla_policy";
  sla_policy_id: OpaqueId;
  @minValue(1) version: integer;
  status: PolicyStatus;
  @minLength(1) @maxLength(300) name: string;
  @minValue(9000) @maxValue(10000) availability_target_bps: integer;
  measurement_window: MeasurementWindow;
  @minLength(1) @maxLength(2000) measurement_source: string;
  @minLength(1) @maxLength(5000) availability_formula: string;
  @maxItems(100) latency_objectives?: {
    @minLength(1) @maxLength(300) operation: string;
    percentile: LatencyPercentile;
    @minValue(1) @maxValue(86400000) maximum_ms: integer;
  }[];
  @minValue(0) @maxValue(10000) error_rate_max_bps?: integer;
  @minItems(4) @maxItems(4) severity_targets: SeverityTarget[];
  @minValue(0) @maxValue(525600) rto_minutes: integer;
  @minValue(0) @maxValue(525600) rpo_minutes: integer;
  planned_maintenance: {
    excluded: boolean;
    @minValue(0) @maxValue(8760) notice_hours: integer;
    @minValue(0) @maxValue(744) maximum_hours_per_month: float64;
  };
  exclusions: BoundedStringArray;
  incident_communication: {
    status_page: boolean;
    @minValue(1) @maxValue(10080) initial_notice_minutes: integer;
    @minValue(1) @maxValue(10080) update_interval_minutes: integer;
    @minValue(1) @maxValue(365) postmortem_business_days: integer;
  };
  service_credits: {
    @minItems(1) @maxItems(20) tiers: CreditTier[];
    @minValue(0) @maxValue(100) monthly_cap_percent: float64;
    @minLength(1) @maxLength(500) applies_to_fees: string;
    automatic: boolean;
  };
  @minValue(1) @maxValue(365) claim_window_days: integer;
  content_sha256: Sha256Digest;
  @minValue(1) supersedes_version?: integer;
}

model QuoteLineItem {
  line_item_id: OpaqueId;
  category: QuoteLineCategory;
  @minLength(1) @maxLength(2000) description: string;
  @minLength(1) @maxLength(300) metric: string;
  @minValue(0) @maxValue(9007199254740991) quantity: float64;
  unit_price: Money;
  extended_price: Money;
  billing_frequency: LineBillingFrequency;
  @minValue(0) minimum_quantity?: float64;
  @minValue(0) maximum_quantity?: float64;
  @maxLength(5000) notes?: string;
}

model ContractReference {
  kind: ContractKind;
  template_id: OpaqueId;
  @minValue(1) version: integer;
  content_sha256: Sha256Digest;
}

model QuoteDocument {
  schema: "fiducia.quote.v1";
  document_type: "quote";
  quote_id: OpaqueId;
  application_id: OpaqueId;
  organization_id: OpaqueId;
  @minValue(1) version: integer;
  status: QuoteStatus;
  currency: CurrencyCode;
  issued_at: Timestamp;
  valid_until: Timestamp;
  @minValue(1) @maxValue(120) term_months: integer;
  @format("date") billing_start?: string;
  @minItems(1) @maxItems(1000) line_items: QuoteLineItem[];
  subtotal: Money;
  discount_total: Money;
  tax_total: Money;
  total: Money;
  minimum_commitment?: Money;
  support_plan: {
    support_plan_id: OpaqueId;
    @minValue(1) version: integer;
    content_sha256: Sha256Digest;
  };
  sla_policy: {
    sla_policy_id: OpaqueId;
    @minValue(1) version: integer;
    content_sha256: Sha256Digest;
  };
  @minItems(1) @maxItems(50) contract_references: ContractReference[];
  assumptions: BoundedStringArray;
  exclusions: BoundedStringArray;
  dependencies?: BoundedStringArray;
  @maxItems(100) implementation_milestones?: {
    @minLength(1) @maxLength(300) name: string;
    @format("date") target_date: string;
    acceptance_criteria: BoundedStringArray;
  }[];
  @minValue(1) supersedes_quote_version?: integer;
  content_sha256: Sha256Digest;
}

model Signer {
  @minLength(1) @maxLength(300) full_name: string;
  work_email: EmailAddress;
  @minLength(1) @maxLength(200) title: string;
  authority_attested: true;
}

model ContractAcceptanceRequest {
  schema: "fiducia.contract-acceptance.v1";
  document_type: "contract_acceptance";
  acceptance_id: OpaqueId;
  organization_id: OpaqueId;
  quote_id: OpaqueId;
  @minValue(1) quote_version: integer;
  quote_sha256: Sha256Digest;
  @minItems(1) @maxItems(50) contract_references: ContractReference[];
  signer: Signer;
  @minLength(1) @maxLength(300) signature_provider: string;
  signature_evidence_id: OpaqueId;
  accepted_at: Timestamp;
  source_ip_hash: Sha256Digest;
  user_agent_hash: Sha256Digest;
  @maxLength(5000) withdrawal_rights?: string;
}

// ---------------------------------------------------------------------------
// Transport-only models (no JSON Schema peer; the JSON Schema covers documents)
// ---------------------------------------------------------------------------

model PreInterestReceipt {
  submission_id: OpaqueId;
  status: "email_verification_pending" | "interest_verified";
  verification_required: boolean;
  created_at: Timestamp;
}

model ApplicationPatch {
  organization?: Organization;
  stakeholders?: Contact[];
  need?: NeedSummary;
  usage_forecast?: UsageForecast;
  technical?: TechnicalRequirements;
  data_security?: DataSecurityRequirements;
  migration?: MigrationRequirements;
  commercial?: CommercialRequirements;
  support?: SupportRequirements;
  legal?: LegalRequirements;
}

model ApiError {
  code: string;
  message: string;
  request_id: OpaqueId;
  retryable: boolean;
  field_errors?: FieldError[];
}

model FieldError {
  path: string;
  code: string;
}

model CreatedResponse<T> {
  @statusCode
  statusCode: 201;
  @header("ETag")
  etag?: string;
  @body
  body: T;
}

model OkResponse<T> {
  @statusCode
  statusCode: 200;
  @header("ETag")
  etag?: string;
  @body
  body: T;
}

model AcceptedResponse<T> {
  @statusCode
  statusCode: 202;
  @body
  body: T;
}

model NoContentResponse {
  @statusCode
  statusCode: 204;
}

model ErrorResponse {
  @statusCode
  statusCode: 400 | 401 | 403 | 404 | 409 | 412 | 413 | 422 | 429 | 500 | 503;
  @body
  body: ApiError;
}

@route("/v1/pre-interest")
interface PreInterestOperations {
  @post
  create(
    @header("Idempotency-Key") idempotencyKey: IdempotencyKey,
    @body request: PreInterestRequest,
  ): CreatedResponse<PreInterestReceipt> | ErrorResponse;
}

@route("/v1/applications")
interface ApplicationCollectionOperations {
  @post
  create(
    @header("Idempotency-Key") idempotencyKey: IdempotencyKey,
    @body request: ApplicationDocument,
  ): CreatedResponse<ApplicationDocument> | ErrorResponse;
}

@route("/v1/applications/{applicationId}")
interface ApplicationOperations {
  @get
  read(@path applicationId: OpaqueId): OkResponse<ApplicationDocument> | ErrorResponse;

  @patch
  update(
    @path applicationId: OpaqueId,
    @header("If-Match") ifMatch: Sha256Digest,
    @header("Idempotency-Key") idempotencyKey: IdempotencyKey,
    @body patch: ApplicationPatch,
  ): OkResponse<ApplicationDocument> | ErrorResponse;

  @route("submit")
  @post
  submit(
    @path applicationId: OpaqueId,
    @header("If-Match") ifMatch: Sha256Digest,
    @header("Idempotency-Key") idempotencyKey: IdempotencyKey,
  ): AcceptedResponse<ApplicationDocument> | ErrorResponse;

  @route("withdraw")
  @post
  withdraw(
    @path applicationId: OpaqueId,
    @header("If-Match") ifMatch: Sha256Digest,
    @header("Idempotency-Key") idempotencyKey: IdempotencyKey,
  ): OkResponse<ApplicationDocument> | ErrorResponse;
}

@route("/v1/quotes/{quoteId}")
interface QuoteOperations {
  @get
  read(@path quoteId: OpaqueId): OkResponse<QuoteDocument> | ErrorResponse;

  @route("accept")
  @post
  accept(
    @path quoteId: OpaqueId,
    @header("If-Match") ifMatch: Sha256Digest,
    @header("Idempotency-Key") idempotencyKey: IdempotencyKey,
    @body request: ContractAcceptanceRequest,
  ): AcceptedResponse<ContractAcceptanceRequest> | ErrorResponse;

  @route("decline")
  @post
  decline(
    @path quoteId: OpaqueId,
    @header("If-Match") ifMatch: Sha256Digest,
    @header("Idempotency-Key") idempotencyKey: IdempotencyKey,
  ): NoContentResponse | ErrorResponse;
}

@doc("Administrative operations require a separate auth audience and explicit tenant-scoped roles.")
@route("/v1/admin/applications/{applicationId}")
interface AdminApplicationOperations {
  @get
  read(@path applicationId: OpaqueId): OkResponse<ApplicationDocument> | ErrorResponse;

  @route("transition")
  @post
  transition(
    @path applicationId: OpaqueId,
    @header("If-Match") ifMatch: Sha256Digest,
    @header("Idempotency-Key") idempotencyKey: IdempotencyKey,
    @body request: AdminTransitionRequest,
  ): OkResponse<ApplicationDocument> | ErrorResponse;
}

model AdminTransitionRequest {
  target_status: ApplicationStatus;
  reason_code: string;
  note?: string;
  assigned_contact_ids?: OpaqueId[];
}

@doc("Quote issue and supersession are privileged and append immutable versions.")
@route("/v1/admin/quotes")
interface AdminQuoteOperations {
  @post
  createVersion(
    @header("Idempotency-Key") idempotencyKey: IdempotencyKey,
    @body request: QuoteDocument,
  ): CreatedResponse<QuoteDocument> | ErrorResponse;
}
