#!/usr/bin/env python3
"""Model infrastructure-credit runway without encoding provider eligibility claims."""

from __future__ import annotations

import argparse
from dataclasses import dataclass


@dataclass(frozen=True)
class Runway:
    credit: float
    monthly_spend: float
    eligible_fraction: float

    @property
    def eligible_monthly_spend(self) -> float:
        return self.monthly_spend * self.eligible_fraction

    @property
    def months(self) -> float:
        spend = self.eligible_monthly_spend
        if spend <= 0:
            return float("inf")
        return self.credit / spend


def bounded_fraction(value: str) -> float:
    parsed = float(value)
    if not 0 <= parsed <= 1:
        raise argparse.ArgumentTypeError("eligible fraction must be between 0 and 1")
    return parsed


def nonnegative(value: str) -> float:
    parsed = float(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("value must be non-negative")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Estimate how long a fixed infrastructure credit covers eligible spend."
    )
    parser.add_argument("--credit", required=True, type=nonnegative)
    parser.add_argument("--monthly-spend", required=True, type=nonnegative)
    parser.add_argument("--eligible-fraction", type=bounded_fraction, default=1.0)
    args = parser.parse_args()

    runway = Runway(args.credit, args.monthly_spend, args.eligible_fraction)
    print(f"credit={runway.credit:.2f}")
    print(f"monthly_spend={runway.monthly_spend:.2f}")
    print(f"eligible_fraction={runway.eligible_fraction:.4f}")
    print(f"eligible_monthly_spend={runway.eligible_monthly_spend:.2f}")
    if runway.months == float("inf"):
        print("runway_months=inf")
    else:
        print(f"runway_months={runway.months:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
