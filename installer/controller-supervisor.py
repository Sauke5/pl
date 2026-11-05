#!/usr/bin/env python3
"""Immutable PL host protocol-1 entry point; select a previously verified release."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


def checksum(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for part in iter(lambda: stream.read(1024**2), b''):
            value.update(part)
    return value.hexdigest()


def private_json(path):
    meta = path.lstat()
    if not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o077 or meta.st_size > 1024**2:
        raise ValueError('Unsafe host controller activation record')
    return json.loads(path.read_bytes())


def selected_package(root, initial):
    if root != root.resolve() or not root.is_dir():
        raise ValueError('Canonical managed installation required')
    marker = private_json(root / '.pl-installation.json')
    if marker.get('product') not in ('PL', 'Pl'):
        raise ValueError('Managed PL installation required')
    active = private_json(root / 'state/controller-active.json')
    if (set(active) != {'schema', 'version'} or active['schema'] != 1
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', active.get('version', ''))):
        raise ValueError('Invalid host controller activation')
    package = root / 'releases' / active['version']
    if package != package.resolve() or not package.is_dir() or package.stat().st_uid != 0 or package.stat().st_mode & 0o022:
        raise ValueError('Unsafe active host release directory')
    manifest = private_json(package / 'manifest.json')
    if (manifest.get('schema') != 2 or manifest.get('product') != 'PL' or manifest.get('version') != active['version']
            or not manifest.get('features', {}).get('on_demand_modules') or not isinstance(manifest.get('files'), dict)
            or not {'module-controller.py', 'delivery.py', 'release-signing-public.pem'} <= manifest['files'].keys()
            or len(manifest['files']) > 100):
        raise ValueError('Unsupported activated host release')
    for name, expected in manifest['files'].items():
        path = package / name
        if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', name)
                or not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected)
                or path.is_symlink() or not path.is_file() or path.stat().st_uid != 0
                or path.stat().st_mode & 0o022 or checksum(path) != expected):
            raise ValueError('Activated host release integrity differs')
    if checksum(package / 'release-signing-public.pem') != checksum(initial / 'release-signing-public.pem'):
        raise ValueError('Activated release changes the immutable trust key')
    return package


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('Host supervisor requires root')
    initial = Path(__file__).resolve().parent
    package = selected_package(args.root, initial)
    environment = dict(os.environ)
    environment['PL_HOST_SUPERVISOR_PACKAGE'] = str(initial)
    os.execve('/usr/bin/python3', ['/usr/bin/python3', str(package / 'module-controller.py'), '--root', str(args.root)], environment)


if __name__ == '__main__':
    main()
