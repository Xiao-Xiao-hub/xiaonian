#!/usr/bin/env python3
"""Package an explicitly selected Git commit only after all content scans pass."""
import hashlib
import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def committed_package(args):
    """Archive the exact reviewed public commit, not the developer's disk."""
    spec = importlib.util.spec_from_file_location("public_check", ROOT / "scripts/check-public.py")
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    commit = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "--verify", args.ref + "^{commit}"], text=True).strip()
    files = checker.source_files(ROOT, commit)
    modes = checker.source_modes(ROOT, commit)
    if "SHA256SUMS.json" in files:
        raise ValueError("SHA256SUMS.json is reserved for the generated package manifest")
    policy = json.loads(files.get("scripts/public-content-policy.json", b"{}"))
    findings = checker.scan(files, policy)
    if findings:
        print(json.dumps({"check": "package-source", "findings": findings}, ensure_ascii=False, indent=2))
        raise ValueError("Public content check failed; no package created")
    executable = os.environ.get("GITLEAKS_BIN") or shutil.which("gitleaks")
    if not executable:
        raise ValueError("Gitleaks is required (set GITLEAKS_BIN); no package created")
    # Never rely on a stale clean working-tree report: scan these exact bytes.
    with tempfile.TemporaryDirectory(prefix="xiaonian-package-check-") as work:
        directory = Path(work)
        for name, data in files.items():
            path = directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        result = subprocess.run(
            [executable, "dir", str(directory), "--redact=100", "--no-banner",
             "--config", str(directory / ".gitleaks.toml")],
            capture_output=True, text=True,
        )
        if result.returncode:
            raise ValueError("Gitleaks rejected the committed snapshot; no package created (values suppressed)")
    output = args.output.absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}
    epoch = int(subprocess.check_output(["git", "-C", str(ROOT), "show", "-s", "--format=%ct", commit], text=True).strip())
    timestamp = datetime.fromtimestamp(max(epoch, 315532800), timezone.utc).timetuple()[:6]
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(args.prefix + "/" + name, timestamp)
            info.create_system = 3
            info.external_attr = modes[name] << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
        info = zipfile.ZipInfo(args.prefix + "/SHA256SUMS.json", timestamp)
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    with zipfile.ZipFile(output) as archive:
        if archive.testzip():
            raise ValueError("ZIP integrity failed")
        if len(archive.namelist()) != len(manifest) + 1:
            raise ValueError("ZIP file membership mismatch")
        for name, digest in manifest.items():
            if hashlib.sha256(archive.read(args.prefix + "/" + name)).hexdigest() != digest:
                raise ValueError("ZIP content mismatch")
    if output.stat().st_size > 300_000_000:
        raise ValueError("Package exceeds 300,000,000 bytes; output retained for inspection")
    print(json.dumps({"output": str(output), "commit": commit, "files": len(files),
                      "bytes": output.stat().st_size, "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}))


def main():
    parser = argparse.ArgumentParser(description="Package a scanned, committed public source snapshot")
    parser.add_argument("--ref", required=True, help="Git commit or ref to scan and archive")
    parser.add_argument("--output", type=Path, required=True, help="New ZIP path; existing files are never replaced")
    parser.add_argument("--prefix", default="xiaonian")
    args = parser.parse_args()
    if not args.prefix or "/" in args.prefix or "\\" in args.prefix or args.prefix in {".", ".."}:
        raise ValueError("Package prefix must be a single directory name")
    committed_package(args)


if __name__ == '__main__':
    main()
