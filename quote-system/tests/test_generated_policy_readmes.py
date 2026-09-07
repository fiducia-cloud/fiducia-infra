from __future__ import annotations

import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
POLICY_MARKERS = {
    "<!-- generated-policy: frozen -->",
    "<!-- generated-policy: ignored -->",
    "<!-- generated-policy: writable -->",
}


class GeneratedPolicyReadmeTests(unittest.TestCase):
    def policy_for(self, directory: Path) -> str:
        readme = directory / "README.md"
        self.assertTrue(readme.is_file(), f"{directory.relative_to(ROOT)} lacks README.md")
        first_line = readme.read_text(encoding="utf-8").splitlines()[0]
        self.assertIn(
            first_line,
            POLICY_MARKERS,
            f"{readme.relative_to(ROOT)} lacks an exact generated-policy marker",
        )
        return first_line

    def test_every_committed_quote_system_generated_tree_declares_policy(self) -> None:
        generated = sorted(
            path
            for path in (ROOT / "quote-system").rglob("generated")
            if path.is_dir()
        )
        self.assertGreaterEqual(len(generated), 2)
        for directory in generated:
            with self.subTest(directory=directory.relative_to(ROOT)):
                self.policy_for(directory)

    def test_ephemeral_contract_projection_is_explicitly_ignored(self) -> None:
        directory = ROOT / "quote-system" / "generated"
        self.assertEqual(self.policy_for(directory), "<!-- generated-policy: ignored -->")
        rules = set((directory / ".gitignore").read_text(encoding="utf-8").splitlines())
        self.assertTrue({"*", "!.gitignore", "!README.md"}.issubset(rules))

    def test_rust_manifest_projection_is_frozen_and_parseable(self) -> None:
        directory = ROOT / "quote-system" / "rust" / "generated"
        self.assertEqual(self.policy_for(directory), "<!-- generated-policy: frozen -->")
        manifest = json.loads((directory / "model-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema"], "fiducia_commercial")
        self.assertEqual(manifest["source"], "../db/0001_commercial_intake.sql")
        self.assertEqual(manifest["typeSpec"], "../contracts/main.tsp")
        self.assertEqual(manifest["jsonSchema"], "../contracts/commercial-intake.schema.json")
        self.assertGreater(len(manifest["tables"]), 20)


if __name__ == "__main__":
    unittest.main()
