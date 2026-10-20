"""Check that local entrypoints cannot silently claim native compilation."""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.name == "posix" and shutil.which("bash"), "Bash entrypoint tests require POSIX")
class CheckEntrypointsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="miniapp-check-tests-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.scripts = self.root / "scripts"
        self.scripts.mkdir()
        for name in ("check.sh", "compile_miniprogram.sh"):
            shutil.copyfile(ROOT / "scripts" / name, self.scripts / name)
        (self.root / "server").mkdir()
        tests = self.root / "tests"
        tests.mkdir()
        for name in ("sample.test.ts", "frontend.test.cjs", "admin.test.mjs"):
            (tests / name).write_text("", encoding="utf-8")
        self.mini = self.root / "miniprogram"
        (self.mini / "pages").mkdir(parents=True)
        (self.mini / "components").mkdir()
        (self.mini / "pages" / "index.wxml").write_text("<view/>", encoding="utf-8")
        (self.mini / "app.wxss").write_text("page {}", encoding="utf-8")
        self.env = {
            **os.environ,
            "WCC_DIR": str(self.root / "missing-sdk"),
            "TZ": "Asia/Shanghai",
        }

    def run_script(self, name, *arguments):
        return subprocess.run(
            ["bash", str(self.scripts / name), *arguments],
            cwd=self.root,
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
        )

    def fake_compilers(self, body="exit 0\n"):
        sdk = self.root / "sdk"
        sdk.mkdir()
        for name in ("wcc", "wcsc"):
            path = sdk / name
            path.write_text("#!/bin/sh\n" + body, encoding="utf-8")
            path.chmod(0o700)
        self.env["WCC_DIR"] = str(sdk)

    def fake_tools(self):
        binaries = self.root / "bin"
        binaries.mkdir()
        self.log = self.root / "commands.log"
        self.env["CHECK_TEST_LOG"] = str(self.log)
        self.env["PATH"] = str(binaries) + os.pathsep + os.environ["PATH"]
        for name in ("node", "npm", "python3"):
            path = binaries / name
            path.write_text(
                "#!/bin/sh\n"
                f'printf "%s|%s|%s\\n" "{name}" "$TZ" "$*" >> "$CHECK_TEST_LOG"\n'
                'if [ "${CHECK_TEST_FAIL_BUILD:-0}" = 1 ] && [ "$*" = "run build" ]; then exit 17; fi\n',
                encoding="utf-8",
            )
            path.chmod(0o700)

    def test_missing_sdk_fails_with_or_without_explicit_required_flag(self):
        default = self.run_script("compile_miniprogram.sh")
        required = self.run_script("compile_miniprogram.sh", "--required")
        for result in (default, required):
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("NOT VERIFIED", result.stderr)
            self.assertNotIn("files compiled", result.stdout)

    def test_unset_sdk_path_fails_without_a_machine_specific_fallback(self):
        self.env.pop("WCC_DIR", None)
        result = self.run_script("compile_miniprogram.sh", "--required")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("WCC_DIR is required", result.stderr)
        self.assertNotIn("files compiled", result.stdout)

    def test_required_compilation_counts_actual_sources(self):
        self.fake_compilers()
        result = self.run_script("compile_miniprogram.sh", "--required")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("1 WXML and 1 WXSS files compiled", result.stdout)

    def test_zero_exit_compiler_diagnostics_still_fail(self):
        self.fake_compilers("echo 'invalid markup' >&2\nexit 0\n")
        result = self.run_script("compile_miniprogram.sh", "--required")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid markup", result.stdout)
        self.assertNotIn("files compiled", result.stdout)

    def test_empty_source_tree_does_not_pass(self):
        self.fake_compilers()
        (self.mini / "pages" / "index.wxml").unlink()
        result = self.run_script("compile_miniprogram.sh", "--required")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no WXML or WXSS", result.stderr)

    def test_source_only_check_is_serial_and_keeps_each_requested_timezone(self):
        self.fake_tools()
        for timezone in ("Asia/Shanghai", "America/New_York"):
            result = self.run_script("check.sh", "--skip-native", "--timezone", timezone)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("native compilation NOT VERIFIED", result.stdout)
            self.assertNotIn("all stages passed", result.stdout)
            commands = self.log.read_text(encoding="utf-8").splitlines()
            node_commands = [line for line in commands if line.startswith(f"node|{timezone}|")]
            self.assertEqual(len(node_commands), 2, commands)
            self.assertTrue(all("--test-concurrency=1" in line for line in node_commands))
            self.assertTrue(any(f"python3|{timezone}|-m unittest discover" in line for line in commands))

    def test_default_check_requires_native_compilers(self):
        self.fake_tools()
        result = self.run_script("check.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("NOT VERIFIED", result.stderr)
        self.assertNotIn("all stages passed", result.stdout)

    def test_failed_build_stops_before_behavior_or_compilation(self):
        self.fake_tools()
        self.env["CHECK_TEST_FAIL_BUILD"] = "1"
        result = self.run_script("check.sh", "--skip-native")
        self.assertEqual(result.returncode, 17)
        self.assertNotIn("node|", self.log.read_text(encoding="utf-8"))
        self.assertNotIn("stages passed", result.stdout)

    def test_invalid_options_fail_before_running_tools(self):
        self.fake_tools()
        for arguments in (("--typo",), ("--timezone",), ("--timezone", "invalid-zone")):
            with self.subTest(arguments=arguments):
                result = self.run_script("check.sh", *arguments)
                self.assertEqual(result.returncode, 2)
        self.assertFalse(self.log.exists())
        result = self.run_script("compile_miniprogram.sh", "--requred")
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
