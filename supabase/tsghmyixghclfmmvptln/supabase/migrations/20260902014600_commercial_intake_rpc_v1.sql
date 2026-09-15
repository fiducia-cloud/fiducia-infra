-- Service-role-only RPC for the public API tier. The private fiducia schema is
-- not exposed to browser roles, and no raw table endpoint is required.

create or replace function public.fiducia_submit_commercial_intake_v1(
    p_kind text,
    p_idempotency_key text,
    p_request_sha256 text,
    p_response_sha256 text,
    p_contact_email_sha256 text,
    p_source_host text,
    p_request_payload jsonb,
    p_response_payload jsonb,
    p_product_updates_consent boolean,
    p_privacy_notice_accepted boolean,
    p_submitter_authorized boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, fiducia
as $$
declare
    stored fiducia.commercial_intake_submissions%rowtype;
    inserted boolean := false;
begin
    insert into fiducia.commercial_intake_submissions (
        kind,
        idempotency_key,
        request_sha256,
        response_sha256,
        contact_email_sha256,
        source_host,
        request_payload,
        response_payload,
        product_updates_consent,
        privacy_notice_accepted,
        submitter_authorized
    ) values (
        p_kind,
        p_idempotency_key,
        p_request_sha256,
        p_response_sha256,
        p_contact_email_sha256,
        p_source_host,
        p_request_payload,
        p_response_payload,
        p_product_updates_consent,
        p_privacy_notice_accepted,
        p_submitter_authorized
    )
    on conflict (kind, idempotency_key) do nothing
    returning * into stored;

    inserted := found;
    if not inserted then
        select * into strict stored
        from fiducia.commercial_intake_submissions
        where kind = p_kind and idempotency_key = p_idempotency_key;

        if stored.request_sha256 <> p_request_sha256 then
            raise exception 'idempotency key reused with a different request'
                using errcode = '23505';
        end if;
    end if;

    return jsonb_build_object(
        'submission_id', stored.id,
        'created_at', stored.created_at,
        'response_payload', stored.response_payload,
        'idempotent_replay', not inserted
    );
end;
$$;

revoke all on function public.fiducia_submit_commercial_intake_v1(
    text, text, text, text, text, text, jsonb, jsonb, boolean, boolean, boolean
) from public;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke all on function public.fiducia_submit_commercial_intake_v1(
            text, text, text, text, text, text, jsonb, jsonb, boolean, boolean, boolean
        ) from anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        revoke all on function public.fiducia_submit_commercial_intake_v1(
            text, text, text, text, text, text, jsonb, jsonb, boolean, boolean, boolean
        ) from authenticated;
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        grant execute on function public.fiducia_submit_commercial_intake_v1(
            text, text, text, text, text, text, jsonb, jsonb, boolean, boolean, boolean
        ) to service_role;
    end if;
end;
$$;
