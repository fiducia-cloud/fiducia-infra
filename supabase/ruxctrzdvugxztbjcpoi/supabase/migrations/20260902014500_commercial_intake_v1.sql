-- Fiducia commercial intake v1.
--
-- Declaration only: this migration is not evidence that a hosted database has
-- applied it. Provider deployment remains disabled until baseline/read-back,
-- backup, rollback, and branch-protection gates are independently satisfied.

create schema if not exists fiducia;

create table fiducia.commercial_intake_submissions (
    id uuid primary key default gen_random_uuid(),
    kind text not null check (
        kind in ('quote', 'pre_interest_registration', 'enterprise_application')
    ),
    idempotency_key text not null check (
        char_length(idempotency_key) between 16 and 200
        and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
    ),
    request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
    response_sha256 text not null check (response_sha256 ~ '^[0-9a-f]{64}$'),
    contact_email_sha256 text not null check (contact_email_sha256 ~ '^[0-9a-f]{64}$'),
    source_host text not null check (
        source_host in (
            'user.fiducia.cloud',
            'api.fiducia.cloud',
            'interest.fiducia.cloud',
            'quote.fiducia.cloud',
            'apply.fiducia.cloud',
            'fiducia-flutter'
        )
    ),
    contract_version text not null default 'commercial-intake-v1'
        check (contract_version = 'commercial-intake-v1'),
    request_payload jsonb not null check (jsonb_typeof(request_payload) = 'object'),
    response_payload jsonb not null check (jsonb_typeof(response_payload) = 'object'),
    product_updates_consent boolean not null default false,
    privacy_notice_accepted boolean not null,
    submitter_authorized boolean not null default false,
    review_status text not null default 'received'
        check (review_status in ('received', 'needs_clarification', 'under_review', 'accepted', 'declined')),
    owner_user_id uuid,
    created_at timestamptz not null default timezone('utc', now()),
    retention_expires_at timestamptz not null default (
        timezone('utc', now()) + interval '730 days'
    ),
    constraint commercial_intake_idempotency_unique unique (kind, idempotency_key),
    constraint commercial_intake_retention_forward check (retention_expires_at > created_at),
    constraint commercial_intake_authority_check check (
        kind <> 'enterprise_application' or submitter_authorized
    )
);

create index commercial_intake_created_at_idx
    on fiducia.commercial_intake_submissions (created_at desc);
create index commercial_intake_review_status_idx
    on fiducia.commercial_intake_submissions (review_status, created_at desc);
create index commercial_intake_email_digest_idx
    on fiducia.commercial_intake_submissions (contact_email_sha256, created_at desc);

comment on table fiducia.commercial_intake_submissions is
    'Private, append-only quote, pre-interest, and enterprise-application ledger. Requested SLA/SLO terms remain non-binding until a signed order form.';
comment on column fiducia.commercial_intake_submissions.request_payload is
    'Validated commercial-intake-v1 JSON. Credentials, access tokens, private keys, passwords, OTPs, and recovery phrases are forbidden by the API boundary.';

create or replace function fiducia.reject_commercial_intake_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
    raise exception 'commercial intake submissions are append-only';
end;
$$;

create trigger commercial_intake_append_only
before update or delete on fiducia.commercial_intake_submissions
for each row execute function fiducia.reject_commercial_intake_mutation();

alter table fiducia.commercial_intake_submissions enable row level security;
alter table fiducia.commercial_intake_submissions force row level security;

revoke all on schema fiducia from public;
revoke all on fiducia.commercial_intake_submissions from public;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke all on fiducia.commercial_intake_submissions from anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        revoke all on fiducia.commercial_intake_submissions from authenticated;
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        grant usage on schema fiducia to service_role;
        grant select, insert on fiducia.commercial_intake_submissions to service_role;
    end if;
end;
$$;
