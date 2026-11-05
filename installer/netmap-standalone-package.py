#!/usr/bin/env python3
"""Select seven pinned NetMap images from an already built canonical bundle, in CI."""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('netmap_standalone_packaging', ROOT / 'installer/netmap-standalone.py')
standalone = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(standalone)


def read_member(archive, name, maximum):
    member = archive.getmember(name)
    if not member.isfile() or member.size > maximum:
        raise ValueError('Invalid canonical package member')
    return archive.extractfile(member).read()


def canonical_inputs(path, expected_sha256):
    if not re.fullmatch(r'[0-9a-f]{64}', expected_sha256) or standalone.digest(path) != expected_sha256:
        raise ValueError('Canonical package SHA256 mismatch')
    with tarfile.open(path, 'r:gz') as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        if (len(names) > 128 or len(names) != len(set(names))
                or any(not member.isfile() or Path(member.name).is_absolute() or len(Path(member.name).parts) != 1
                       or member.name in ('.', '..') for member in members)):
            raise ValueError('Unsafe canonical package layout')
        value = json.loads(read_member(archive, 'manifest.json', 128 * 1024))
        if (value.get('schema') != 2 or value.get('product') not in ("PL", "Pl")
                or value.get('features', {}).get('netmap_module') is not True
                or not isinstance(value.get('images'), dict) or not isinstance(value.get('files'), dict)):
            raise ValueError('Canonical NetMap package required')
        for name in ('netmap-controller.py', 'xray-controller.py', 'LICENSES.txt'):
            raw = read_member(archive, name, 256 * 1024)
            if hashlib.sha256(raw).hexdigest() != value['files'].get(name):
                raise ValueError('Canonical helper checksum mismatch')
            # The standalone subclass is reviewed against this exact controller implementation.
            if name.endswith('.py') and raw != (ROOT / 'installer' / name).read_bytes():
                raise ValueError('Standalone runtime and canonical controller source differ')
        return value, {name: read_member(archive, name, 256 * 1024)
                       for name in ('netmap-controller.py', 'xray-controller.py', 'LICENSES.txt')}


def add(archive, name, body):
    member = tarfile.TarInfo(name)
    member.mode, member.size, member.mtime = 0o644, len(body), 0
    archive.addfile(member, io.BytesIO(body))


def package(args):
    if sys.platform != 'linux':
        raise ValueError('Standalone image packaging runs on the Linux CI host')
    if args.output.exists() or args.output.with_suffix(args.output.suffix + '.sha256').exists():
        raise ValueError('Standalone output already exists')
    canonical, files = canonical_inputs(args.canonical_bundle, args.canonical_sha256)
    images = {role: copy.deepcopy(canonical['images']['netmap-' + role]) for role in standalone.nm.ROLES}
    files.update({
        'netmap-standalone.py': (ROOT / 'installer/netmap-standalone.py').read_bytes(),
        'netmap-standalone/nginx.conf.example': (ROOT / 'installer/netmap-standalone/nginx.conf.example').read_bytes(),
        'README.ru.md': (ROOT / 'docs/product/netmap-standalone.md').read_bytes(),
    })
    manifest = {'schema': 1, 'product': 'PL NetMap Standalone',
                'version': images['adapter']['labels']['org.opencontainers.image.version'],
                'architecture': canonical['architecture'], 'source_sha256': canonical['source_sha256'],
                'canonical_sha256': args.canonical_sha256, 'images': images,
                'files': {**{name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()}, 'images.tar': '0' * 64}}
    standalone.validate_manifest(manifest)
    environment = {key: value for key, value in os.environ.items() if not key.startswith(('DOCKER_', 'COMPOSE_'))}

    def docker(*arguments, timeout=180):
        result = subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', *arguments], cwd=ROOT,
                                env=environment, capture_output=True, timeout=timeout, check=False)
        if result.returncode:
            raise ValueError('Pinned NetMap images must already be available in the Linux CI Docker cache')
        return result.stdout

    # Never build, pull, load or run Platform core images as part of module packaging.
    for contract in images.values():
        obj = json.loads(docker('image', 'inspect', contract['id']))[0]
        if (obj.get('Id') != contract['id'] or obj.get('Architecture') != manifest['architecture'] or obj.get('Os') != 'linux'
                or any((obj.get('Config', {}).get('Labels') or {}).get(key) != value for key, value in contract['labels'].items())):
            raise ValueError('Canonical NetMap image provenance mismatch')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='netmap-standalone-', dir=args.output.parent) as temporary:
        image_tar = Path(temporary) / 'images.tar'
        docker('image', 'save', '--output', str(image_tar), *[images[role]['id'] for role in standalone.nm.ROLES], timeout=900)
        configs = standalone.validate_image_archive(image_tar, images)
        for role, config_id in configs.items():
            if config_id != images[role]['id']:
                images[role]['config_id'] = config_id
        manifest['files']['images.tar'] = standalone.digest(image_tar)
        standalone.validate_manifest(manifest)
        candidate = Path(temporary) / 'netmap.tar.gz'
        # Fixed tar metadata and gzip header; the selected Docker image bytes retain their native identity.
        with candidate.open('xb') as output:
            with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode='w|') as archive:
                    add(archive, 'manifest.json', (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode())
                    for name, raw in sorted(files.items()):
                        add(archive, name, raw)
                    member = tarfile.TarInfo('images.tar')
                    member.mode, member.size, member.mtime = 0o644, image_tar.stat().st_size, 0
                    with image_tar.open('rb') as stream:
                        archive.addfile(member, stream)
        checksum = standalone.digest(candidate)
        # Do not replace a concurrently produced package.
        os.link(candidate, args.output)
        with args.output.with_suffix(args.output.suffix + '.sha256').open('x') as stream:
            stream.write(checksum + '  ' + args.output.name + '\n')
    print(json.dumps({'product': manifest['product'], 'package': str(args.output), 'sha256': checksum,
                      'roles': list(standalone.nm.ROLES), 'canonical_sha256': args.canonical_sha256}, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--canonical-bundle', type=Path, required=True)
    parser.add_argument('--canonical-sha256', required=True, help='Previously verified checksum of the canonical PL bundle')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        package(args)
        return 0
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError, tarfile.TarError) as error:
        print('NetMap standalone packaging failed: ' + (str(error) if type(error) is ValueError else type(error).__name__),
              file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
