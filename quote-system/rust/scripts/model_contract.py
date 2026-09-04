"""Validate Fiducia commercial model sources against the reviewed manifest."""

from __future__ import annotations

import difflib
import json
import re
from pathlib import Path
from typing import Any

RUST_ROOT = Path(__file__).resolve().parents[1]
QUOTE_SYSTEM_ROOT = RUST_ROOT.parent
MANIFEST_PATH = RUST_ROOT / "generated" / "model-manifest.json"
SQL_PATH = QUOTE_SYSTEM_ROOT / "db" / "0001_commercial_intake.sql"
TYPESPEC_PATH = QUOTE_SYSTEM_ROOT / "contracts" / "main.tsp"
JSON_SCHEMA_PATH = QUOTE_SYSTEM_ROOT / "contracts" / "commercial-intake.schema.json"

SEAORM_DIRECTORY = (
    RUST_ROOT
    / "crates"
    / "fiducia-commercial-seaorm"
    / "src"
    / "entities"
)
SEAORM_MOD_PATH = SEAORM_DIRECTORY / "mod.rs"
SEAORM_PART_PATHS = tuple(
    SEAORM_DIRECTORY / f"part_{index:02d}.rs" for index in range(1, 5)
)
DIESEL_SCHEMA_PATH = (
    RUST_ROOT
    / "crates"
    / "fiducia-commercial-diesel"
    / "src"
    / "schema.rs"
)
DIESEL_MODELS_PATH = (
    RUST_ROOT
    / "crates"
    / "fiducia-commercial-diesel"
    / "src"
    / "models.rs"
)

TABLE_RE = re.compile(
    r"CREATE TABLE IF NOT EXISTS fiducia_commercial\.([a-z][a-z0-9_]*) \(\n"
    r"(.*?)\n\);",
    re.DOTALL,
)
COLUMN_RE = re.compile(
    r"^  (?P<name>[a-z][a-z0-9_]*) "
    r"(?P<sql_type>text|char\(\d+\)|timestamptz|jsonb|integer|bigint|boolean|"
    r"numeric\(\d+,\d+\))(?P<rest>.*)$",
    re.MULTILINE,
)
PRIMARY_KEY_RE = re.compile(r"PRIMARY KEY \(([^)]+)\)")

SEA_TYPES = {
    "text": "String",
    "char(2)": "String",
    "char(3)": "String",
    "timestamptz": "DateTimeWithTimeZone",
    "jsonb": "Json",
    "integer": "i32",
    "bigint": "i64",
    "boolean": "bool",
    "numeric(24,6)": "Decimal",
}
DIESEL_SQL_TYPES = {
    "text": "Text",
    "char(2)": "Bpchar",
    "char(3)": "Bpchar",
    "timestamptz": "Timestamptz",
    "jsonb": "Jsonb",
    "integer": "Int4",
    "bigint": "Int8",
    "boolean": "Bool",
    "numeric(24,6)": "Numeric",
}
DIESEL_RUST_TYPES = {
    "text": "String",
    "char(2)": "String",
    "char(3)": "String",
    "timestamptz": "DateTime<Utc>",
    "jsonb": "Value",
    "integer": "i32",
    "bigint": "i64",
    "boolean": "bool",
    "numeric(24,6)": "BigDecimal",
}

REQUIRED_TYPESPEC_MODELS = (
    "PreInterestRequest",
    "ApplicationDocument",
    "QuoteDocument",
    "ContractAcceptanceRequest",
)
REQUIRED_JSON_DEFS = (
    "preInterest",
    "application",
    "supportPlan",
    "slaPolicy",
    "quote",
    "contractAcceptance",
)


class ContractError(RuntimeError):
    """Raised when a source or generated projection is inconsistent."""


def _optional(rust_type: str, nullable: bool) -> str:
    return f"Option<{rust_type}>" if nullable else rust_type


