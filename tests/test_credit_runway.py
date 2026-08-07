import importlib.util
from pathlib import Path
import math
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("credit_runway", ROOT / "tools" / "credit_runway.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class CreditRunwayTests(unittest.TestCase):
    def test_full_eligibility(self):
        model = MODULE.Runway(10000, 2000, 1.0)
        self.assertEqual(2000, model.eligible_monthly_spend)
        self.assertEqual(5, model.months)

    def test_partial_eligibility(self):
        model = MODULE.Runway(10000, 2000, 0.5)
        self.assertEqual(1000, model.eligible_monthly_spend)
        self.assertEqual(10, model.months)

    def test_zero_eligible_spend_is_infinite(self):
        model = MODULE.Runway(10000, 2000, 0.0)
        self.assertTrue(math.isinf(model.months))

    def test_fraction_validation(self):
        self.assertEqual(0.25, MODULE.bounded_fraction("0.25"))
        with self.assertRaises(Exception):
            MODULE.bounded_fraction("1.1")


if __name__ == "__main__":
    unittest.main()
