from __future__ import annotations

from collections import deque
from datetime import date, datetime
from decimal import Decimal
import json
import math
from pathlib import Path
import re
import unittest
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "contracts" / "commercial-intake.schema.json"
TYPESPEC_PATH = ROOT / "contracts" / "main.tsp"
ROUTES_PATH = ROOT / "cloudflare" / "routes.template.json"
ROUTES_SCHEMA_PATH = ROOT / "cloudflare" / "routes.template.schema.json"
MIGRATION_PATH = ROOT / "db" / "0001_commercial_intake.sql"
EXAMPLES = ROOT / "examples"

HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
OPAQUE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$")
HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*"
    r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$"
)
SECRET_PATTERNS = (
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"lin_api_[A-Za-z0-9]{20,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"AGE-SECRET-KEY-1[A-Z0-9]+"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
)

EXPECTED_EXAMPLE_SCHEMAS = {
    "pre-interest.json": "fiducia.pre-interest.v1",
    "full-application.json": "fiducia.application.v1",
    "support-plan.json": "fiducia.support-plan.v1",
    "sla-policy.json": "fiducia.sla-policy.v1",
    "quote.json": "fiducia.quote.v1",
    "contract-acceptance.json": "fiducia.contract-acceptance.v1",
}

SCHEMA_TO_DEFINITION = {
    "fiducia.pre-interest.v1": "preInterest",
    "fiducia.application.v1": "application",
    "fiducia.support-plan.v1": "supportPlan",
    "fiducia.sla-policy.v1": "slaPolicy",
    "fiducia.quote.v1": "quote",
    "fiducia.contract-acceptance.v1": "contractAcceptance",
}

EXPECTED_ROUTE_HOSTS = {
    "public-app": "app.${FIDUCIA_ZONE_APEX}",
    "public-api": "api.${FIDUCIA_ZONE_APEX}",
    "admin-app": "admin.${FIDUCIA_ZONE_APEX}",
    "admin-api": "admin-api.${FIDUCIA_ZONE_APEX}",
    "auth": "auth.${FIDUCIA_ZONE_APEX}",
    "user": "user.${FIDUCIA_ZONE_APEX}",
    "organization": "org.${FIDUCIA_ZONE_APEX}",
    "status": "status.${FIDUCIA_ZONE_APEX}",
}

EXPECTED_TENANT_TABLES = {
    "organizations",
    "contacts",
    "organization_contact_roles",
    "pre_interest_registrations",
    "applications",
    "application_versions",
    "attachments",
    "support_plans",
    "support_plan_versions",
    "sla_policies",
    "sla_policy_versions",
    "contract_templates",
    "contract_template_versions",
    "quotes",
    "quote_versions",
    "quote_line_items",
    "quote_contract_references",
    "contract_acceptances",
    "workflow_events",
    "idempotency_records",
    "outbox_events",
}

EXPECTED_IMMUTABLE_TABLES = {
    "application_versions",
    "support_plan_versions",
    "sla_policy_versions",
    "contract_template_versions",
    "quote_versions",
    "quote_line_items",
    "quote_contract_references",
    "contract_acceptances",
    "workflow_events",
}

TERMINAL_STATES = {"active", "declined", "withdrawn", "expired", "superseded"}


class ValidationError(AssertionError):
    pass


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def json_pointer_resolve(document: dict, reference: str):
    if not reference.startswith("#/"):
        raise ValidationError(f"external JSON Schema reference is forbidden: {reference}")
    value = document
    for raw_part in reference[2:].split("/"):
        part = raw_part.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, dict) or part not in value:
            raise ValidationError(f"unresolved JSON Schema reference: {reference}")
        value = value[part]
    return value


def describe_path(path: tuple[object, ...]) -> str:
    if not path:
        return "$"
    rendered = "$"
    for part in path:
        if isinstance(part, int):
            rendered += f"[{part}]"
        else:
            rendered += f".{part}"
    return rendered


