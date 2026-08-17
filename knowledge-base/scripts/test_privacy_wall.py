#!/usr/bin/env python3
"""Regression tests for the public mmrag shared-collection allowlist wall."""

import tempfile
import unittest
from pathlib import Path

import mmrag


class PrivacyWallTests(unittest.TestCase):
    def test_private_collection_does_not_apply_shared_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            outside = Path(root) / "outside" / "record.md"
            self.assertTrue(
                mmrag._shared_allowlist_check(
                    outside,
                    "agent-regression",
                    {"shared_ingest_allowlist": [str(Path(root) / "allowed")]},
                )
            )

    def test_shared_collection_without_configured_allowlist_keeps_legacy_open_behavior(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            self.assertTrue(
                mmrag._shared_allowlist_check(
                    Path(root) / "record.md", "shared-regression", {}
                )
            )

    def test_shared_allowlist_accepts_exact_path_and_descendants(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            allowed = Path(root) / "allowed"
            config = {"shared_ingest_allowlist": [str(allowed.resolve())]}

            self.assertTrue(
                mmrag._shared_allowlist_check(
                    allowed, "shared-regression", config
                )
            )
            self.assertTrue(
                mmrag._shared_allowlist_check(
                    allowed / "nested" / "record.md", "shared-regression", config
                )
            )

    def test_shared_allowlist_rejects_sibling_prefixes(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            allowed = Path(root) / "allowed"
            config = {"shared_ingest_allowlist": [str(allowed.resolve())]}

            self.assertFalse(
                mmrag._shared_allowlist_check(
                    Path(root) / "allowed-copy" / "record.md",
                    "shared-regression",
                    config,
                )
            )


if __name__ == "__main__":
    unittest.main()
