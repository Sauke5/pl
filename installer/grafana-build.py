#!/usr/bin/env python3
"""CI-only, immutable source reconstruction of Grafana and its bundled backends.

The original frontend/assets stay byte-identical. The private signing key is never available to this helper, Go compilation, or tests.
Only the precompiled signer runs in a separate BuildKit secret mount.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import urllib.request

MAX_ARCHIVE = 256 * 1024**2


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def command(args, cwd, env=None, capture=False):
    result = subprocess.run(args, cwd=cwd, env=env, check=False, capture_output=capture, text=capture)
    if result.returncode:
        raise ValueError('Grafana source-build command failed: ' + Path(args[0]).name)
    return result.stdout if capture else ''


def load(path):
    return json.loads(path.read_text())


def relative(value):
    if not isinstance(value, str) or not value or Path(value).is_absolute() or '..' in Path(value).parts or '\\' in value:
        raise ValueError('Unsafe build artifact path')
    return value


def fetch(url, checksum, target):
    if not re.fullmatch(r'[0-9a-f]{64}', checksum) or not url.startswith('https://codeload.github.com/'):
        raise ValueError('Unpinned source archive')
    if target.exists():
        if target.is_symlink() or digest(target) != checksum:
            raise ValueError('Cached source archive integrity mismatch')
        return
    request = urllib.request.Request(url, headers={'User-Agent': 'PL-immutable-source-build'})
    count, value = 0, hashlib.sha256()
    try:
        with urllib.request.urlopen(request, timeout=120) as response, target.open('xb') as out:
            if response.status != 200 or not response.url.startswith('https://codeload.github.com/'):
                raise ValueError('Unexpected source archive response')
            while chunk := response.read(1024 * 1024):
                count += len(chunk)
                if count > MAX_ARCHIVE:
                    raise ValueError('Source archive exceeds limit')
                value.update(chunk)
                out.write(chunk)
        if value.hexdigest() != checksum:
            raise ValueError('Source archive integrity mismatch')
    except BaseException:
        target.unlink(missing_ok=True)
        raise


def extract(archive, destination):
    destination.mkdir()
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        if len(members) > 200000 or sum(m.size for m in members) > 2 * 1024**3:
            raise ValueError('Source archive size exceeds limit')
        prefixes = {member.name.split('/', 1)[0] for member in members}
        if len(prefixes) != 1:
            raise ValueError('Source archive root is ambiguous')
        selected = []
        for member in members:
            parts = member.name.split('/', 1)
            if len(parts) == 1 or not parts[1]:
                continue
            member.name = relative(parts[1])
            selected.append(member)
        source.extractall(destination, members=selected, filter='data')


def go_environment(architecture, workspace=False):
    env = {**os.environ, 'GOOS': 'linux', 'GOARCH': architecture, 'CGO_ENABLED': '0',
           'GOTOOLCHAIN': 'local', 'GOMAXPROCS': '2', 'GOFLAGS': '-p=2', 'GOSUMDB': 'sum.golang.org',
           'GOPROXY': 'https://proxy.golang.org', 'GONOSUMDB': '', 'GONOPROXY': '', 'GOPRIVATE': ''}
    if workspace:
        env.pop('GOWORK', None)
    else:
        env['GOWORK'] = 'off'
    return env


def dependencies(source, updates, env, sums=None):
    if not isinstance(updates, dict) or not updates:
        raise ValueError('Exact security dependencies required')
    versions = []
    for package, version in sorted(updates.items()):
        if not re.fullmatch(r'[A-Za-z0-9._/-]+', package) or not re.fullmatch(r'v[0-9A-Za-z.+-]+', version):
            raise ValueError('Unpinned dependency update')
        versions.append(package + '@' + version)
    command(['go', 'get', *versions], source, env)
    command(['go', 'mod', 'download'], source, env)
    command(['go', 'mod', 'verify'], source, env)
    for package, expected in sorted(updates.items()):
        actual = command(['go', 'list', '-m', '-f', '{{.Version}}', package], source, env, capture=True).strip()
        if actual != expected:
            raise ValueError('Resolved security dependency differs from pinned version')
    if sums:
        combined = '\n'.join(path.read_text() for path in source.rglob('go.sum') if path.is_file())
        for line in sums:
            if line not in combined.splitlines():
                raise ValueError('Pinned security dependency checksum is missing')


def provenance(source, output, env):
    output.mkdir(parents=True, exist_ok=True)
    for pattern in ('go.mod', 'go.sum', 'go.work', 'go.work.sum'):
        path = source / pattern
        if path.is_file():
            shutil.copyfile(path, output / pattern)
    (output / 'modules.txt').write_text(command(['go', 'list', '-m', 'all'], source, env, capture=True))


def security_provenance(source, output, row, env):
    evidence = row.get('security_evidence', [])
    if not evidence:
        return
    module = 'github.com/grafana/tempo'
    expected = row.get('retained_dependencies', {}).get(module)
    actual = json.loads(command(['go', 'list', '-m', '-json', module], source, env, capture=True))
    if not expected or actual.get('Path') != module or actual.get('Version') != expected or actual.get('Replace') or not actual.get('Dir'):
        raise ValueError('Security evidence module identity differs from retained source')
    module_root = Path(actual['Dir']).resolve(strict=True)
    allowed = {'GO-2026-5528': 'modules/frontend/config.go', 'GO-2026-5359': 'tempodb/backend/s3/config.go'}
    if {item.get('advisory') for item in evidence} != set(allowed) or len(evidence) != len(allowed):
        raise ValueError('Security evidence advisory set differs from fixed source contract')
    security = output / 'security'
    security.mkdir()
    files = []
    for item in evidence:
        advisory = item['advisory']
        relative_path = allowed[advisory]
        path = module_root / relative_path
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(module_root):
            raise ValueError('Security evidence source file unavailable')
        raw = path.read_bytes()
        checksum = hashlib.sha256(raw).hexdigest()
        if checksum != item.get('source_sha256') or item['required_fragment'].encode() not in raw:
            raise ValueError('Actual module source does not contain the pinned security fix')
        name = advisory + '.go'
        (security / name).write_bytes(raw)
        files.append({'advisory': advisory, 'path': relative_path, 'sha256': checksum, 'file': name})
    (security / 'source-evidence.json').write_text(json.dumps({'schema': 1, 'module': module, 'version': actual['Version'], 'files': files}, sort_keys=True, indent=2) + '\n')


def plugins(args, metadata, lock, architecture, source, out):
    if lock.get('schema') != 1 or lock.get('grafana_version') != metadata['version'] or lock.get('go_version') != metadata['go_version']:
        raise ValueError('Plugin lock does not match Grafana source contract')
    rows = lock.get('plugins')
    if not isinstance(rows, list) or len(rows) != 13 or len({row['id'] for row in rows}) != len(rows):
        raise ValueError('Exactly thirteen bundled backend source pins required')
    native = args.native_root / 'data/plugins-bundled'
    if not native.is_dir():
        raise ValueError('Pinned upstream bundled plugins unavailable')
    pluginout = out / 'plugins'
    shutil.copytree(native, pluginout, symlinks=True)
    # Fail the complete asset/source contract before spending time compiling any backend.
    declared = set()
    for row in rows:
        folder = relative(row['directory'])
        binary = relative(row['build']['output'].format(arch=architecture))
        path = pluginout / folder
        if path.is_symlink() or not path.is_dir() or '/' in binary or not (path / binary).is_file() or (path / binary).is_symlink():
            raise ValueError('Pinned native plugin artifact is missing')
        descriptor = load(path / 'plugin.json')
        if descriptor.get('id') != row['id'] or descriptor.get('info', {}).get('version') != row['version']:
            raise ValueError('Native plugin asset identity differs from source lock')
        declared.add(str(Path(folder) / binary))
    native_backends = {str(path.relative_to(pluginout)) for path in pluginout.rglob('gpx_*_linux_*') if path.is_file()}
    if native_backends != declared:
        raise ValueError('Native plugin backend inventory differs from exact source lock')
    expected = set()
    for row in rows:
        plugin_id = row['id']
        if not re.fullmatch(r'[a-z0-9_-]+', plugin_id) or not re.fullmatch(r'[0-9a-f]{40}', row['source']['revision']):
            raise ValueError('Invalid plugin source identity')
        if row['build'].get('go_version') != metadata['go_version']:
            raise ValueError('Plugin toolchain pin differs from core')
        folder = relative(row.get('directory', plugin_id))
        binary = relative(row['build']['output'].format(arch=architecture))
        if '/' in binary or not re.fullmatch(r'gpx_[A-Za-z0-9_-]+_linux_(amd64|arm64)', binary):
            raise ValueError('Invalid bundled backend output')
        destination = pluginout / folder
        if destination.is_symlink() or not destination.is_dir():
            raise ValueError('Native bundled plugin directory missing')
        descriptor = load(destination / 'plugin.json')
        if descriptor.get('id') != plugin_id or descriptor.get('info', {}).get('version') != row['version']:
            raise ValueError('Pinned native plugin asset identity differs from source lock')
        if not (destination / binary).is_file() or (destination / binary).is_symlink():
            raise ValueError('Native bundled plugin backend missing')
        expected.add(str(Path(folder) / binary))
        url = row['source']['url']
        archive = args.work / (plugin_id + '.tar.gz')
        fetch(url, row['source']['sha256'], archive)
        project = args.work / ('plugin-' + plugin_id)
        extract(archive, project)
        module = project / relative(row['build'].get('module_dir', '.'))
        env = go_environment(architecture)
        dependencies(module, row['dependencies'], env, row.get('dependency_sums'))
        for package, version in row.get('retained_dependencies', {}).items():
            actual = command(['go', 'list', '-m', '-f', '{{.Version}}', package], module, env, capture=True).strip()
            if actual != version:
                raise ValueError('Required retained plugin dependency changed')
        package = row['build']['package']
        if not re.fullmatch(r'\./[A-Za-z0-9_./-]*|\.', package) or '..' in Path(package).parts:
            raise ValueError('Invalid plugin build package')
        print('Building bundled Grafana backend: ' + plugin_id, flush=True)
        command(['go', 'build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=',
                 '-o', str(destination / binary), package], module, env)
        (destination / binary).chmod(0o755)
        proof = out / 'provenance/plugins' / plugin_id
        provenance(module, proof, env)
        security_provenance(module, proof, row, env)
        (proof / 'binary-build.txt').write_text(command(['go', 'version', '-m', str(destination / binary)], module, env, capture=True))
    found = {str(path.relative_to(pluginout)) for path in pluginout.rglob('gpx_*_linux_*') if path.is_file()}
    if found != expected:
        raise ValueError('Bundled backend inventory differs from reconstructed exact plugin set')
    return pluginout


def prepare(args):
    metadata, lock = load(args.metadata), load(args.plugins_lock)
    if metadata.get('source_date_epoch') != args.expected_epoch:
        raise ValueError('Signing recipe epoch differs from immutable source metadata')
    architecture = command(['go', 'env', 'GOARCH'], args.work, capture=True).strip()
    if architecture not in ('amd64', 'arm64'):
        raise ValueError('Unsupported Grafana architecture')
    actual_go = command(['go', 'env', 'GOVERSION'], args.work, capture=True).strip()
    if actual_go != 'go' + metadata['go_version']:
        raise ValueError('Grafana Go toolchain differs from pinned version')
    out = args.output
    out.mkdir()
    (out / 'provenance').mkdir()
    archive = args.work / 'grafana.tar.gz'
    fetch(metadata['source']['url'], metadata['source']['sha256'], archive)
    source = args.work / 'grafana'
    extract(archive, source)
    env = go_environment(architecture, workspace=True)
    dependencies(source, metadata['security_dependencies'], env, metadata.get('security_dependency_sums'))
    command(['go', 'work', 'sync'], source, env)
    pluginout = plugins(args, metadata, lock, architecture, source, out)
    # Compile/test the signer without any signing secret mounted. The secret step executes only this binary.
    command(['go', 'test', '-mod=readonly', str(args.signing_tool), str(args.signing_tool.with_name('main_test.go'))], source, env)
    command(['go', 'build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=',
             '-o', str(out / 'pl-grafana-signer'), str(args.signing_tool)], source, env)
    (out / 'provenance/signer-build.txt').write_text(command(['go', 'version', '-m', str(out / 'pl-grafana-signer')], source, env, capture=True))
    for original in ('metadata', 'plugins_lock', 'trust_patch'):
        shutil.copyfile(getattr(args, original), out / 'provenance' / {'metadata': 'sources.json', 'plugins_lock': 'plugins-lock.json', 'trust_patch': 'trust.patch'}[original])
    return metadata, source, pluginout, env


def core(args):
    metadata = load(args.metadata)
    if metadata.get('source_date_epoch') != args.expected_epoch:
        raise ValueError('Signing recipe epoch differs from immutable source metadata')
    source, out = args.work / 'grafana', args.output
    architecture = command(['go', 'env', 'GOARCH'], args.work, capture=True).strip()
    env = go_environment(architecture, workspace=True)
    trust = out / 'pl_trust_generated.go'
    shutil.copyfile(Path(str(trust) + '.json'), out / 'provenance/signing.json')
    command(['patch', '--batch', '--forward', '-p1', '-i', str(args.trust_patch)], source, env)
    shutil.copyfile(trust, source / 'pkg/plugins/manager/signature/pl_trust_generated.go')
    shutil.copyfile(trust, out / 'provenance/pl_trust_generated.go')
    (out / 'bin').mkdir(exist_ok=True)
    # Exact official OSS entry point, unchanged native frontend, deterministic release identity.
    flags = ('-s -w -buildid= -X main.version=' + metadata['version'] + ' -X main.commit=' + metadata['source']['revision']
             + ' -X main.buildBranch=pl-security -X main.buildstamp=' + str(metadata['source_date_epoch']))
    command(['go', 'test', '-mod=readonly', '-tags=oss', './pkg/plugins/manager/signature/...', './pkg/util/sqlite/...'], source, env)
    command(['go', 'build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-tags=oss', '-ldflags=' + flags,
             '-o', str(out / 'bin/grafana'), './pkg/cmd/grafana'], source, env)
    provenance(source, out / 'provenance/core', env)
    (out / 'provenance/core/binary-build.txt').write_text(command(['go', 'version', '-m', str(out / 'bin/grafana')], source, env, capture=True))
    hashes = {str(path.relative_to(out)): digest(path) for path in sorted((out / 'plugins').rglob('*')) if path.is_file()}
    hashes['bin/grafana'] = digest(out / 'bin/grafana')
    (out / 'provenance/artifact-sha256.json').write_text(json.dumps(hashes, sort_keys=True, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=('prepare', 'core'))
    parser.add_argument('--metadata', type=Path, required=True)
    parser.add_argument('--plugins-lock', type=Path, required=True)
    parser.add_argument('--native-root', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--signing-tool', type=Path, required=True)
    parser.add_argument('--trust-patch', type=Path, required=True)
    parser.add_argument('--expected-epoch', type=int, required=True)
    args = parser.parse_args()
    args.work.mkdir(parents=True, exist_ok=True)
    try:
        prepare(args) if args.phase == 'prepare' else core(args)
        return 0
    except (ValueError, OSError, KeyError, TypeError, tarfile.TarError):
        # Source/build diagnostics are printed by tools. Never serialize signing errors or secret paths.
        print('Grafana source reconstruction failed; inspect the failed build stage', flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