def check_format(value: str, format_name: str, path: tuple[object, ...]) -> None:
    location = describe_path(path)
    if format_name == "email":
        if value.count("@") != 1 or value.startswith("@") or value.endswith("@"):
            raise ValidationError(f"{location}: invalid email")
    elif format_name == "date":
        try:
            date.fromisoformat(value)
        except ValueError as error:
            raise ValidationError(f"{location}: invalid ISO date") from error
    elif format_name == "date-time":
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValidationError(f"{location}: invalid ISO date-time") from error
    elif format_name == "uri":
        parsed = urlparse(value)
        if not parsed.scheme or not parsed.netloc:
            raise ValidationError(f"{location}: invalid absolute URI")
    elif format_name == "hostname":
        if not HOSTNAME_RE.fullmatch(value):
            raise ValidationError(f"{location}: invalid hostname")


def validate_instance(
    instance,
    schema: dict,
    schema_root: dict,
    path: tuple[object, ...] = (),
) -> None:
    if "$ref" in schema:
        validate_instance(instance, json_pointer_resolve(schema_root, schema["$ref"]), schema_root, path)
        return

    if "oneOf" in schema:
        errors: list[Exception] = []
        matches = 0
        for candidate in schema["oneOf"]:
            try:
                validate_instance(instance, candidate, schema_root, path)
            except (ValidationError, AssertionError, TypeError, ValueError) as error:
                errors.append(error)
            else:
                matches += 1
        if matches != 1:
            raise ValidationError(
                f"{describe_path(path)}: expected exactly one oneOf match, observed {matches}; "
                f"candidate errors={len(errors)}"
            )
        return

    if "const" in schema and instance != schema["const"]:
        raise ValidationError(f"{describe_path(path)}: value does not match const")
    if "enum" in schema and instance not in schema["enum"]:
        raise ValidationError(f"{describe_path(path)}: value is not in enum")

    expected_type = schema.get("type")
    if expected_type == "object":
        if not isinstance(instance, dict):
            raise ValidationError(f"{describe_path(path)}: expected object")
        required = schema.get("required", [])
        missing = [key for key in required if key not in instance]
        if missing:
            raise ValidationError(f"{describe_path(path)}: missing required properties {missing}")
        properties = schema.get("properties", {})
        for key, value in instance.items():
            if key in properties:
                validate_instance(value, properties[key], schema_root, path + (key,))
            elif schema.get("additionalProperties") is False:
                raise ValidationError(f"{describe_path(path + (key,))}: additional property is forbidden")
    elif expected_type == "array":
        if not isinstance(instance, list):
            raise ValidationError(f"{describe_path(path)}: expected array")
        if len(instance) < schema.get("minItems", 0):
            raise ValidationError(f"{describe_path(path)}: too few items")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            raise ValidationError(f"{describe_path(path)}: too many items")
        if schema.get("uniqueItems"):
            canonical = [json.dumps(item, sort_keys=True, separators=(",", ":")) for item in instance]
            if len(canonical) != len(set(canonical)):
                raise ValidationError(f"{describe_path(path)}: duplicate array items")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, value in enumerate(instance):
                validate_instance(value, item_schema, schema_root, path + (index,))
    elif expected_type == "string":
        if not isinstance(instance, str):
            raise ValidationError(f"{describe_path(path)}: expected string")
        if len(instance) < schema.get("minLength", 0):
            raise ValidationError(f"{describe_path(path)}: string is too short")
        if "maxLength" in schema and len(instance) > schema["maxLength"]:
            raise ValidationError(f"{describe_path(path)}: string is too long")
        pattern = schema.get("pattern")
        if pattern is not None and re.search(pattern, instance) is None:
            raise ValidationError(f"{describe_path(path)}: string does not match pattern")
        if "format" in schema:
            check_format(instance, schema["format"], path)
    elif expected_type == "integer":
        if isinstance(instance, bool) or not isinstance(instance, int):
            raise ValidationError(f"{describe_path(path)}: expected integer")
    elif expected_type == "number":
        if isinstance(instance, bool) or not isinstance(instance, (int, float)):
            raise ValidationError(f"{describe_path(path)}: expected number")
        if isinstance(instance, float) and not math.isfinite(instance):
            raise ValidationError(f"{describe_path(path)}: number must be finite")
    elif expected_type == "boolean":
        if not isinstance(instance, bool):
            raise ValidationError(f"{describe_path(path)}: expected boolean")

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            raise ValidationError(f"{describe_path(path)}: number is below minimum")
        if "maximum" in schema and instance > schema["maximum"]:
            raise ValidationError(f"{describe_path(path)}: number is above maximum")


