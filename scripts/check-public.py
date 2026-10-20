#!/usr/bin/env python3
"""Check public source without printing credentials or contacting providers.

Git checkouts are checked from their tracked files. Extracted source packages
are checked against SHA256SUMS.json. This supplements, not replaces, Gitleaks.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_DIRS = {
    ".git", "node_modules", "dist", "data", "backups", "restore", "artifacts",
    "__pycache__", "secrets", "credentials", "certs",
}
FORBIDDEN_SUFFIXES = {
    ".pem", ".key", ".p12", ".pfx", ".pkcs12", ".keystore", ".jks",
    ".sqlite", ".db", ".zip", ".gz", ".tar", ".log", ".pyc",
}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico"}
SENSITIVE = r"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|secret[_-]?(?:key|id)|password|passwd|admin[_-]?key|authorization|token|secret)"
ASSIGNMENT = re.compile(
    rf"""(?ix)["']?\b(?P<field>(?:[a-z][a-z0-9]*[_-])*{SENSITIVE})["']?\s*[:=]\s*["'](?P<value>[^"'\r\n]+)["']"""
)
ENV_ASSIGNMENT = re.compile(rf"(?im)^[ \t]*#?[ \t]*(?P<field>[A-Z0-9_]*(?:KEY|SECRET|SECRET_ID|TOKEN|PASSWORD))[ \t]*=[ \t]*(?P<value>[^\r\n#]*)")
PRIVATE_KEY = re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----")
URL = re.compile(r"https?://[^\s<>\"'`]+")
LINK = re.compile(r"!?\[[^\]]*\]\(([^)\n]+)\)")
PLACEHOLDERS = {"", "your_api_key", "your_app_secret", "your_secret_key", "your_secret_id", "your_llm_key", "your_jev_key"}


def forbidden_path(name):
    path = Path(name)
    return (
        path.is_absolute() or ".." in path.parts
        or any(part in EXCLUDED_DIRS for part in path.parts)
        or (path.name.startswith(".env") and path.name != ".env.example")
        or path.name == "project.private.config.json"
        or path.suffix.lower() in FORBIDDEN_SUFFIXES
        or bool(re.search(r"\.(?:sqlite|db)-(?:wal|shm)$", path.name))
    )


def contains_symlink(root, name):
    path = root
    for part in Path(name).parts:
        path = path / part
        if path.is_symlink():
            return True
    return False


def source_files(root, ref=None):
    """Return source bytes, never follow symlinks or read ignored local secrets."""
    if ref:
        top = Path(subprocess.check_output(["git", "-C", str(root), "rev-parse", "--show-toplevel"], text=True).strip())
        prefix = root.resolve().relative_to(top.resolve()).as_posix()
        prefix = "" if prefix == "." else prefix + "/"
        tree = subprocess.check_output(["git", "-C", str(top), "ls-tree", "-rz", ref, "--", prefix or "."])
        files = {}
        for record in tree.split(b"\0"):
            if not record:
                continue
            metadata, raw_name = record.split(b"\t", 1)
            mode, kind, oid = metadata.decode().split()
            name = raw_name.decode()[len(prefix):]
            if kind != "blob" or mode not in {"100644", "100755"}:
                raise ValueError(f"Unsupported Git entry: {name}")
            files[name] = subprocess.check_output(["git", "-C", str(top), "cat-file", "blob", oid])
        return files
    if (root / "SHA256SUMS.json").is_file() and not (root / ".git").exists():
        if (root / "SHA256SUMS.json").is_symlink():
            raise ValueError("Package manifest must not be a symlink")
        manifest = json.loads((root / "SHA256SUMS.json").read_text(encoding="utf-8"))
        names = list(manifest)
        # A package may acquire ignored build products after installation; the
        # source membership is still fixed by its verified manifest.
        files = {}
        for name in names:
            path = root / name
            if forbidden_path(name) or contains_symlink(root, name):
                raise ValueError(f"Invalid manifest member: {name}")
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest() != manifest[name]:
                raise ValueError(f"Source checksum mismatch: {name}")
            files[name] = data
        return files
    names = subprocess.check_output(["git", "-C", str(root), "ls-files", "-z", "--", "."], text=True).split("\0")
    files = {}
    for name in filter(None, names):
        path = root / name
        if contains_symlink(root, name):
            raise ValueError(f"Symlink in source: {name}")
        files[name] = path.read_bytes()
    return files


def source_modes(root, ref):
    """Preserve executable scripts when exporting a Git tree or ZIP."""
    top = Path(subprocess.check_output(["git", "-C", str(root), "rev-parse", "--show-toplevel"], text=True).strip())
    prefix = root.resolve().relative_to(top.resolve()).as_posix()
    prefix = "" if prefix == "." else prefix + "/"
    tree = subprocess.check_output(["git", "-C", str(top), "ls-tree", "-rz", ref, "--", prefix or "."])
    modes = {}
    for record in filter(None, tree.split(b"\0")):
        metadata, name = record.split(b"\t", 1)
        modes[name.decode()[len(prefix):]] = int(metadata.split()[0], 8)
    return modes


def scan(files, policy=None):
    policy = policy or {}
    exceptions = {(v["path"], v["rule"], v["sha256"]) for v in policy.get("syntheticValues", []) if v.get("reason")}
    private_hashes = set(policy.get("privateIdentifierHashes", []))
    binary_assets = policy.get("reviewedBinaryFiles", {})
    findings = []

    def report(name, line, rule, value=""):
        digest = hashlib.sha256(value.encode()).hexdigest()
        if (name, rule, digest) not in exceptions:
            findings.append({"path": name, "line": line, "rule": rule})

    for name, data in sorted(files.items()):
        if forbidden_path(name):
            report(name, 1, "forbidden-file")
            continue
        try:
            content = data.decode("utf-8")
        except UnicodeDecodeError:
            if Path(name).suffix.lower() not in IMAGE_SUFFIXES or binary_assets.get(name) != hashlib.sha256(data).hexdigest():
                report(name, 1, "unreviewed-binary")
            continue
        for match in PRIVATE_KEY.finditer(content):
            report(name, content.count("\n", 0, match.start()) + 1, "private-key", match.group())
        patterns = [ASSIGNMENT]
        if Path(name).name == ".env.example":
            patterns.append(ENV_ASSIGNMENT)
        for pattern in patterns:
            for match in pattern.finditer(content):
                value = match.group("value").strip().strip("\"'")
                if value in PLACEHOLDERS or "${" in value:
                    continue
                report(name, content.count("\n", 0, match.start()) + 1, "credential-literal", match.group("field").lower() + "=" + value)
        for match in URL.finditer(content):
            value = match.group().rstrip(".,;)")
            try:
                parsed = urlsplit(value)
                if parsed.username is not None or parsed.password is not None:
                    report(name, content.count("\n", 0, match.start()) + 1, "url-credentials", value)
                if re.search(rf"(?i)(?:^|[&?]){SENSITIVE}=", parsed.query):
                    report(name, content.count("\n", 0, match.start()) + 1, "url-credential-query", value)
            except ValueError:
                pass  # Snippets may contain intentionally incomplete URLs.
        # Hash exact environment-specific identifiers so the public checker
        # does not itself distribute those private values.
        tokens = re.findall(r"[\w.+-]+@[\w.-]+|https?://[^\s<>\"'`]+|\bwx[a-f0-9]{16}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b", content)
        for token in tokens:
            if hashlib.sha256(token.rstrip(".,;)").encode()).hexdigest() in private_hashes:
                report(name, 1, "private-environment-identifier")
        if name.endswith(".md"):
            for match in LINK.finditer(content):
                target = match.group(1).strip().split(" ", 1)[0].strip("<>")
                if not target or target.startswith(("#", "http:", "https:", "mailto:")):
                    continue
                target = unquote(target.split("#", 1)[0])
                from posixpath import normpath, join
                resolved = normpath(join(str(Path(name).parent), target))
                if resolved.startswith("../") or target.startswith("/"):
                    report(name, content.count("\n", 0, match.start()) + 1, "external-local-link")
                elif resolved not in files and not any(p.startswith(resolved.rstrip("/") + "/") for p in files):
                    report(name, content.count("\n", 0, match.start()) + 1, "broken-local-link")
    return findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", type=Path, default=ROOT)
    parser.add_argument("--git-ref")
    args = parser.parse_args()
    files = source_files(args.root.resolve(), args.git_ref)
    policy = json.loads(files.get("scripts/public-content-policy.json", b"{}"))
    findings = scan(files, policy)
    print(json.dumps({"check": "public-source", "files": len(files), "findings": findings}, ensure_ascii=False, indent=2))
    return bool(findings)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"public-source: {type(error).__name__}; source inventory could not be verified", file=sys.stderr)
        sys.exit(2)
