#!/usr/bin/env python3
"""Generate and verify SeaORM and Diesel projections for Fiducia commercial intake."""

from __future__ import annotations

import argparse
import difflib
import json
import sys
from pathlib import Path

from model_contract import (
    QUOTE_SYSTEM_ROOT,
    SQL_PATH,
    ContractError,
    load_manifest,
    parse_sql_tables,
    validate_manifest_against_sql,
    validate_transport_contracts,
)
from model_render import generated_outputs


def write_outputs(outputs: dict[Path, str]) -> None:
    for path, content in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        print(f"wrote {path.relative_to(QUOTE_SYSTEM_ROOT.parent)}")


def check_outputs(outputs: dict[Path, str]) -> None:
    mismatches: list[str] = []
    for path, expected in outputs.items():
        actual = path.read_text(encoding="utf-8") if path.exists() else ""
        if actual != expected:
            diff = "\n".join(
                difflib.unified_diff(
                    actual.splitlines(),
                    expected.splitlines(),
                    fromfile=str(path),
                    tofile=f"{path} (regenerated)",
                    lineterm="",
                    n=3,
                )
            )
            mismatches.append(diff)
    if mismatches:
        raise ContractError(
            "generated model drift detected; run model_codegen.py --write:\n"
            + "\n".join(mismatches)
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="verify committed outputs")
    mode.add_argument("--write", action="store_true", help="rewrite generated outputs")
    arguments = parser.parse_args()

    try:
        manifest = load_manifest()
        parsed_tables = parse_sql_tables(SQL_PATH.read_text(encoding="utf-8"))
        validate_manifest_against_sql(manifest, parsed_tables)
        validate_transport_contracts()
        outputs = generated_outputs(manifest)
        if arguments.write:
            write_outputs(outputs)
        else:
            check_outputs(outputs)
    except (ContractError, OSError, json.JSONDecodeError, KeyError) as error:
        print(f"model contract verification failed: {error}", file=sys.stderr)
        return 1

    print(
        f"verified {len(manifest['tables'])} SQL tables across TypeSpec, "
        "JSON Schema, SeaORM, and Diesel projections"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
