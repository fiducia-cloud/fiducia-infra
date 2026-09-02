import "@typespec/http";
import "@typespec/rest";

using TypeSpec.Http;
using TypeSpec.Rest;

@service(#{ title: "Fiducia Commercial Intake API" })
@server("https://api.{zoneApex}", "Fiducia public API", { zoneApex: string })
namespace Fiducia.CommercialIntake;

@pattern("^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$")
scalar OpaqueId extends string;

@pattern("^sha256:[0-9a-f]{64}$")
scalar Sha256Digest extends string;

@pattern("^[A-Z]{3}$")
scalar CurrencyCode extends string;

@format("email")
scalar EmailAddress extends string;

@format("date-time")
scalar Timestamp extends string;

@format("date")
scalar CalendarDate extends string;

@minLength(16)
@maxLength(128)
scalar IdempotencyKey extends string;

@minValue(0)
scalar MinorUnits extends int64;

model Money {
  currency: CurrencyCode;
  minorUnits: MinorUnits;
}

enum ApplicationStatus {
  applicationDraft: "application_draft",
  applicationSubmitted: "application_submitted",
  needsInformation: "needs_information",
  securityReview: "security_review",
  solutionDesign: "solution_design",
  pricingReview: "pricing_review",
  quoteIssued: "quote_issued",
  legalProcurement: "legal_procurement",
  signed: "signed",
  provisioning: "provisioning",
  active: "active",
  withdrawn: "withdrawn",
  expired: "expired",
  declined: "declined",
  superseded: "superseded",
}

enum SupportTier {
  selfService: "self-service",
  business: "business",
  enterprise: "enterprise",
  missionCritical: "mission-critical",
  custom: "custom",
}

enum SupportCoverage {
  businessHours: "business-hours",
  extendedHours: "extended-hours",
  twentyFourByFive: "24x5",
  twentyFourBySeven: "24x7",
}

enum Severity {
  p1: "P1",
  p2: "P2",
  p3: "P3",
  p4: "P4",
}

enum QuoteStatus {
  draft: "draft",
  pricingReview: "pricing_review",
  approved: "approved",
  issued: "issued",
  accepted: "accepted",
  declined: "declined",
  expired: "expired",
  superseded: "superseded",
  withdrawn: "withdrawn",
}

enum QuoteLineCategory {
  subscription: "subscription",
  usage: "usage",
  minimumCommitment: "minimum-commitment",
  support: "support",
  onboarding: "onboarding",
  professionalServices: "professional-services",
  migration: "migration",
  training: "training",
  discount: "discount",
  tax: "tax",
  credit: "credit",
  other: "other",
}

enum ContractKind {
  msa: "msa",
  orderForm: "order-form",
  dpa: "dpa",
  baa: "baa",
  sla: "sla",
  supportPolicy: "support-policy",
  securityAddendum: "security-addendum",
  subprocessorList: "subprocessor-list",
}

model Address {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  @pattern("^[A-Z]{2}$")
  country: string;
}

model Contact {
  contactId?: OpaqueId;
  @minLength(1)
  @maxLength(300)
  fullName: string;
  @minLength(1)
  @maxLength(200)
  title: string;
  department?: string;
  workEmail: EmailAddress;
  phone?: string;
  preferredLanguage: string;
  timeZone: string;
  preferredChannel?: "email" | "phone" | "video" | "secure_portal";
  roles?: ("requester" | "business_owner" | "technical_owner" | "security_owner" | "legal_owner" | "procurement_owner" | "billing_owner" | "executive_sponsor" | "signer")[];
}

model Organization {
  organizationId?: OpaqueId;
  @minLength(1)
  @maxLength(500)
  legalName: string;
  doingBusinessAs?: string;
  @format("uri")
  website: string;
  verifiedEmailDomains?: string[];
  @pattern("^[A-Z]{2}$")
  jurisdiction: string;
  entityType: "corporation" | "llc" | "partnership" | "nonprofit" | "government" | "educational" | "sole_proprietorship" | "other";
  registrationNumber?: string;
  taxIdentifier?: string;
  headquarters: Address;
  operatingCountries?: string[];
  industries: string[];
  employeeBand: "1-10" | "11-50" | "51-200" | "201-500" | "501-1000" | "1001-5000" | "5001-10000" | "10001+";
  annualRevenueBand?: "pre-revenue" | "under-1m" | "1m-10m" | "10m-50m" | "50m-250m" | "250m-1b" | "1b-plus" | "not-disclosed";
  parentOrganization?: string;
  subsidiariesInScope?: string[];
}

model NeedSummary {
  @minLength(1)
  @maxLength(10000)
  problemStatement: string;
  desiredOutcomes: string[];
  useCases: string[];
  currentSystems?: string[];
  currentVendors?: string[];
  businessImpact?: string;
  urgency?: "exploratory" | "this-quarter" | "six-months" | "twelve-months" | "urgent";
  targetLaunchDate: CalendarDate;
  decisionDeadline?: CalendarDate;
  procurementStage: "research" | "requirements" | "rfp" | "vendor-selection" | "legal-review" | "budget-approved" | "replacement-emergency";
  successMetrics?: string[];
}

model UsageForecast {
  environments: ("development" | "test" | "staging" | "production" | "disaster_recovery" | "regulated")[];
  tenants?: int64;
  monthlyActiveUsers: int64;
  peakConcurrency: int64;
  requestsPerMonth: int64;
  storageGib: float64;
  egressGib: float64;
  eventsPerSecondPeak?: float64;
  dataGrowthPercentMonthly?: float64;
  regions: string[];
  seasonalityNotes?: string;
}

model IdentityRequirements {
  ssoRequired: boolean;
  scimRequired: boolean;
  mfaRequired?: boolean;
  providers: string[];
  protocols?: ("oidc" | "saml" | "scim" | "webauthn" | "totp" | "3fa")[];
}

model ObservabilityRequirements {
  logs: boolean;
  metrics: boolean;
  traces: boolean;
  auditEvents: boolean;
  otelRequired?: boolean;
  destinations?: string[];
}

model TechnicalRequirements {
  deploymentModels: ("saas" | "single-tenant-saas" | "customer-cloud" | "on-premises" | "hybrid" | "edge")[];
  clouds: string[];
  kubernetesDistributions?: string[];
  databases?: string[];
  messageBuses?: string[];
  identity: IdentityRequirements;
  networkConnectivity?: ("public-internet" | "ip-allowlist" | "vpn" | "private-link" | "peering" | "customer-egress-proxy" | "offline")[];
  integrations: string[];
  clientPlatforms?: ("web" | "ios" | "android" | "flutter" | "desktop" | "cli" | "server-to-server")[];
  apiStyles?: ("rest" | "json-rpc" | "grpc" | "graphql" | "websocket" | "webhook" | "file-transfer")[];
  observability: ObservabilityRequirements;
  customRequirements?: string;
}

model EncryptionRequirements {
  atRest: boolean;
  inTransit: boolean;
  customerManagedKeys: boolean;
  hsmRequired?: boolean;
  keyRotationDays?: int32;
}

model RetentionRequirements {
  defaultDays: int32;
  deletionSlaDays: int32;
  legalHoldRequired: boolean;
  backupRetentionDays?: int32;
}

model DataSecurityRequirements {
  classifications: ("public" | "internal" | "confidential" | "restricted" | "customer-controlled")[];
  regulatedData: ("none" | "pii" | "phi" | "pci" | "financial" | "biometric" | "children" | "government" | "export-controlled")[];
  residencyCountries: string[];
  encryption: EncryptionRequirements;
  retention: RetentionRequirements;
  complianceFrameworks: string[];
  securityAssessments?: ("questionnaire" | "soc2" | "iso27001" | "penetration-test" | "architecture-review" | "code-review" | "onsite-audit")[];
  incidentNotificationHours?: int32;
}

model MigrationRequirements {
  migrationRequired: boolean;
  sourceSystems?: string[];
  dataVolumeGib?: float64;
  cutoverStrategy: "not-applicable" | "big-bang" | "phased" | "parallel-run" | "blue-green" | "customer-defined";
  downtimeBudgetMinutes?: int32;
  rollbackRequired: boolean;
  validationPlan?: string;
  professionalServicesRequested?: boolean;
}

model CommercialRequirements {
  budgetBand: "under-10k" | "10k-50k" | "50k-250k" | "250k-1m" | "1m-plus" | "not-disclosed";
  currency: CurrencyCode;
  termMonths: int32;
  billingFrequency: "monthly" | "quarterly" | "annual" | "prepaid" | "milestone";
  paymentTermsDays?: int32;
  purchaseOrderRequired?: boolean;
  invoicePortal?: string;
  taxExempt?: boolean;
  minimumCommitmentAcceptable?: boolean;
  pilotRequested?: boolean;
  pilotDurationDays?: int32;
  procurementStage: "research" | "requirements" | "rfp" | "vendor-selection" | "legal-review" | "budget-approved" | "replacement-emergency";
}

model SeverityTarget {
  severity: Severity;
  initialResponseMinutes: int32;
  updateIntervalMinutes: int32;
  mitigationTargetMinutes: int32;
  restorationTargetMinutes: int32;
}

model SupportRequirements {
  tier: SupportTier;
  coverage: SupportCoverage;
  coverageTimeZones?: string[];
  channels: ("portal" | "email" | "chat" | "phone" | "video" | "incident-bridge")[];
  namedTam?: boolean;
  onboardingHours?: int32;
  trainingHours?: int32;
  severityTargets: SeverityTarget[];
  rtoMinutes: int32;
  rpoMinutes: int32;
  maintenanceWindowPreferences?: string[];
  serviceCreditExpected?: boolean;
}

model LegalRequirements {
  msaRequired: boolean;
  dpaRequired: boolean;
  baaRequired?: boolean;
  securityAddendumRequired?: boolean;
  subprocessorReviewRequired?: boolean;
  accessibilityStandard?: string;
  governingLawPreferences: string[];
  liabilityCapPreference?: string;
  indemnityRequirements?: string;
  insuranceRequirements?: string;
  exportControlRequirements?: string;
  signatureMethod: "electronic" | "wet-ink" | "customer-procurement-platform";
}

model AttachmentReference {
  attachmentId: OpaqueId;
  purpose: "architecture" | "security-questionnaire" | "compliance-report" | "requirements" | "rfp" | "legal-redline" | "pricing-input" | "other";
  filename: string;
  mediaType: string;
  sizeBytes: int64;
  contentSha256: Sha256Digest;
  malwareScanStatus: "pending" | "clean" | "rejected" | "error";
  createdAt?: Timestamp;
}

model ConsentEvidence {
  privacyPolicyVersion: string;
  termsVersion: string;
  contactConsent: true;
  marketingConsent?: boolean;
  submittedAt: Timestamp;
}

model PreInterestRequest {
  schema: "fiducia.pre-interest.v1";
  documentType: "pre_interest";
  submissionId: OpaqueId;
  idempotencyKey: IdempotencyKey;
  contact: Contact;
  organization: Organization;
  need: NeedSummary;
  usageForecast: UsageForecast;
  commercial: CommercialRequirements;
  support: SupportRequirements;
  referralSource?: string;
  consent: ConsentEvidence;
}

model PreInterestReceipt {
  submissionId: OpaqueId;
  status: "email_verification_pending" | "interest_verified";
  verificationRequired: boolean;
  createdAt: Timestamp;
}

model ApplicationDocument {
  schema: "fiducia.application.v1";
  documentType: "application";
  applicationId: OpaqueId;
  organizationId: OpaqueId;
  version: int32;
  status: ApplicationStatus;
  etag: Sha256Digest;
  organization: Organization;
  stakeholders: Contact[];
  need: NeedSummary;
  usageForecast: UsageForecast;
  technical: TechnicalRequirements;
  dataSecurity: DataSecurityRequirements;
  migration: MigrationRequirements;
  commercial: CommercialRequirements;
  support: SupportRequirements;
  legal: LegalRequirements;
  attachments: AttachmentReference[];
  authorizedToSubmit: true;
  informationAccurate: true;
  privacyPolicyVersion: string;
  updatedAt: Timestamp;
  submittedAt?: Timestamp;
}

model ApplicationPatch {
  organization?: Organization;
  stakeholders?: Contact[];
  need?: NeedSummary;
  usageForecast?: UsageForecast;
  technical?: TechnicalRequirements;
  dataSecurity?: DataSecurityRequirements;
  migration?: MigrationRequirements;
  commercial?: CommercialRequirements;
  support?: SupportRequirements;
  legal?: LegalRequirements;
}

model ContractReference {
  kind: ContractKind;
  templateId: OpaqueId;
  version: int32;
  contentSha256: Sha256Digest;
}

model QuoteLineItem {
  lineItemId: OpaqueId;
  category: QuoteLineCategory;
  description: string;
  metric: string;
  quantity: float64;
  unitPrice: Money;
  extendedPrice: Money;
  billingFrequency: "one-time" | "monthly" | "quarterly" | "annual" | "milestone";
  minimumQuantity?: float64;
  maximumQuantity?: float64;
  notes?: string;
}

model VersionedPolicyReference {
  id: OpaqueId;
  version: int32;
  contentSha256: Sha256Digest;
}

model QuoteDocument {
  schema: "fiducia.quote.v1";
  documentType: "quote";
  quoteId: OpaqueId;
  applicationId: OpaqueId;
  organizationId: OpaqueId;
  version: int32;
  status: QuoteStatus;
  currency: CurrencyCode;
  issuedAt: Timestamp;
  validUntil: Timestamp;
  termMonths: int32;
  billingStart?: CalendarDate;
  lineItems: QuoteLineItem[];
  subtotal: Money;
  discountTotal: Money;
  taxTotal: Money;
  total: Money;
  minimumCommitment?: Money;
  supportPlan: VersionedPolicyReference;
  slaPolicy: VersionedPolicyReference;
  contractReferences: ContractReference[];
  assumptions: string[];
  exclusions: string[];
  dependencies?: string[];
  supersedesQuoteVersion?: int32;
  contentSha256: Sha256Digest;
}

model Signer {
  fullName: string;
  workEmail: EmailAddress;
  title: string;
  authorityAttested: true;
}

model ContractAcceptanceRequest {
  schema: "fiducia.contract-acceptance.v1";
  documentType: "contract_acceptance";
  acceptanceId: OpaqueId;
  organizationId: OpaqueId;
  quoteId: OpaqueId;
  quoteVersion: int32;
  quoteSha256: Sha256Digest;
  contractReferences: ContractReference[];
  signer: Signer;
  signatureProvider: string;
  signatureEvidenceId: OpaqueId;
  acceptedAt: Timestamp;
  sourceIpHash: Sha256Digest;
  userAgentHash: Sha256Digest;
}

model ApiError {
  code: string;
  message: string;
  requestId: OpaqueId;
  retryable: boolean;
  fieldErrors?: FieldError[];
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
  targetStatus: ApplicationStatus;
  reasonCode: string;
  note?: string;
  assignedContactIds?: OpaqueId[];
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