def load_manifest() -> dict[str, Any]:
    value = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if value.get("schema") != "fiducia_commercial":
        raise ContractError("model manifest must target fiducia_commercial")
    raw_tables = value.get("tables")
    if not isinstance(raw_tables, list) or not raw_tables:
        raise ContractError("model manifest must contain at least one table")

    tables: list[dict[str, Any]] = []
    for raw_table in raw_tables:
        if not isinstance(raw_table, list) or len(raw_table) != 4:
            raise ContractError("each compact table entry must have four items")
        table_name, model_name, primary_key, raw_columns = raw_table
        if not isinstance(raw_columns, list) or not raw_columns:
            raise ContractError(f"{table_name}: compact column list is empty")
        columns = []
        for raw_column in raw_columns:
            if not isinstance(raw_column, list) or len(raw_column) != 3:
                raise ContractError(
                    f"{table_name}: each compact column entry must have three items"
                )
            name, sql_type, nullable = raw_column
            columns.append(
                {"name": name, "sql_type": sql_type, "nullable": nullable}
            )
        tables.append(
            {
                "table": table_name,
                "model_name": model_name,
                "primary_key": primary_key,
                "columns": columns,
            }
        )

    return {**value, "tables": tables}


def parse_sql_tables(sql: str) -> list[dict[str, Any]]:
    parsed: list[dict[str, Any]] = []
    for table_match in TABLE_RE.finditer(sql):
        table_name, body = table_match.groups()
        primary_key_match = PRIMARY_KEY_RE.search(body)
        if primary_key_match is None:
            raise ContractError(f"{table_name}: missing PRIMARY KEY")

        columns: list[dict[str, Any]] = []
        for column_match in COLUMN_RE.finditer(body):
            rest = column_match.group("rest")
            columns.append(
                {
                    "name": column_match.group("name"),
                    "sql_type": column_match.group("sql_type"),
                    "nullable": "NOT NULL" not in rest,
                }
            )

        if not columns:
            raise ContractError(f"{table_name}: no columns parsed")

        parsed.append(
            {
                "table": table_name,
                "primary_key": [
                    item.strip()
                    for item in primary_key_match.group(1).split(",")
                ],
                "columns": columns,
            }
        )
    if not parsed:
        raise ContractError("no fiducia_commercial CREATE TABLE statements found")
    return parsed


def validate_manifest_against_sql(
    manifest: dict[str, Any], parsed_tables: list[dict[str, Any]]
) -> None:
    expected = []
    seen_model_names: set[str] = set()
    for table in manifest["tables"]:
        model_name = table.get("model_name")
        if not isinstance(model_name, str) or not model_name:
            raise ContractError(f"{table.get('table')}: missing model_name")
        if model_name in seen_model_names:
            raise ContractError(f"duplicate model_name: {model_name}")
        seen_model_names.add(model_name)
        expected.append(
            {
                "table": table["table"],
                "primary_key": table["primary_key"],
                "columns": table["columns"],
            }
        )

    if parsed_tables != expected:
        expected_text = json.dumps(expected, indent=2, sort_keys=True).splitlines()
        actual_text = json.dumps(parsed_tables, indent=2, sort_keys=True).splitlines()
        diff = "\n".join(
            difflib.unified_diff(
                expected_text,
                actual_text,
                fromfile="model-manifest.json",
                tofile="0001_commercial_intake.sql",
                lineterm="",
            )
        )
        raise ContractError(f"SQL/model manifest drift detected:\n{diff}")


def validate_transport_contracts() -> None:
    typespec = TYPESPEC_PATH.read_text(encoding="utf-8")
    for model in REQUIRED_TYPESPEC_MODELS:
        if f"model {model} " not in typespec and f"model {model}\n" not in typespec:
            raise ContractError(f"TypeSpec is missing model {model}")

    schema = json.loads(JSON_SCHEMA_PATH.read_text(encoding="utf-8"))
    if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
        raise ContractError("JSON Schema must remain Draft 2020-12")
    definitions = schema.get("$defs")
    if not isinstance(definitions, dict):
        raise ContractError("JSON Schema must contain $defs")
    missing = [name for name in REQUIRED_JSON_DEFS if name not in definitions]
    if missing:
        raise ContractError(f"JSON Schema is missing $defs: {', '.join(missing)}")


