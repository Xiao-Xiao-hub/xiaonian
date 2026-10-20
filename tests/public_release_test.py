"""Public export boundaries: credential detection, precise exceptions and ZIPs."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


checker = module("public_checker_test", "check-public.py")
source_package = module("public_package_test", "package.py")


class PublicReleaseTests(unittest.TestCase):
    def test_secret_assignment_and_authenticated_urls_are_blocked_without_echo(self):
        # Deliberately assembled, invalid fixture values; never live credentials.
        fake = "not-a-real-" + "credential-value"
        files = {"server/src/config.ts": f'const apiKey = "{fake}";\nconst url = "https://user:{fake}@example.com/path";'.encode()}
        result = checker.scan(files)
        self.assertEqual({v["rule"] for v in result}, {"credential-literal", "url-credentials"})
        self.assertNotIn(fake, json.dumps(result))

    def test_private_key_header_is_blocked(self):
        marker = "-----BEGIN " + "PRIVATE KEY-----"
        self.assertEqual(checker.scan({"README.md": marker.encode()})[0]["rule"], "private-key")

    def test_test_directory_does_not_bypass_checks(self):
        files = {"tests/fixture.ts": b'const apiKey = "invalid-synthetic-value";'}
        self.assertTrue(checker.scan(files))
        digest = hashlib.sha256(b"apikey=invalid-synthetic-value").hexdigest()
        policy = {"syntheticValues": [{"path": "tests/fixture.ts", "rule": "credential-literal", "sha256": digest, "reason": "Explicit invalid fixture"}]}
        self.assertEqual(checker.scan(files, policy), [])
        self.assertTrue(checker.scan({"tests/other.ts": files["tests/fixture.ts"]}, policy))

    def test_env_example_requires_empty_or_known_placeholder(self):
        self.assertEqual(checker.scan({"server/.env.example": b"LLM_API_KEY=\nWECHAT_APP_SECRET=your_app_secret\n"}), [])
        self.assertTrue(checker.scan({"server/.env.example": b"LLM_API_KEY=unreviewed-value\n"}))

    def test_url_query_credential_is_detected(self):
        result = checker.scan({"README.md": b"https://example.com/api?access_token=invalid-fixture"})
        self.assertEqual(result[0]["rule"], "url-credential-query")

    def test_sensitive_files_and_unknown_binary_are_blocked(self):
        for name in [".env", "server/.env.production", "server/data/test.sqlite", "nested/archive.zip", "../secret.txt"]:
            self.assertTrue(checker.scan({name: b"not real data"}), name)
        self.assertTrue(checker.scan({"unknown.bin": b"\xff\x00"}))
        name, content = "miniprogram/assets/icon.png", b"\x89PNG\r\n\x1a\n"
        self.assertTrue(checker.scan({name: content}))
        policy = {"reviewedBinaryFiles": {name: hashlib.sha256(content).hexdigest()}}
        self.assertEqual(checker.scan({name: content}, policy), [])
        self.assertTrue(checker.scan({name: content + b"altered"}, policy))
        self.assertTrue(checker.scan({"miniprogram/assets/other.png": content}, policy))

    def test_external_and_broken_markdown_links_are_blocked(self):
        files = {"README.md": b"[private](../../docs/private.md)\n[missing](docs/missing.md)\n[valid](docs/api.md)", "docs/api.md": b"# API"}
        self.assertEqual({v["rule"] for v in checker.scan(files)}, {"external-local-link", "broken-local-link"})

    def test_git_snapshot_ignores_untracked_files_and_reads_committed_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def git(*args):
                return subprocess.check_output(["git", "-C", tmp, *args], stderr=subprocess.DEVNULL)
            git("init", "-q")
            git("config", "user.email", "fixture@example.com")
            git("config", "user.name", "Fixture")
            (root / "README.md").write_text("committed")
            git("add", "README.md")
            git("commit", "-qm", "fixture")
            (root / "README.md").write_text("uncommitted")
            (root / ".env").write_text("fixture")
            self.assertEqual(checker.source_files(root, "HEAD"), {"README.md": b"committed"})

    def test_extracted_manifest_detects_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            content = b"reviewed source"
            (root / "README.md").write_bytes(content)
            (root / "SHA256SUMS.json").write_text(json.dumps({"README.md": hashlib.sha256(content).hexdigest()}))
            self.assertEqual(checker.source_files(root), {"README.md": content})
            (root / "README.md").write_text("changed")
            with self.assertRaisesRegex(ValueError, "checksum"):
                checker.source_files(root)

    def test_extracted_manifest_rejects_symlinked_parent_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            root, outside = parent / "source", parent / "outside"
            root.mkdir()
            outside.mkdir()
            data = b"source outside the package"
            (outside / "file.txt").write_bytes(data)
            try:
                (root / "linked").symlink_to(outside, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"Directory symlinks unavailable: {error}")
            manifest = {"linked/file.txt": hashlib.sha256(data).hexdigest()}
            (root / "SHA256SUMS.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "Invalid manifest member"):
                checker.source_files(root)


class CommittedPackageTests(unittest.TestCase):
    """Run the real packaging CLI on a tiny repository and a fake scanner."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="public-package-tests-")
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        self.root = self.parent / "source"
        (self.root / "scripts").mkdir(parents=True)
        for name in ("package.py", "check-public.py"):
            shutil.copyfile(ROOT / "scripts" / name, self.root / "scripts" / name)
        (self.root / "README.md").write_text("Committed source.\n", encoding="utf-8")
        (self.root / ".gitleaks.toml").write_text('title = "Packaging fixture"\n', encoding="utf-8")
        (self.root / "scripts" / "utility.sh").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.com")
        self.git("config", "user.name", "Fixture")
        self.git("add", ".")
        # Set the Git index mode explicitly, including when tests run on Windows.
        self.git("update-index", "--chmod=+x", "scripts/utility.sh")
        self.git("update-index", "--chmod=-x", "README.md")
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "Packaging fixture")
        self.commit = self.git("rev-parse", "HEAD").strip()
        self.output = self.parent / "output" / "source.zip"
        self.env = {**os.environ, "GITLEAKS_BIN": str(self.scanner(0))}

    def git(self, *arguments):
        return subprocess.check_output(
            ["git", "-C", str(self.root), *arguments],
            text=True,
            stderr=subprocess.DEVNULL,
        )

    def scanner(self, exit_code):
        if os.name == "nt":
            path = self.parent / f"scanner-{exit_code}.cmd"
            path.write_text(f"@echo off\r\necho synthetic-scanner-output\r\nexit /b {exit_code}\r\n")
        else:
            path = self.parent / f"scanner-{exit_code}"
            path.write_text(f"#!/bin/sh\nprintf '%s\\n' 'synthetic-scanner-output'\nexit {exit_code}\n")
            path.chmod(0o700)
        return path

    def package(self, ref_option="--ref=HEAD", output=None, *extra):
        return subprocess.run(
            [
                sys.executable, str(self.root / "scripts" / "package.py"),
                ref_option, "--output", str(output or self.output), *extra,
            ],
            cwd=self.root,
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_ref_equals_packages_committed_bytes_and_excludes_local_files(self):
        (self.root / "README.md").write_text("Uncommitted source.\n", encoding="utf-8")
        (self.root / ".env").write_text("Synthetic local configuration.\n", encoding="utf-8")
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["commit"], self.commit)
        self.assertFalse((self.root / "--ref=HEAD").exists())
        with zipfile.ZipFile(self.output) as archive:
            manifest = json.loads(archive.read("xiaonian/SHA256SUMS.json"))
            self.assertEqual(archive.read("xiaonian/README.md"), b"Committed source.\n")
            self.assertNotIn(".env", manifest)
            self.assertEqual(
                manifest["README.md"], hashlib.sha256(b"Committed source.\n").hexdigest(),
            )

    def test_zip_preserves_git_modes_and_is_reproducible(self):
        expected = checker.source_modes(self.root, "HEAD")
        self.assertEqual(expected["scripts/utility.sh"], 0o100755)
        self.assertEqual(expected["README.md"], 0o100644)
        first = self.package()
        self.assertEqual(first.returncode, 0, first.stderr)
        with zipfile.ZipFile(self.output) as archive:
            for name in ("scripts/utility.sh", "README.md"):
                info = archive.getinfo("xiaonian/" + name)
                self.assertEqual(info.create_system, 3)
                self.assertEqual(stat.S_IMODE(info.external_attr >> 16), stat.S_IMODE(expected[name]))
            self.assertEqual(
                stat.S_IMODE(archive.getinfo("xiaonian/SHA256SUMS.json").external_attr >> 16),
                0o644,
            )
        another = self.parent / "second.zip"
        second = self.package(output=another)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(self.output.read_bytes(), another.read_bytes())

    def test_git_snapshot_and_modes_are_relative_to_requested_subdirectory(self):
        files = checker.source_files(self.root / "scripts", "HEAD")
        modes = checker.source_modes(self.root / "scripts", "HEAD")
        self.assertEqual(set(files), {"package.py", "check-public.py", "utility.sh"})
        self.assertEqual(set(files), set(modes))
        self.assertEqual(modes["utility.sh"], 0o100755)

    def test_scanner_failure_creates_no_package_and_suppresses_scanner_output(self):
        self.env["GITLEAKS_BIN"] = str(self.scanner(1))
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.output.exists())
        self.assertFalse(self.output.parent.exists())
        self.assertIn("Gitleaks rejected", result.stderr)
        self.assertNotIn("synthetic-scanner-output", result.stdout + result.stderr)

    def test_ref_and_output_are_required_and_legacy_invocations_create_nothing(self):
        for arguments in ([], [str(self.output)], ["--output", str(self.output)], ["--ref", "HEAD"]):
            with self.subTest(arguments=arguments):
                result = subprocess.run(
                    [sys.executable, str(self.root / "scripts/package.py"), *arguments],
                    cwd=self.root, env=self.env, text=True, capture_output=True,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("required", result.stderr)
                self.assertFalse(self.output.exists())
                self.assertFalse((self.root / "artifacts").exists())

    def test_missing_scanner_creates_no_output(self):
        with patch.object(source_package, "ROOT", self.root), \
                patch.dict(os.environ, {"GITLEAKS_BIN": ""}), \
                patch.object(source_package.shutil, "which", return_value=None), \
                patch.object(sys, "argv", ["package.py", "--ref", "HEAD", "--output", str(self.output)]):
            with self.assertRaisesRegex(ValueError, "Gitleaks is required"):
                source_package.main()
        self.assertFalse(self.output.exists())
        self.assertFalse(self.output.parent.exists())

    def test_package_enforces_decimal_300_mb_boundary_and_retains_failed_output(self):
        original_stat = Path.stat
        for size in (300_000_000, 300_000_001):
            with self.subTest(reported_package_bytes=size):
                output = self.parent / f"package-{size}.zip"

                def output_size(path, *args, **kwargs):
                    if path == output:
                        return SimpleNamespace(st_size=size)
                    return original_stat(path, *args, **kwargs)

                # Run the complete commit-and-scan path, injecting only the final
                # ZIP size so the boundary test does not allocate 300 MB.
                with patch.object(source_package, "ROOT", self.root), \
                        patch.dict(os.environ, self.env), \
                        patch.object(sys, "argv", ["package.py", "--ref", "HEAD", "--output", str(output)]), \
                        patch.object(Path, "stat", output_size), contextlib.redirect_stdout(io.StringIO()):
                    if size == 300_000_000:
                        source_package.main()
                    else:
                        with self.assertRaisesRegex(ValueError, "300,000,000 bytes"):
                            source_package.main()
                self.assertTrue(output.exists())
                self.assertTrue(zipfile.is_zipfile(output))

    def test_windows_relative_paths_produce_unique_posix_zip_members_and_verified_manifest(self):
        class WindowsRelativePaths(type(Path())):
            def relative_to(self, *other, **kwargs):
                return PureWindowsPath(*super().relative_to(*other, **kwargs).parts)

        nested = self.root / "server/src/example.ts"
        nested.parent.mkdir(parents=True)
        nested.write_text("export const version = 1;\n", encoding="utf-8")
        self.git("add", "server/src/example.ts")
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "Nested source fixture")
        with patch.object(source_package, "ROOT", WindowsRelativePaths(self.root)), \
                patch.dict(os.environ, self.env), \
                patch.object(sys, "argv", ["package.py", "--ref", "HEAD", "--output", str(self.output)]), \
                contextlib.redirect_stdout(io.StringIO()):
            source_package.main()
        with zipfile.ZipFile(self.output) as archive:
            names = archive.namelist()
            self.assertEqual(len(names), len(set(names)))
            self.assertIsNone(archive.testzip())
            self.assertTrue(all("\\" not in name for name in names))
            manifest = json.loads(archive.read("xiaonian/SHA256SUMS.json"))
            self.assertIn("server/src/example.ts", manifest)
            self.assertEqual(set(names), {"xiaonian/" + name for name in manifest} | {"xiaonian/SHA256SUMS.json"})
            for name, digest in manifest.items():
                self.assertEqual(hashlib.sha256(archive.read("xiaonian/" + name)).hexdigest(), digest)

    def test_committed_private_files_block_export_instead_of_being_silently_omitted(self):
        private_paths = [
            "merchant.p12", "merchant.PFX", "private.key", "certificate.pem", ".env",
            ".env.production", "project.private.config.json", "secrets/credential.json",
            "credentials/token.json", "certs/key.pkcs12", "server/data/order.sqlite",
            "restore/snapshot/uploads/user-1/photo.png", "backups/snapshot/bundle.manifest.json",
        ]
        for name in private_paths:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("Invalid synthetic fixture; no private data.\n", encoding="utf-8")
        example = self.root / "server/.env.example"
        example.write_text("LLM_API_KEY=\n", encoding="utf-8")
        self.git("add", ".")
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "Private path rejection fixtures")
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        findings = json.loads(result.stdout)["findings"]
        self.assertEqual({item["path"] for item in findings}, set(private_paths))
        self.assertEqual({item["rule"] for item in findings}, {"forbidden-file"})
        self.assertFalse(self.output.exists())
        self.assertFalse(self.output.parent.exists())

    def test_reserved_manifest_in_commit_is_rejected_before_packaging(self):
        (self.root / "SHA256SUMS.json").write_text("{}\n", encoding="utf-8")
        self.git("add", "SHA256SUMS.json")
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "Reserved manifest fixture")
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("reserved", result.stderr)
        self.assertFalse(self.output.exists())

    def test_existing_output_is_never_replaced(self):
        self.output.parent.mkdir()
        self.output.write_bytes(b"Keep this previous artifact.")
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.output.read_bytes(), b"Keep this previous artifact.")


if __name__ == "__main__":
    unittest.main()