def walk_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from walk_strings(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from walk_strings(item)


def severity_map(document: dict) -> dict[str, dict]:
    targets = document["severity_targets"]
    return {target["severity"]: target for target in targets}


def assert_severity_order(test: unittest.TestCase, document: dict) -> None:
    targets = severity_map(document)
    test.assertEqual(set(targets), {"P1", "P2", "P3", "P4"})
    test.assertEqual(len(document["severity_targets"]), 4)
    ordered = [targets[key] for key in ("P1", "P2", "P3", "P4")]
    for field in (
        "initial_response_minutes",
        "update_interval_minutes",
        "mitigation_target_minutes",
        "restoration_target_minutes",
    ):
        values = [target[field] for target in ordered]
        test.assertEqual(values, sorted(values), f"{field} must not become stricter at lower severities")
    for target in ordered:
        test.assertLessEqual(target["initial_response_minutes"], target["mitigation_target_minutes"])
        test.assertLessEqual(target["mitigation_target_minutes"], target["restoration_target_minutes"])


class CommercialContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = load_json(CONTRACT_PATH)
        cls.route_schema = load_json(ROUTES_SCHEMA_PATH)
        cls.routes = load_json(ROUTES_PATH)
        cls.examples = {path.name: load_json(path) for path in sorted(EXAMPLES.glob("*.json"))}
        cls.sql = MIGRATION_PATH.read_text(encoding="utf-8")
        cls.typespec = TYPESPEC_PATH.read_text(encoding="utf-8")

    def test_expected_files_and_document_kinds_exist(self) -> None:
        self.assertEqual(set(self.examples), set(EXPECTED_EXAMPLE_SCHEMAS))
        for filename, expected_schema in EXPECTED_EXAMPLE_SCHEMAS.items():
            self.assertEqual(self.examples[filename]["schema"], expected_schema)

    def test_json_schema_uses_draft_2020_12_and_local_references(self) -> None:
        self.assertEqual(self.schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
        self.assertEqual(self.route_schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
        self.assertEqual(
            {entry["$ref"] for entry in self.schema["oneOf"]},
            {f"#/$defs/{name}" for name in SCHEMA_TO_DEFINITION.values()},
        )
        serialized = json.dumps(self.schema)
        references = re.findall(r'"\$ref":\s*"([^"]+)"', serialized)
        self.assertTrue(references)
        self.assertTrue(all(reference.startswith("#/") for reference in references))
        for reference in references:
            json_pointer_resolve(self.schema, reference)

    def test_every_example_validates_against_its_definition(self) -> None:
        for filename, document in self.examples.items():
            with self.subTest(filename=filename):
                definition_name = SCHEMA_TO_DEFINITION[document["schema"]]
                validate_instance(document, self.schema["$defs"][definition_name], self.schema)

    def test_root_one_of_selects_exactly_one_document_kind(self) -> None:
        for filename, document in self.examples.items():
            with self.subTest(filename=filename):
                validate_instance(document, self.schema, self.schema)

    def test_state_graph_has_a_path_to_active_and_terminal_states_are_closed(self) -> None:
        transitions = self.schema["x-fiducia-state-transitions"]
        self.assertIn("interest_draft", transitions)
        self.assertIn("active", transitions)
        for source, targets in transitions.items():
            self.assertEqual(len(targets), len(set(targets)), f"duplicate transition from {source}")
            for target in targets:
                self.assertIn(target, transitions, f"transition target {target} is not declared")
        for terminal in TERMINAL_STATES:
            self.assertEqual(transitions[terminal], [], f"terminal state {terminal} must have no outgoing edges")

        queue = deque(["interest_draft"])
        observed = {"interest_draft"}
        while queue:
            state = queue.popleft()
            for target in transitions[state]:
                if target not in observed:
                    observed.add(target)
                    queue.append(target)
        self.assertIn("active", observed)
        self.assertTrue(TERMINAL_STATES.issubset(observed))
        self.assertNotIn("active", transitions["provisioning"][:-1])

    def test_support_and_sla_severity_targets_are_complete_and_monotonic(self) -> None:
        assert_severity_order(self, self.examples["pre-interest.json"]["support"])
        assert_severity_order(self, self.examples["full-application.json"]["support"])
        assert_severity_order(self, self.examples["support-plan.json"])
        assert_severity_order(self, self.examples["sla-policy.json"])

    def test_sla_credit_tiers_become_more_generous_as_availability_worsens(self) -> None:
        sla = self.examples["sla-policy.json"]
        tiers = sla["service_credits"]["tiers"]
        thresholds = [tier["availability_below_bps"] for tier in tiers]
        credits = [Decimal(str(tier["credit_percent"])) for tier in tiers]
        self.assertEqual(thresholds, sorted(thresholds, reverse=True))
        self.assertEqual(len(thresholds), len(set(thresholds)))
        self.assertEqual(credits, sorted(credits))
        self.assertEqual(len(credits), len(set(credits)))
        cap = Decimal(str(sla["service_credits"]["monthly_cap_percent"]))
        self.assertTrue(all(credit <= cap for credit in credits))
        self.assertEqual(thresholds[0], sla["availability_target_bps"])
        self.assertLessEqual(sla["rpo_minutes"], sla["rto_minutes"])

    def test_quote_arithmetic_currency_and_versioned_policy_bindings(self) -> None:
        quote = self.examples["quote.json"]
        currency = quote["currency"]
        subtotal_from_lines = 0
        for line in quote["line_items"]:
            self.assertEqual(line["unit_price"]["currency"], currency)
            self.assertEqual(line["extended_price"]["currency"], currency)
            calculated = Decimal(str(line["quantity"])) * Decimal(line["unit_price"]["minor_units"])
            self.assertEqual(calculated, Decimal(line["extended_price"]["minor_units"]))
            subtotal_from_lines += line["extended_price"]["minor_units"]

        for field in ("subtotal", "discount_total", "tax_total", "total", "minimum_commitment"):
            self.assertEqual(quote[field]["currency"], currency)
        self.assertEqual(subtotal_from_lines, quote["subtotal"]["minor_units"])
        self.assertEqual(
            quote["subtotal"]["minor_units"]
            - quote["discount_total"]["minor_units"]
            + quote["tax_total"]["minor_units"],
            quote["total"]["minor_units"],
        )
        self.assertLessEqual(quote["minimum_commitment"]["minor_units"], quote["total"]["minor_units"])

        support = self.examples["support-plan.json"]
        sla = self.examples["sla-policy.json"]
        self.assertEqual(quote["support_plan"]["support_plan_id"], support["support_plan_id"])
        self.assertEqual(quote["support_plan"]["version"], support["version"])
        self.assertEqual(quote["support_plan"]["content_sha256"], support["content_sha256"])
        self.assertEqual(quote["sla_policy"]["sla_policy_id"], sla["sla_policy_id"])
        self.assertEqual(quote["sla_policy"]["version"], sla["version"])
        self.assertEqual(quote["sla_policy"]["content_sha256"], sla["content_sha256"])

    def test_contract_acceptance_binds_the_exact_quote_and_contract_set(self) -> None:
        quote = self.examples["quote.json"]
        acceptance = self.examples["contract-acceptance.json"]
        self.assertEqual(acceptance["quote_id"], quote["quote_id"])
        self.assertEqual(acceptance["quote_version"], quote["version"])
        self.assertEqual(acceptance["quote_sha256"], quote["content_sha256"])
        self.assertTrue(acceptance["signer"]["authority_attested"])

        def identity(reference: dict) -> tuple[str, str, int, str]:
            return (
                reference["kind"],
                reference["template_id"],
                reference["version"],
                reference["content_sha256"],
            )

        self.assertEqual(
            {identity(reference) for reference in acceptance["contract_references"]},
            {identity(reference) for reference in quote["contract_references"]},
        )
        self.assertTrue(HASH_RE.fullmatch(acceptance["source_ip_hash"]))
        self.assertTrue(HASH_RE.fullmatch(acceptance["user_agent_hash"]))

    def test_identifiers_and_hashes_are_opaque_and_bounded(self) -> None:
        for filename, document in self.examples.items():
            encoded = json.dumps(document)
            for key, value in self._walk_items(document):
                if key.endswith("_sha256") or key in {"etag", "content_sha256"}:
                    self.assertRegex(value, HASH_RE, f"{filename}:{key}")
                if key.endswith("_id") and key not in {"tax_identifier", "registration_number"}:
                    self.assertRegex(value, OPAQUE_ID_RE, f"{filename}:{key}")
            self.assertNotRegex(encoded, r'"(?:password|private_key|api_token|access_token|refresh_token)"\s*:')

    def test_examples_contain_no_live_credential_shapes(self) -> None:
        for filename, document in self.examples.items():
            text = json.dumps(document, sort_keys=True)
            for pattern in SECRET_PATTERNS:
                self.assertIsNone(pattern.search(text), f"{filename} contains a credential-shaped value")
            for value in walk_strings(document):
                if "." in value and "://" not in value and value.count(".") >= 1:
                    if HOSTNAME_RE.fullmatch(value):
                        self.assertTrue(
                            value == "example.com" or value.endswith(".example.com"),
                            f"{filename} contains non-example hostname {value}",
                        )

    def test_cloudflare_route_contract_is_placeholder_only_and_separated(self) -> None:
        validate_instance(self.routes, self.route_schema, self.route_schema)
        roles = {route["role"]: route for route in self.routes["routes"]}
        self.assertEqual(set(roles), set(EXPECTED_ROUTE_HOSTS))
        for role, expected_host in EXPECTED_ROUTE_HOSTS.items():
            route = roles[role]
            self.assertEqual(route["hostname_template"], expected_host)
            self.assertEqual(route["hostname_template"].count("${FIDUCIA_ZONE_APEX}"), 1)
            self.assertRegex(route["origin_env"], r"^FIDUCIA_[A-Z0-9_]+_ORIGIN$")
            self.assertNotIn("http://", route["hostname_template"])
            self.assertNotIn("https://", route["hostname_template"])
        self.assertNotEqual(roles["public-api"]["origin_env"], roles["admin-api"]["origin_env"])
        self.assertIn("separate-audience", roles["admin-api"]["rate_limit_policy"])
        self.assertEqual(self.routes["defaults"]["tls_mode"], "strict")
        self.assertEqual(self.routes["defaults"]["health_path"], "/healthz")
        self.assertEqual(self.routes["defaults"]["readiness_path"], "/readyz")
        self.assertLessEqual(self.routes["defaults"]["request_body_limit_bytes"], 16 * 1024 * 1024)

        route_text = ROUTES_PATH.read_text(encoding="utf-8")
        for pattern in SECRET_PATTERNS:
            self.assertIsNone(pattern.search(route_text))
        self.assertIsNone(re.search(r'"(?:account_id|zone_id)"\s*:\s*"[0-9a-f]{16,}"', route_text, re.I))
        concrete_domains = re.findall(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", route_text)
        self.assertEqual(concrete_domains, [])

    def test_postgres_model_forces_tenant_rls_and_append_only_versions(self) -> None:
        sql_lower = self.sql.lower()
        self.assertIn("current_setting('app.tenant_id', true)", self.sql)
        self.assertNotIn("security definer", sql_lower)
        self.assertIn("enable row level security", sql_lower)
        self.assertIn("force row level security", sql_lower)
        self.assertIn("reject_immutable_mutation", self.sql)
        self.assertIn("validate_workflow_transition", self.sql)
        self.assertIn("idempotency_records", self.sql)
        self.assertIn("outbox_events", self.sql)
        self.assertIn("dead_lettered_at", self.sql)
        self.assertNotIn("gen_random_uuid", sql_lower)
        self.assertNotIn("uuid_generate", sql_lower)

        created_tables = set(re.findall(r"create table if not exists fiducia_commercial\.([a-z0-9_]+)", sql_lower))
        self.assertTrue(EXPECTED_TENANT_TABLES.issubset(created_tables))
        for table in EXPECTED_TENANT_TABLES:
            self.assertRegex(self.sql, rf"(?s)'{re.escape(table)}'.*tenant_isolation|tenant_isolation.*'{re.escape(table)}'")
        for table in EXPECTED_IMMUTABLE_TABLES:
            self.assertIn(f"'{table}'", self.sql)
        self.assertNotRegex(sql_lower, r"\bfull_name\s+text\b")
        self.assertNotRegex(sql_lower, r"\bwork_email\s+text\b")
        self.assertNotRegex(sql_lower, r"\bsource_ip\s+(?:inet|text)\b")
        self.assertNotRegex(sql_lower, r"\buser_agent\s+text\b")
        self.assertIn("full_name_ciphertext", sql_lower)
        self.assertIn("work_email_ciphertext", sql_lower)
        self.assertIn("source_ip_hash", sql_lower)
        self.assertIn("user_agent_hash", sql_lower)

    def test_sql_and_json_state_transitions_are_identical(self) -> None:
        json_edges = {
            (source, target)
            for source, targets in self.schema["x-fiducia-state-transitions"].items()
            for target in targets
        }
        values_block = self.sql.split(
            "INSERT INTO fiducia_commercial.workflow_transition_rules (from_state, to_state)", 1
        )[1].split("ON CONFLICT DO NOTHING", 1)[0]
        sql_edges = set(re.findall(r"\('([a-z_]+)', '([a-z_]+)'\)", values_block))
        self.assertEqual(sql_edges, json_edges)

    def test_typespec_exposes_public_and_separately_named_admin_operations(self) -> None:
        required_markers = (
            'import "@typespec/http";',
            'import "@typespec/rest";',
            '@route("/v1/pre-interest")',
            '@route("/v1/applications")',
            '@route("/v1/applications/{applicationId}")',
            '@route("/v1/quotes/{quoteId}")',
            '@route("/v1/admin/applications/{applicationId}")',
            '@route("/v1/admin/quotes")',
            '@header("Idempotency-Key")',
            '@header("If-Match")',
            "separate auth audience",
        )
        for marker in required_markers:
            self.assertIn(marker, self.typespec)
        self.assertGreaterEqual(self.typespec.count('@header("Idempotency-Key")'), 7)
        self.assertGreaterEqual(self.typespec.count('@header("If-Match")'), 5)
        self.assertNotIn("api_key", self.typespec.lower())
        self.assertNotIn("private_key", self.typespec.lower())
        for pattern in SECRET_PATTERNS:
            self.assertIsNone(pattern.search(self.typespec))

    @staticmethod
    def _walk_items(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if isinstance(item, (dict, list)):
                    yield from CommercialContractTests._walk_items(item)
                else:
                    yield key, item
        elif isinstance(value, list):
            for item in value:
                yield from CommercialContractTests._walk_items(item)


if __name__ == "__main__":
    unittest.main()
