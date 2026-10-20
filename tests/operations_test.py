"""Backup and recovery checks. Source packaging is covered by public_release_test.py."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]



class OperationsTests(unittest.TestCase):
    def test_online_wal_backup_restore_and_integrity(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            source, backup, restored = [p / name for name in ('source.sqlite', 'backup.sqlite', 'restored.sqlite')]
            command = [sys.executable, str(ROOT / 'scripts/backup.py')]
            with contextlib.closing(sqlite3.connect(source)) as db, db:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE notes (id TEXT PRIMARY KEY, chars INTEGER)')
                db.execute("INSERT INTO notes VALUES ('test-note', 312)")
                db.commit()
                saved = subprocess.run(command + ['backup', '--source', str(source), '--target', str(backup)], check=True, text=True, capture_output=True)
                self.assertEqual(json.loads(saved.stdout)['rowCounts']['notes'], 1)
                subprocess.run(command + ['restore', '--source', str(backup), '--target', str(restored)], check=True, capture_output=True)
                with contextlib.closing(sqlite3.connect(restored)) as result, result:
                    self.assertEqual(result.execute('SELECT * FROM notes').fetchall(), [('test-note', 312)])
                duplicate = subprocess.run(command + ['restore', '--source', str(backup), '--target', str(restored)], capture_output=True)
                self.assertNotEqual(duplicate.returncode, 0)
                with open(backup, 'ab') as out:
                    out.write(b'altered')
                damaged = subprocess.run(command + ['restore', '--source', str(backup), '--target', str(p / 'other.sqlite')], capture_output=True)
                self.assertNotEqual(damaged.returncode, 0)
                self.assertFalse((p / 'other.sqlite').exists())



class BackupBundleTests(unittest.TestCase):
    def setUp(self):
        # Retain drill fixtures and failed outputs for inspection; never remove them.
        self.work = Path(tempfile.mkdtemp(prefix='zhiye-backup-test-'))
        self.source = self.work / 'source.sqlite'
        self.uploads = self.work / 'uploads'
        self.bundle = self.work / 'bundle'
        self.restored = self.work / 'restored'
        self.command = [sys.executable, str(ROOT / 'scripts/backup.py')]

    def fixture(self, with_image=True, missing_image=False, broken_reference=False, wal=False):
        with contextlib.closing(sqlite3.connect(self.source)) as db, db:
            if wal:
                db.execute('PRAGMA journal_mode=WAL')
            db.executescript('''
                CREATE TABLE users(id TEXT PRIMARY KEY);
                CREATE TABLE materials(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), image_path TEXT);
                INSERT INTO users VALUES('user-1');
            ''')
            db.execute('INSERT INTO materials VALUES(?,?,?)', (
                'material-1', 'missing-user' if broken_reference else 'user-1',
                'user-1/photo.png' if with_image else None,
            ))
        if with_image and not missing_image:
            (self.uploads / 'user-1').mkdir(parents=True)
            (self.uploads / 'user-1/photo.png').write_bytes(b'\x89PNG\r\n\x1a\nsynthetic-drill-image')
            (self.uploads / 'user-1/unreferenced.png').write_bytes(b'unreferenced')

    def backup(self, stopped=True, target=None):
        return subprocess.run(self.command + [
            'backup-bundle', '--source', str(self.source), '--uploads', str(self.uploads),
            '--target', str(target or self.bundle),
        ] + (['--stopped'] if stopped else []), text=True, capture_output=True)

    def restore(self, target=None):
        return subprocess.run(self.command + [
            'restore-bundle', '--source', str(self.bundle), '--target', str(target or self.restored),
        ], text=True, capture_output=True)

    def manifest(self):
        return json.loads((self.bundle / 'bundle.manifest.json').read_text())

    def write_manifest(self, data):
        (self.bundle / 'bundle.manifest.json').write_text(json.dumps(data))

    def test_v2_bundle_preserves_all_uploads_and_database_in_new_paths(self):
        self.fixture()
        result = self.backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = self.manifest()
        self.assertEqual(manifest['format'], 'zhiye-backup/2')
        self.assertEqual(manifest['database']['rowCounts'], {'materials': 1, 'users': 1})
        self.assertEqual(manifest['database']['foreignKeys'], 'ok')
        image = self.uploads / 'user-1/photo.png'
        self.assertEqual(manifest['images'], [{
            'path': name, 'bytes': (self.uploads / name).stat().st_size,
            'sha256': hashlib.sha256((self.uploads / name).read_bytes()).hexdigest(),
        } for name in ['user-1/photo.png', 'user-1/unreferenced.png']])
        self.assertEqual((self.bundle / 'uploads/user-1/unreferenced.png').read_bytes(), b'unreferenced')
        restored = self.restore()
        self.assertEqual(restored.returncode, 0, restored.stderr)
        self.assertEqual((self.restored / 'uploads/user-1/photo.png').read_bytes(), image.read_bytes())
        self.assertEqual((self.restored / 'uploads/user-1/unreferenced.png').read_bytes(), b'unreferenced')
        with contextlib.closing(sqlite3.connect(self.restored / 'app.sqlite')) as db, db:
            self.assertEqual(db.execute('SELECT * FROM materials').fetchall(), [('material-1', 'user-1', 'user-1/photo.png')])
            db.execute("INSERT INTO users VALUES('restored-only')")
        with contextlib.closing(sqlite3.connect(self.source)) as db, db:
            self.assertEqual(db.execute('SELECT count(*) FROM users').fetchone()[0], 1)

    def chat_and_import_fixture(self):
        self.fixture(with_image=False)
        with contextlib.closing(sqlite3.connect(self.source)) as db, db:
            db.execute('CREATE TABLE chat_images(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), path TEXT NOT NULL)')
            db.execute("INSERT INTO chat_images VALUES('chat-1','user-1','user-1/chat/photo.png')")
        files = {'user-1/chat/photo.png': b'synthetic chat image',
                 'user-1/imports/import-1/source.docx': b'synthetic pending import',
                 'user-1/imports/import-1/pages/1.png': b'synthetic nested page'}
        for name, content in files.items():
            path = self.uploads / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        return files

    def test_v2_restores_chat_images_and_pending_nested_imports_with_no_material_images(self):
        files = self.chat_and_import_fixture()
        result = self.backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([entry['path'] for entry in self.manifest()['images']], sorted(files))
        result = self.restore()
        self.assertEqual(result.returncode, 0, result.stderr)
        for name, content in files.items():
            self.assertEqual((self.restored / 'uploads' / name).read_bytes(), content)
        with contextlib.closing(sqlite3.connect(self.restored / 'app.sqlite')) as db:
            self.assertEqual(db.execute('SELECT path FROM chat_images').fetchone()[0], 'user-1/chat/photo.png')
        self.assertEqual(json.loads((self.restored / 'bundle.manifest.json').read_text())['format'], 'zhiye-backup/2')

    def test_v2_refuses_a_missing_persistent_chat_image_before_marking_backup_complete(self):
        self.chat_and_import_fixture()
        (self.uploads / 'user-1/chat/photo.png').rename(self.work / 'held-chat.png')
        result = self.backup()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Missing referenced upload', result.stderr)
        self.assertFalse((self.bundle / 'bundle.manifest.json').exists())

    def test_v2_restore_rejects_missing_or_tampered_unreferenced_import_files(self):
        self.chat_and_import_fixture()
        self.assertEqual(self.backup().returncode, 0)
        file = self.bundle / 'uploads/user-1/imports/import-1/source.docx'
        file.rename(self.work / 'held.docx')
        self.assertNotEqual(self.restore().returncode, 0)
        self.assertFalse(self.restored.exists())
        file.write_bytes(b'tampered pending import')
        self.assertNotEqual(self.restore().returncode, 0)
        self.assertFalse(self.restored.exists())

    def test_v2_restore_rejects_extra_files_and_duplicate_manifest_entries(self):
        self.chat_and_import_fixture()
        self.assertEqual(self.backup().returncode, 0)
        extra = self.bundle / 'uploads/unlisted.txt'
        extra.write_text('not in manifest')
        self.assertNotEqual(self.restore().returncode, 0)
        self.assertFalse(self.restored.exists())
        extra.rename(self.work / 'unlisted.txt')
        manifest = self.manifest()
        manifest['images'][1] = manifest['images'][0]
        self.write_manifest(manifest)
        self.assertNotEqual(self.restore().returncode, 0)
        self.assertFalse(self.restored.exists())

    def test_v1_restore_preserves_legacy_material_only_semantics_and_format(self):
        self.fixture()
        self.assertEqual(self.backup().returncode, 0)
        # A legacy-shaped manifest: only material references were guaranteed.
        # Extra files alongside an old snapshot were never part of that promise.
        manifest = self.manifest()
        manifest['format'] = 'zhiye-backup/1'
        manifest['images'] = [entry for entry in manifest['images'] if entry['path'] == 'user-1/photo.png']
        self.write_manifest(manifest)
        result = self.restore()
        self.assertEqual(result.returncode, 0, result.stderr)
        restored_manifest = json.loads((self.restored / 'bundle.manifest.json').read_text())
        self.assertEqual(restored_manifest['format'], 'zhiye-backup/1')
        self.assertEqual(restored_manifest['images'], manifest['images'])
        self.assertFalse((self.restored / 'uploads/user-1/unreferenced.png').exists())

    @unittest.skipUnless(os.name == 'posix', 'POSIX symlink and FIFO fixtures')
    def test_v2_backup_refuses_symlinks_and_special_files_without_following_them(self):
        self.fixture()
        outside = self.work / 'outside'
        outside.mkdir()
        (outside / 'keep.txt').write_text('keep unchanged')
        link = self.uploads / 'link'
        for number, destination in enumerate([outside / 'keep.txt', outside, self.uploads / 'user-1/photo.png']):
            link.symlink_to(destination)
            result = self.backup(target=self.work / f'linked-backup-{number}')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Symlinks', result.stderr)
            link.rename(self.work / f'held-link-{number}')
        fifo = self.uploads / 'fifo'
        os.mkfifo(fifo)
        result = self.backup(target=self.work / 'fifo-backup')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('regular files', result.stderr)
        self.assertEqual((outside / 'keep.txt').read_text(), 'keep unchanged')

    @unittest.skipUnless(os.name == 'posix', 'POSIX symlink fixture')
    def test_v2_restore_refuses_a_symlinked_upload_even_with_matching_contents(self):
        self.fixture()
        self.assertEqual(self.backup().returncode, 0)
        image = self.bundle / 'uploads/user-1/photo.png'
        held = self.work / 'photo.png'
        image.rename(held)
        image.symlink_to(held)
        result = self.restore()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Symlinks', result.stderr)
        self.assertFalse(self.restored.exists())

    def test_v2_refuses_a_backup_target_inside_uploads(self):
        self.fixture()
        target = self.uploads / 'nested-backup'
        result = self.backup(target=target)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('outside uploads', result.stderr)
        self.assertFalse(target.exists())

    def test_v2_restore_rejects_manifest_path_escape_without_changing_database(self):
        self.fixture()
        self.assertEqual(self.backup().returncode, 0)
        manifest = self.manifest()
        manifest['images'][0]['path'] = '../../outside.png'
        self.write_manifest(manifest)
        result = self.restore()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('inside uploads', result.stderr)
        self.assertFalse(self.restored.exists())

    @unittest.skipUnless(os.name == 'posix', 'POSIX symlink fixture')
    def test_v2_backup_and_restore_reject_symlinked_upload_roots(self):
        self.fixture()
        original_uploads = self.uploads
        self.uploads = self.work / 'linked-uploads'
        self.uploads.symlink_to(original_uploads)
        self.assertNotEqual(self.backup(target=self.work / 'root-link-backup').returncode, 0)
        self.uploads = original_uploads
        self.assertEqual(self.backup().returncode, 0)
        saved = self.work / 'held-uploads'
        (self.bundle / 'uploads').rename(saved)
        (self.bundle / 'uploads').symlink_to(saved)
        self.assertNotEqual(self.restore().returncode, 0)
        self.assertFalse(self.restored.exists())

    @unittest.skipUnless(os.name == 'posix', 'Windows uses ACLs, not POSIX permission bits')
    def test_bundle_restores_owner_only_posix_permissions(self):
        self.fixture()
        self.assertEqual(self.backup().returncode, 0)
        self.assertEqual(self.restore().returncode, 0)
        for path in ['app.sqlite', 'app.sqlite.manifest.json', 'uploads/user-1/photo.png', 'bundle.manifest.json']:
            self.assertEqual((self.restored / path).stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.restored.stat().st_mode & 0o777, 0o700)

    def test_bundle_requires_stopped_acknowledgement_and_new_targets(self):
        self.fixture()
        result = self.backup(stopped=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.bundle.exists())
        self.assertEqual(self.backup().returncode, 0)
        before = (self.bundle / 'bundle.manifest.json').read_bytes()
        self.assertNotEqual(self.backup().returncode, 0)
        self.assertEqual((self.bundle / 'bundle.manifest.json').read_bytes(), before)
        self.restored.mkdir()
        sentinel = self.restored / 'keep.txt'
        sentinel.write_text('existing target')
        self.assertNotEqual(self.restore().returncode, 0)
        self.assertEqual(sentinel.read_text(), 'existing target')
        self.assertFalse((self.restored / 'app.sqlite').exists())

    def test_bundle_without_images_allows_missing_upload_directory(self):
        self.fixture(with_image=False)
        self.assertFalse(self.uploads.exists())
        result = self.backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.manifest()['images'], [])
        result = self.restore()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list((self.restored / 'uploads').iterdir()), [])

    def test_missing_original_retains_incomplete_backup_without_completion_manifest(self):
        self.fixture(missing_image=True)
        result = self.backup()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.bundle / 'app.sqlite').exists())
        self.assertFalse((self.bundle / 'bundle.manifest.json').exists())
        self.assertNotEqual(self.restore().returncode, 0)
        self.assertFalse(self.restored.exists())

    def test_bundle_from_wal_database_is_self_contained_and_refuses_wal_sidecars(self):
        # The server runs SQLite in WAL mode; the bundle copy must not depend on sidecars.
        self.fixture(wal=True)
        self.assertEqual(self.backup().returncode, 0)
        database = self.bundle / 'app.sqlite'
        self.assertEqual(database.read_bytes()[18:20], b'\x01\x01')
        self.assertFalse((self.bundle / 'app.sqlite-wal').exists())
        self.assertFalse((self.bundle / 'app.sqlite-shm').exists())
        # Changes carried by a WAL file are refused instead of replayed.
        (self.bundle / 'app.sqlite-wal').write_bytes(b'not-empty')
        refused = self.restore()
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('WAL', refused.stderr)
        self.assertFalse(self.restored.exists())
        (self.bundle / 'app.sqlite-wal').write_bytes(b'')
        restored = self.restore()
        self.assertEqual(restored.returncode, 0, restored.stderr)

    def test_restore_rejects_missing_and_tampered_images_before_writing(self):
        self.fixture()
        self.assertEqual(self.backup().returncode, 0)
        image = self.bundle / 'uploads/user-1/photo.png'
        moved = image.with_suffix('.held')
        image.rename(moved)
        self.assertNotEqual(self.restore().returncode, 0)
        self.assertFalse(self.restored.exists())
        image.write_bytes(moved.read_bytes() + b'tampered')
        self.assertNotEqual(self.restore().returncode, 0)
        self.assertFalse(self.restored.exists())

    def test_restore_rejects_corrupted_database_bytes(self):
        self.fixture()
        self.assertEqual(self.backup().returncode, 0)
        database = self.bundle / 'app.sqlite'
        data = bytearray(database.read_bytes())
        data[len(data) // 2] ^= 0xFF
        database.write_bytes(bytes(data))
        self.assertNotEqual(self.restore().returncode, 0)
        self.assertFalse(self.restored.exists())

    def test_restore_rejects_tampered_database_and_omitted_images(self):
        self.fixture()
        self.assertEqual(self.backup().returncode, 0)
        manifest = self.manifest()
        self.write_manifest({**manifest, 'images': []})
        self.assertNotEqual(self.restore().returncode, 0)
        self.assertFalse(self.restored.exists())
        self.write_manifest(manifest)
        with contextlib.closing(sqlite3.connect(self.bundle / 'app.sqlite')) as db, db:
            db.execute("INSERT INTO users VALUES('tampered')")
        self.assertNotEqual(self.restore().returncode, 0)
        self.assertFalse(self.restored.exists())

    def test_restore_rejects_image_paths_outside_uploads(self):
        self.fixture()
        self.assertEqual(self.backup().returncode, 0)
        outside = self.work / 'outside.png'
        outside.write_bytes(b'outside')
        with contextlib.closing(sqlite3.connect(self.bundle / 'app.sqlite')) as db, db:
            db.execute("UPDATE materials SET image_path='../../outside.png'")
        manifest = self.manifest()
        manifest['database']['sha256'] = hashlib.sha256((self.bundle / 'app.sqlite').read_bytes()).hexdigest()
        manifest['images'] = [{'path': '../../outside.png', 'bytes': 7, 'sha256': hashlib.sha256(b'outside').hexdigest()}]
        self.write_manifest(manifest)
        result = self.restore()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('inside uploads', result.stderr)
        self.assertFalse(self.restored.exists())
        self.assertEqual(outside.read_bytes(), b'outside')

    def test_snapshot_rejects_existing_sidecar_and_preserves_failed_database(self):
        self.fixture(broken_reference=True)
        target = self.work / 'snapshot.sqlite'
        sidecar = target.with_suffix('.sqlite.manifest.json')
        sidecar.write_text('existing sidecar')
        args = self.command + ['backup', '--source', str(self.source), '--target', str(target)]
        self.assertNotEqual(subprocess.run(args, capture_output=True).returncode, 0)
        self.assertFalse(target.exists())
        self.assertEqual(sidecar.read_text(), 'existing sidecar')
        failed_target = self.work / 'broken.sqlite'
        result = subprocess.run(self.command + ['backup', '--source', str(self.source), '--target', str(failed_target)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(failed_target.exists())
        self.assertFalse(failed_target.with_suffix('.sqlite.manifest.json').exists())


if __name__ == '__main__':
    unittest.main()
