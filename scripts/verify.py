#!/usr/bin/env python3
"""Static package checks; does NOT replace WeChat developer tools / real-device QA."""
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
mini = ROOT / 'miniprogram'
errors = []
warnings = []

for path in sorted(mini.rglob('*.json')):
    try:
        json.loads(path.read_text(encoding='utf-8'))
    except Exception as e:
        errors.append(f'{path.relative_to(ROOT)}: invalid JSON: {e}')

app = json.loads((mini / 'app.json').read_text(encoding='utf-8'))
pages = app['pages'][:]
for subpackage in app.get('subpackages', app.get('subPackages', [])):
    pages += [subpackage['root'] + '/' + p for p in subpackage['pages']]
for page in pages:
    for ext in ('.js', '.json', '.wxml', '.wxss'):
        if not (mini / (page + ext)).is_file():
            errors.append(f'Missing page asset: {page + ext}')
for tab in app.get('tabBar', {}).get('list', []):
    if tab['pagePath'] not in pages:
        errors.append(f'Unknown tab page: {tab["pagePath"]}')

js_files = sorted(mini.rglob('*.js'))
dependencies = subprocess.run(
    ['node', str(ROOT / 'scripts/static-requires.cjs')],
    input=json.dumps([str(path) for path in js_files]),
    capture_output=True, text=True,
)
requires = {}
if dependencies.returncode:
    errors.append('Cannot parse JavaScript dependencies: ' + dependencies.stderr.strip())
else:
    requires = {record['path']: record['requires'] for record in json.loads(dependencies.stdout)}

for path in js_files:
    result = subprocess.run(['node', '--check', str(path)], capture_output=True, text=True)
    if result.returncode:
        errors.append(result.stderr)
    text = path.read_text(encoding='utf-8')
    for dependency in requires.get(str(path), []):
        if not dependency.startswith('.'):
            continue
        target = path.parent / dependency
        if not target.is_file() and not target.with_suffix('.js').is_file() and not (target / 'index.js').is_file():
            errors.append(f'{path.relative_to(ROOT)}: missing dependency {dependency}')
    if re.search(r'-----BEGIN (RSA )?PRIVATE KEY-----', text):
        errors.append(f'Private key embedded in miniapp: {path.name}')
for path in sorted(mini.rglob('*.wxml')):
    if re.search(r'<br\b', path.read_text(encoding='utf-8')):
        errors.append(f'{path.relative_to(ROOT)}: HTML br is not a native WXML component')

subroots = [p['root'].strip('/') for p in app.get('subpackages', app.get('subPackages', []))]
source_bytes = {'main': 0, **{root: 0 for root in subroots}}
for path in mini.rglob('*'):
    if path.is_file():
        rel = path.relative_to(mini).as_posix()
        package = next((root for root in subroots if rel.startswith(root + '/')), 'main')
        source_bytes[package] += path.stat().st_size
size = sum(source_bytes.values())
if size > 1_500_000:
    warnings.append(f'Legacy internal source target exceeded: {size} > 1500000 bytes; source totals are not built upload package sizes.')
report = {'check': 'static-source', 'pages': len(pages), 'miniappBytes': size, 'errors': errors,
          'warnings': warnings, 'sourceBytesByPackage': source_bytes,
          'sizeScope': 'Uncompressed files on disk, including source comments and project files. The 1.5 MB legacy target remains a warning; actual upload package sizes require WeChat developer tools. No platform-size acceptance is claimed.',
          'notVerified': ['Built upload package sizes and platform size limits', 'WeChat developer tools compilation', 'Real device UX', 'Live WeChat login with a registered AppID']}
print(json.dumps(report, ensure_ascii=False, indent=2))
sys.exit(bool(errors))
