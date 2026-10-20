#!/usr/bin/env python3
"""SQLite backup / restore into NEW paths; failed outputs are retained.

python scripts/backup.py backup --source server/data/app.sqlite --target backups/snapshot.sqlite
python scripts/backup.py restore --source backups/snapshot.sqlite --target restore/app.sqlite
python scripts/backup.py backup-bundle --source server/data/app.sqlite --uploads server/data/uploads --target backups/snapshot --stopped
python scripts/backup.py restore-bundle --source backups/snapshot --target restore/snapshot

Database-only snapshots can run online. Bundles require a stopped application:
--stopped is the operator's acknowledgement, not an automatic process check.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sqlite3
import stat


def require_new(path: Path):
    if path.exists() or path.is_symlink():
        raise ValueError(f'Target must be a new path: {path}')


def write_manifest(path: Path, report):
    # Serialize first; a database/image validation failure never writes a marker.
    data = (json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(data)


def database_report(path: Path):
    with closing(sqlite3.connect(path.resolve(strict=True).as_uri() + '?mode=ro', uri=True)) as db:
        integrity = db.execute('PRAGMA integrity_check').fetchall()
        if integrity != [('ok',)]:
            raise ValueError(f'Database integrity failure: {integrity}')
        foreign_keys = db.execute('PRAGMA foreign_key_check').fetchall()
        if foreign_keys:
            raise ValueError(f'Database foreign key failure: {foreign_keys}')
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        counts = {t: db.execute('SELECT count(*) FROM "' + t.replace('"', '""') + '"').fetchone()[0] for t in tables}
    return {
        'file': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'integrity': 'ok', 'foreignKeys': 'ok', 'rowCounts': counts,
    }


def snapshot(source: Path, target: Path):
    source = source.resolve(strict=True)
    manifest = target.with_suffix(target.suffix + '.manifest.json')
    require_new(target)
    require_new(manifest)
    target.parent.mkdir(parents=True, exist_ok=True)
    target = target.absolute()
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src:
        with closing(sqlite3.connect(target)) as dst:
            src.backup(dst)
            # The copy keeps the source's WAL flag; switch it back so the file alone
            # holds every change and its checksum covers them.
            dst.execute('PRAGMA journal_mode=DELETE')
    report = database_report(target)
    write_manifest(manifest, report)
    return report


def refuse_wal_sidecar(database: Path):
    # Snapshots are written in rollback-journal mode; a non-empty WAL next to one
    # would carry changes the checksum does not cover.
    wal = database.with_name(database.name + '-wal')
    if wal.exists() and wal.stat().st_size > 0:
        raise ValueError(f'Unexpected WAL file next to the backup: {wal}; restore refused.')


def referenced_images(database: Path):
    with closing(sqlite3.connect(database.resolve(strict=True).as_uri() + '?mode=ro', uri=True)) as db:
        return [r[0] for r in db.execute('SELECT DISTINCT image_path FROM materials WHERE image_path IS NOT NULL ORDER BY image_path')]


def image_path(root: Path, relative: str, strict=False):
    if not isinstance(relative, str) or not relative or '\\' in relative:
        raise ValueError('Invalid image path')
    path = PurePosixPath(relative)
    if path.is_absolute() or '..' in path.parts or not path.parts:
        raise ValueError('Image path must stay inside uploads')
    if strict:
        if path.as_posix() != relative or root.is_symlink():
            raise ValueError('Invalid or symlinked uploads path')
        current = root
        for part in path.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError('Symlinks are not allowed inside uploads')
    resolved = root.joinpath(*path.parts).resolve()
    if not resolved.is_relative_to(root.resolve()) or resolved == root.resolve():
        raise ValueError('Image path must stay inside uploads')
    return resolved


def image_report(root: Path, relative: str, strict=False):
    path = image_path(root, relative, strict)
    if strict and not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError('Uploads entries must be regular files')
    data = path.read_bytes()
    return {'path': relative, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def copy_image(source: Path, target: Path, relative: str, strict=False):
    original = image_path(source, relative, strict)
    if strict and not stat.S_ISREG(original.lstat().st_mode):
        raise ValueError('Uploads entries must be regular files')
    data = original.read_bytes()
    output = image_path(target, relative, strict)
    output.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(data)
    return image_report(target, relative, strict)


def upload_files(root: Path):
    """v2 snapshots every regular upload, including chat and pending imports."""
    if root.is_symlink():
        raise ValueError('Uploads root must not be a symlink')
    if not root.exists():
        return []
    if not root.is_dir():
        raise ValueError('Uploads root must be a directory')

    def fail(error):
        raise error

    paths = []
    for base, dirs, files in os.walk(root, followlinks=False, onerror=fail):
        for name in dirs + files:
            path = Path(base) / name
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                raise ValueError('Symlinks are not allowed inside uploads')
            if stat.S_ISREG(mode):
                relative = path.relative_to(root).as_posix()
                image_path(root, relative, strict=True)
                paths.append(relative)
            elif not stat.S_ISDIR(mode):
                raise ValueError('Uploads entries must be regular files or directories')
    return sorted(paths)


def check_upload_references(database: Path, uploads: Path):
    # A complete tree must still contain the persistent images the DB names.
    # Imports can legitimately have expired temporary files; their remaining
    # files are captured by the tree inventory, without deriving filenames.
    references = referenced_images(database)
    with closing(sqlite3.connect(database.resolve(strict=True).as_uri() + '?mode=ro', uri=True)) as db:
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_images'").fetchone():
            references += [row[0] for row in db.execute('SELECT DISTINCT path FROM chat_images ORDER BY path')]
    for relative in references:
        path = image_path(uploads, relative, strict=True)
        if not path.is_file():
            raise ValueError(f'Missing referenced upload: {relative}')


def create_bundle(source: Path, uploads: Path, target: Path, expected_images=None, bundle_format='zhiye-backup/2'):
    require_new(target)
    strict = bundle_format == 'zhiye-backup/2'
    if strict and target.resolve().is_relative_to(uploads.resolve()):
        raise ValueError('Backup target must be outside uploads')
    if strict and source.is_symlink():
        raise ValueError('Source database must not be a symlink')
    target.mkdir(parents=True, mode=0o700)
    database = snapshot(source, target / 'app.sqlite')
    output_uploads = target / 'uploads'
    output_uploads.mkdir(mode=0o700)
    if strict:
        paths = upload_files(uploads)
        check_upload_references(target / 'app.sqlite', uploads)
    else:
        # Preserve v1 restore semantics: only material image references.
        paths = referenced_images(target / 'app.sqlite')
    images = [copy_image(uploads, output_uploads, path, strict) for path in paths]
    if expected_images is not None and images != expected_images:
        raise ValueError('Images changed during restore; incomplete target retained.')
    # Keep the public field name; format 2 explicitly broadens it to ALL files.
    report = {'format': bundle_format, 'database': database, 'images': images}
    write_manifest(target / 'bundle.manifest.json', report)
    return report


def restore_bundle(source: Path, target: Path):
    require_new(target)
    if source.is_symlink() or (source / 'bundle.manifest.json').is_symlink():
        raise ValueError('Symlinks are not allowed for bundle metadata')
    manifest = json.loads((source / 'bundle.manifest.json').read_text(encoding='utf-8'))
    bundle_format = manifest.get('format')
    if bundle_format not in {'zhiye-backup/1', 'zhiye-backup/2'}:
        raise ValueError('Unsupported bundle format')
    strict = bundle_format == 'zhiye-backup/2'
    if strict and any(path.is_symlink() for path in [source / 'app.sqlite', source / 'app.sqlite.manifest.json']):
        raise ValueError('Symlinks are not allowed in a v2 bundle')
    database = source / 'app.sqlite'
    refuse_wal_sidecar(database)
    if database_report(database) != manifest.get('database'):
        raise ValueError('Bundle database checksum or metadata mismatch; restore refused.')
    images = manifest.get('images')
    if strict:
        paths = upload_files(source / 'uploads')
        check_upload_references(database, source / 'uploads')
        if isinstance(images, list):
            for entry in images:
                if not isinstance(entry, dict):
                    raise ValueError('Invalid uploads manifest entry')
                image_path(source / 'uploads', entry.get('path'), strict=True)
    else:
        paths = referenced_images(database)
    if not isinstance(images, list) or len(images) != len(paths):
        raise ValueError('Bundle image list does not match the snapshot inventory')
    # v1 derives material images from the DB; v2 compares every actual file.
    checked = [image_report(source / 'uploads', path, strict) for path in paths]
    if checked != images:
        raise ValueError('Bundle image checksum or metadata mismatch; restore refused.')
    return create_bundle(database, source / 'uploads', target, checked, bundle_format)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'restore', 'backup-bundle', 'restore-bundle'])
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--target', type=Path, required=True)
    parser.add_argument('--uploads', type=Path)
    parser.add_argument('--stopped', action='store_true', help='Acknowledge the application and its jobs are fully stopped; not detected automatically')
    args = parser.parse_args()
    if args.action == 'backup-bundle':
        if args.uploads is None or not args.stopped:
            parser.error('backup-bundle requires --uploads and --stopped (stop the application and its jobs first).')
        print(json.dumps(create_bundle(args.source, args.uploads, args.target), ensure_ascii=False))
        return
    if args.uploads is not None or args.stopped:
        parser.error('--uploads and --stopped apply only to backup-bundle')
    if args.action == 'restore-bundle':
        print(json.dumps(restore_bundle(args.source, args.target), ensure_ascii=False))
        return
    if args.action == 'restore':
        refuse_wal_sidecar(args.source)
        manifest = args.source.with_suffix(args.source.suffix + '.manifest.json')
        expected = json.loads(manifest.read_text(encoding='utf-8'))['sha256']
        if hashlib.sha256(args.source.read_bytes()).hexdigest() != expected:
            parser.error('Backup checksum mismatch; restore refused.')
    print(json.dumps(snapshot(args.source, args.target), ensure_ascii=False))


if __name__ == '__main__':
    main()
