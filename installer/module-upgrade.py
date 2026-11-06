"""Finite same-upstream native module rebuild, called by the snapshot worker.

Descriptors are registry[kind], not artifact manifests. The caller authenticates
artifacts, holds installation/lifecycle locks, persists the immutable plan and
every checkpoint, quiesces writes, and restores root/volumes before rollback.
This helper never starts containers, writes application state, or removes data.
"""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import signal
import threading
import time
from contextlib import contextmanager

_spec = importlib.util.spec_from_file_location('pl_upgrade_files', Path(__file__).with_name('xray-controller.py'))
files = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(files)

ROLES = {'prometheus': ('',), 'xray': ('',), 'alertmanager': ('',),
         'wayline': ('runner', 'api', 'gateway'), 'grafana': ('',),
         'forms': ('mongo', 'keydb', 'engine', 'adapter'), 'doska': ('database', 'api', 'web'),
         'sftpgo': ('server',), 'netmap': ('database', 'cache', 'netbox', 'netbox-worker', 'gitea', 'adapter', 'oxidized'),
         'bookstack': ('database', 'web')}
STORAGE = {'forms': {'mongo', 'keydb'}, 'doska': {'database'},
           'netmap': {'database', 'cache'}, 'bookstack': {'database'}}
IMAGE_FIELDS = {'id', 'architecture', 'ref', 'recipe', 'labels'}
IMAGE_DEFAULTS = ('User', 'Env', 'Entrypoint', 'Cmd', 'WorkingDir', 'ExposedPorts', 'Volumes', 'Healthcheck', 'StopSignal')
LEGACY_FINGERPRINT_CORES = {'0.5.0-rc.1', '0.5.1', '0.5.2'}


class UnsupportedTransition(ValueError):
    public_code = 'module_upgrade_transition'
    public_message = 'Эта смена версии модуля требует отдельной миграции. Установленная версия сохранена.'
    status = 409


def supported_version_transition(kind, previous, candidate):
    """Only a rebuild, or the explicitly verified NetMap inventory extension."""
    return (kind in ROLES and isinstance(previous, str) and bool(previous)
            and isinstance(candidate, str) and (previous == candidate
                or (kind, previous, candidate) == ('netmap', '1.0.0', '1.1.0')))


def _shape_versions(value):
    if value.get('module_id') != 'netmap':
        return None
    pair = tuple(value.get(name, {}).get('adapter', {}).get('labels', {}).get('org.opencontainers.image.version')
                 for name in ('old_descriptor', 'new_descriptor'))
    return pair if pair == ('1.0.0', '1.1.0') else None


def digest(value):
    return hashlib.sha256(files.encoded(value)).hexdigest()


def _record(path):
    return json.loads(files.read_file(path, limit=1024 * 1024))


def _roles(kind, descriptor):
    if kind not in ROLES or not isinstance(descriptor, dict):
        raise UnsupportedTransition('Unsupported native module kind')
    result = {'': descriptor} if ROLES[kind] == ('',) else descriptor
    if set(result) != set(ROLES[kind]):
        raise UnsupportedTransition('Native image roles differ')
    for image in result.values():
        if (not isinstance(image, dict) or set(image) != IMAGE_FIELDS
                or not re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('id', ''))
                or image.get('architecture') not in ('amd64', 'arm64')
                or not isinstance(image.get('labels'), dict)
                or 'pl.source.sha256' in image['labels'] and not re.fullmatch(r'[0-9a-f]{64}', image['labels']['pl.source.sha256'])):
            raise UnsupportedTransition('Invalid native image descriptor')
    return result


def _transition(parent, kind, old, new):
    previous, candidate = _roles(kind, old), _roles(kind, new)
    pair = _shape_versions({'module_id': kind, 'old_descriptor': old, 'new_descriptor': new})
    changed = []
    for role in ROLES[kind]:
        left, right = previous[role], candidate[role]
        if role in STORAGE.get(kind, ()):
            if left != right:
                raise UnsupportedTransition('Storage image changes require a separate migration')
        else:
            a, b = dict(left['labels']), dict(right['labels'])
            a.pop('pl.source.sha256', None); b.pop('pl.source.sha256', None)
            if pair:
                if (a.get('org.opencontainers.image.version'), b.get('org.opencontainers.image.version')) != pair:
                    raise UnsupportedTransition('Mixed native module release versions')
                a.pop('org.opencontainers.image.version'); b.pop('org.opencontainers.image.version')
                if a.get('pl.module.config.version') != '1' or a.get('pl.module.role') != role:
                    raise UnsupportedTransition('NetMap configuration or role contract changed')
            if (set(left['labels']) != set(right['labels']) or (not pair and not a.get('org.opencontainers.image.version')) or a != b
                    or left['architecture'] != right['architecture'] or left['recipe'] != right['recipe']):
                raise UnsupportedTransition('Only identical upstream and native launch contracts are supported')
        if left['id'] != right['id']:
            changed.append(role)
        # Stage validation must finish before stopping even the first instance.
        values = []
        for image in (left, right):
            objects = json.loads(parent.docker('image', 'inspect', image['id']))
            if not isinstance(objects, list) or len(objects) != 1:
                raise UnsupportedTransition('Native image is unavailable')
            obj = objects[0]; config = obj.get('Config', {})
            if (obj.get('Id') != image['id'] or obj.get('Os') != 'linux'
                    or obj.get('Architecture') != image['architecture']
                    or any((config.get('Labels') or {}).get(k) != v for k, v in image['labels'].items())):
                raise UnsupportedTransition('Native image identity differs')
            labels = dict(config.get('Labels') or {}); labels.pop('pl.source.sha256', None)
            if pair and role not in STORAGE.get(kind, ()):
                labels.pop('org.opencontainers.image.version', None)
            values.append({**{k: config.get(k) for k in IMAGE_DEFAULTS}, 'Labels': labels})
        if values[0] != values[1]:
            raise UnsupportedTransition('Native runtime defaults changed; an explicit migration is required')
    return changed


def _registry(parent):
    root = Path(parent.root)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ValueError('Unsafe native installation root')
    files.directory(root / 'private', create=False)
    state = _record(root / 'state/installation.json')
    value = _record(root / 'private/module-images.json')
    if (root != root.resolve() or state.get('install_id') != parent.installation
            or value.get('schema') != 1 or value.get('installation') != parent.installation
            or not re.fullmatch(r'[0-9a-f]{64}', value.get('manifest_sha256', ''))
            or value.get('manifest_sha256') != state.get('manifest_sha256')):
        raise ValueError('Module upgrade installation identity differs')
    return state, value


def _paths(parent, kind):
    root = Path(parent.root) / 'modules'
    files.directory(root, create=False)
    if kind == 'prometheus':
        result = []
        for path in sorted(root.iterdir()):
            try: files.identifier(path.name)
            except ValueError: continue
            files.directory(path, create=False)
            files.directory(path / 'config', create=False, mode=0o755)
            result.append(path)
        return result
    base = root / kind
    if not base.exists() and not base.is_symlink():
        return []
    for path in (base, base / 'instances', base / 'operations'):
        files.directory(path, create=False)
    result = sorted((base / 'instances').iterdir())
    for path in result:
        files.identifier(path.name); files.directory(path, create=False)
        files.read_file(path / 'state.json')
    return result


def _controller(parent, kind, descriptor):
    if kind == 'prometheus': c = parent
    elif kind in ('xray', 'alertmanager', 'wayline', 'grafana'): c = getattr(parent, kind)()
    else: c = parent.application(kind)
    # A private shallow controller copy also validates candidate containers after
    # physical rollback has restored the old registry. No registry overlay/write.
    c = copy.copy(c)
    for key in ('_routes', '_read_routes', '_checked_runtimes'):
        if hasattr(c, key): setattr(c, key, {})
    if kind in ('prometheus', 'xray', 'alertmanager'):
        c.image_contract = copy.deepcopy(descriptor); c.image = descriptor['id']
    elif kind == 'grafana': c.image = copy.deepcopy(descriptor)
    elif kind == 'sftpgo': c.image = copy.deepcopy(descriptor['server'])
    else:
        c.images = copy.deepcopy(descriptor)
        if kind == 'netmap':
            c.version = descriptor['adapter']['labels']['org.opencontainers.image.version']
    return c


def _state(c, kind, instance):
    if kind == 'prometheus':
        c.config(instance, create=False)
        return c.configuration_state(instance)
    state = c.active(instance) if kind in ('xray', 'alertmanager') else c.state(instance)
    if kind == 'forms' and not state.get('bootstrapped'):
        raise UnsupportedTransition('Finish native Forms bootstrap before an artifact update')
    if kind == 'grafana' and state.get('schema') != 2:
        raise UnsupportedTransition('Legacy Grafana requires its explicit native-auth migration')
    return state


def _inspect(c, kind, instance, role):
    return c.inspect(instance) if kind in ('prometheus', 'xray', 'alertmanager', 'grafana', 'sftpgo') else c.inspect(instance, role)


def _tree(path):
    info = path.lstat()
    if info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ValueError('Native configuration ownership changed')
    meta = [stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid]
    if stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 1024 * 1024:
        return [*meta, hashlib.sha256(path.read_bytes()).hexdigest()]
    if stat.S_ISDIR(info.st_mode):
        children = sorted(path.iterdir())
        if len(children) > 256: raise ValueError('Native configuration tree exceeds its bounded contract')
        return [*meta, {p.name: _tree(p) for p in children}]
    raise ValueError('Native configuration is not an owned bounded regular tree')


def _bind_sources(parent, objects):
    root = Path(parent.root); result = {}
    for obj in objects:
        for mount in obj.get('Mounts', []):
            if mount.get('Type') != 'bind': continue
            path = Path(mount['Source'])
            if path != path.resolve() or not path.is_relative_to(root):
                raise ValueError('Native bind is outside this installation')
            result[str(path.relative_to(root))] = _tree(path)
    return sorted(result)


def _snapshot_paths(parent, paths, objects):
    """Only target instance trees are restorable; shared binds must be read-only."""
    root = Path(parent.root)
    selected = []
    for path in paths:
        if path != path.resolve() or not path.is_relative_to(root / 'modules'):
            raise ValueError('Unsafe native module snapshot instance path')
        files.directory(path, create=False)
        selected.append(str(path.relative_to(root)))
    for obj in objects:
        for mount in obj.get('Mounts', []):
            if mount.get('Type') != 'bind': continue
            source = Path(mount['Source'])
            if source != source.resolve() or not source.is_relative_to(root):
                raise ValueError('Native bind is outside this installation')
            if not any(source.is_relative_to(path) for path in paths) and mount.get('RW') is not False:
                raise ValueError('Writable native bind is outside target instance snapshot roots')
    return sorted(name for name in set(selected)
                  if not any(name != other and Path(name).is_relative_to(other) for other in selected))


def _scoped(value):
    if value.get('snapshot_scope') == 'module' and value.get('requires_full_snapshot') is False:
        return True
    if 'snapshot_scope' not in value and value.get('requires_full_snapshot') is True:
        return False
    raise ValueError('Invalid native module snapshot scope')


def _binding_digest(parent, sources):
    root = Path(parent.root); result = {}
    for name in sources:
        path = root / name
        if not isinstance(name, str) or not path.is_relative_to(root) or path != path.resolve():
            raise ValueError('Unsafe planned native bind source')
        result[name] = _tree(path)
    return digest(result)


def _fingerprint_version(value):
    version = value.get('fingerprint_version', 1)
    if type(version) is int and (version == 2 or version == 1 and value.get('core_version') in LEGACY_FINGERPRINT_CORES):
        return version
    raise ValueError('Unsupported native module fingerprint version')


def _fingerprint(obj, kind, *, shape=False, version=2, version_pair=None):
    if type(version) is not int or version not in (1, 2):
        raise ValueError('Unsupported native module fingerprint version')
    config = copy.deepcopy(obj.get('Config', {})); host = copy.deepcopy(obj.get('HostConfig', {}))
    # Docker reports the unset policy as false after create and null after
    # start. Normalize only that boolean default, never integer zero or true.
    if version == 2 and host.get('OomKillDisable') is False:
        host['OomKillDisable'] = None
    if config.get('Hostname') == obj.get('Id', '')[:12]: config['Hostname'] = ''
    if isinstance(config.get('Env'), list): config['Env'].sort()
    if shape:
        config['Image'] = '<native-image>'
        config.setdefault('Labels', {}).pop('pl.source.sha256', None)
        if kind == 'netmap' and version_pair == ('1.0.0', '1.1.0'):
            labels = config['Labels']
            if labels.get('org.opencontainers.image.version') in version_pair:
                labels['org.opencontainers.image.version'] = '<netmap-compatible-version>'
    for port, bindings in (host.get('PortBindings') or {}).items():
        if kind == 'xray' or kind == 'sftpgo' and port == '2022/tcp': continue
        for binding in bindings or []:
            if binding.get('HostIp') == '127.0.0.1': binding['HostPort'] = '*'
    generated = {obj.get('Id'), obj.get('Id', '')[:12], obj.get('Name', '').removeprefix('/')}
    networks = {name: sorted(set(value.get('Aliases') or []) - generated)
                for name, value in obj.get('NetworkSettings', {}).get('Networks', {}).items()}
    mounts = sorted(obj.get('Mounts', []), key=lambda m: (m.get('Destination', ''), m.get('Source', '')))
    return digest({'image': '<native-image>' if shape else obj.get('Image'), 'config': config,
                   'host': host, 'mounts': mounts, 'networks': networks})


def _fingerprint_matches(value, obj, expected, *, shape=False):
    version = _fingerprint_version(value); kind = value['module_id']
    if _fingerprint(obj, kind, shape=shape, version=version, version_pair=_shape_versions(value)) == expected:
        return True
    if version == 1:
        host = obj.get('HostConfig', {})
        if 'OomKillDisable' in host and (host['OomKillDisable'] is None or host['OomKillDisable'] is False):
            # Existing beta plans contain running-null spec hashes and may also
            # contain created-false ledger hashes. Read exactly those two forms
            # without rewriting their authenticated plan or relaxing any ID.
            alternate = copy.deepcopy(obj)
            alternate['HostConfig']['OomKillDisable'] = False if host['OomKillDisable'] is None else None
            return _fingerprint(alternate, kind, shape=shape, version=1) == expected
    return False


def _owned(parent, kind, instance, obj):
    labels = obj.get('Config', {}).get('Labels') or {}
    if (not re.fullmatch(r'[0-9a-f]{64}', obj.get('Id', ''))
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,199}', obj.get('Name', '').removeprefix('/'))
            or any(labels.get(k) != v for k, v in {'pl.installation': parent.installation,
                   'pl.module': kind, 'pl.instance': instance}.items())):
        raise ValueError('Native container ownership differs')


def _launch_contract(parent, c, kind, instance, role, native, obj):
    image, = json.loads(parent.docker('image', 'inspect', obj['Image']))
    explicit = c.specification(instance, role)[0] if kind in ('doska', 'netmap', 'bookstack') else {}
    expected_env = dict(value.split('=', 1) for value in image.get('Config', {}).get('Env') or [])
    expected_env.update(explicit)
    actual_env = obj.get('Config', {}).get('Env') or []
    labels = (c.labels(instance, native['current']) if kind == 'xray' else
              c.labels(instance, role) if kind in ('wayline', 'forms', 'doska', 'netmap', 'bookstack') else c.labels(instance))
    if kind == 'sftpgo': labels = {**labels, 'pl.sftpgo.revision': str(native['revision'])}
    expected_labels = {**(image.get('Config', {}).get('Labels') or {}), **labels}
    if (dict(value.split('=', 1) for value in actual_env) != expected_env or len(actual_env) != len(expected_env)
            or (obj.get('Config', {}).get('Labels') or {}) != expected_labels):
        raise UnsupportedTransition('Custom native environment or labels require an explicit migration')
    for port, bindings in (obj.get('HostConfig', {}).get('PortBindings') or {}).items():
        if kind == 'xray' or kind == 'sftpgo' and port == '2022/tcp': continue
        if any(binding.get('HostPort') not in ('', '0') for binding in bindings or []):
            raise UnsupportedTransition('Custom fixed native API port requires an explicit migration')
    current = obj.get('State', {})
    if any(current.get(key) for key in ('Paused', 'Restarting', 'Dead')):
        raise UnsupportedTransition('Native runtime requires reconciliation before an artifact update')


def _inventory(parent, *, kind=None):
    ids = set(parent.docker('container', 'ls', '-a', '--filter', 'label=pl.installation=' + parent.installation,
                            *(['--filter', 'label=pl.module=' + kind] if kind else []), '--format', '{{.ID}}').decode().split())
    if kind is None:
        ids.update(parent.docker('container', 'ls', '-a', '--filter', 'label=com.docker.compose.project=' + parent.installation,
                                  '--format', '{{.ID}}').decode().split())
    return json.loads(parent.docker('container', 'inspect', *sorted(ids))) if ids else []


def plan(parent, kind, old_descriptor, new_descriptor, *, scoped=False):
    if type(scoped) is not bool:
        raise ValueError('Invalid native module snapshot scope')
    state, registry = _registry(parent)
    if registry.get(kind) != old_descriptor:
        raise ValueError('Installed native descriptor changed before module preflight')
    changed = _transition(parent, kind, old_descriptor, new_descriptor)
    paths = _paths(parent, kind)
    result = {'schema': 1, 'fingerprint_version': 2, 'installation': parent.installation, 'root': str(parent.root), 'module_id': kind,
              'core_version': state.get('version'), 'core_manifest_sha256': registry['manifest_sha256'],
              'other_registry_sha256': digest({k: v for k, v in registry.items() if k != kind}),
              'old_descriptor': copy.deepcopy(old_descriptor), 'new_descriptor': copy.deepcopy(new_descriptor),
              'requires_full_snapshot': True, 'changed_roles': changed, 'instances': [], 'ledger': {}}
    if scoped:
        result.update(snapshot_scope='module', requires_full_snapshot=False,
                      snapshot_paths=_snapshot_paths(parent, paths, []))
    if not paths and _inventory(parent, kind=kind):
        raise ValueError('Owned module containers have no complete native state')
    c = _controller(parent, kind, old_descriptor) if paths else None
    expected_ids = set()
    for path in paths:
        instance = files.identifier(path.name); native = _state(c, kind, instance)
        objects = [_inspect(c, kind, instance, role) for role in ROLES[kind]]
        if any(obj is None for obj in objects):
            raise ValueError('Incomplete native module must be reconciled before an update')
        if scoped:
            _snapshot_paths(parent, paths, objects)
        running = [obj.get('State', {}).get('Running') is True for obj in objects]
        if any(running) != all(running):
            raise UnsupportedTransition('Mixed native role states require reconciliation before an update')
        item = {'instance_id': instance, 'module_id': kind, 'running': all(running),
                'state_sha256': digest(native), 'bind_sources': _bind_sources(parent, objects),
                'binds_sha256': _binding_digest(parent, _bind_sources(parent, objects)),
                'recreate': list(changed), 'containers': [],
                'volumes': sorted({m['Name'] for obj in objects for m in obj.get('Mounts', []) if m.get('Type') == 'volume'})}
        for role, obj in zip(ROLES[kind], objects):
            _owned(parent, kind, instance, obj)
            _launch_contract(parent, c, kind, instance, role, native, obj)
            expected_ids.add(obj['Id'])
            item['containers'].append({'role': role, 'id': obj['Id'], 'name': obj['Name'].removeprefix('/'), 'image': obj['Image'],
                'running': all(running), 'fingerprint': _fingerprint(obj, kind),
                'shape': _fingerprint(obj, kind, shape=True, version_pair=_shape_versions(result)),
                'env_sha256': digest(sorted(obj.get('Config', {}).get('Env') or [])), 'mounts_sha256': digest(obj.get('Mounts', []))})
        result['instances'].append(item)
    if {obj['Id'] for obj in _inventory(parent, kind=kind)} != expected_ids:
        raise ValueError('Unplanned or orphaned owned module containers exist')
    return result


def _snapshot(parent, value):
    identifier = files.identifier(value.get('snapshot_operation_id'))
    root = Path(parent.root); folder = root / 'private/upgrade-backups' / identifier
    if folder != folder.resolve(): raise ValueError('Unsafe native module snapshot path')
    meta = _record(folder / 'snapshot.json')
    if _scoped(value):
        containers = meta.get('containers', [])
        volumes = meta.get('volumes', [])
        names = [c.get('name') for c in containers]
        volume_names = [v.get('name') for v in volumes]
        expected_names = {c['name'] for item in value['instances'] for c in item['containers']}
        expected_volumes = {name for item in value['instances'] for name in item['volumes']}
        archives = [v.get('archive') for v in volumes]
        checksums = meta.get('files', {})
        paths = _snapshot_paths(parent, _paths(parent, value['module_id']), [])
        if (meta.get('schema') != 2 or meta.get('scope') != 'module'
                or meta.get('module_id') != value['module_id'] or meta.get('installation') != parent.installation
                or meta.get('operation_id') != identifier or meta.get('from_version') != value['core_version']
                or len(names) != len(expected_names) or set(names) != expected_names
                or any(c.get('core') or c.get('module_id', value['module_id']) != value['module_id'] for c in containers)
                or len(volume_names) != len(expected_volumes) or set(volume_names) != expected_volumes
                or set(archives) != {'volume-' + str(i) + '.tar' for i in range(len(volumes))}
                or not isinstance(checksums, dict) or set(checksums) != {'installation.tar', *archives}
                or any(not isinstance(v, str) or not re.fullmatch(r'[0-9a-f]{64}', v) for v in checksums.values())
                or value.get('snapshot_paths') != paths):
            raise ValueError('Scoped native module snapshot does not match this plan')
        return meta
    required = {parent.installation + '-auth', parent.installation + '_db',
                *[name for item in value['instances'] for name in item['volumes']]}
    if (meta.get('schema') != 1 or meta.get('installation') != parent.installation
            or meta.get('operation_id') != identifier or meta.get('from_version') != value['core_version']
            or not required <= {v.get('name') for v in meta.get('volumes', [])}
            or {c.get('service') for c in meta.get('containers', []) if c.get('core')} != {'api', 'web', 'db'}):
        raise ValueError('Complete native module snapshot does not match this plan')
    return meta


def _checkpoint(parent, value):
    callback = getattr(parent, 'module_upgrade_checkpoint', None)
    if not callable(callback): raise ValueError('Durable native module checkpoint callback is required')
    callback(value)


def _raw(parent, name):
    ids = parent.docker('container', 'ls', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}').decode().split()
    if not ids: return None
    if len(ids) != 1: raise ValueError('Native container identity is ambiguous')
    objects = json.loads(parent.docker('container', 'inspect', name))
    if len(objects) != 1 or objects[0].get('Name') != '/' + name:
        raise ValueError('Native container name changed')
    return objects[0]


def _entry(value, spec):
    return value['ledger'].setdefault(spec['name'], {'intent': None, 'replacements': []})


def _remember(parent, value, spec, obj, direction):
    _fingerprint_version(value)
    entry = _entry(value, spec)
    record = {'id': obj['Id'], 'direction': direction, 'fingerprint': _fingerprint(obj, value['module_id'])}
    entry['replacements'] = [r for r in entry['replacements'] if r['id'] != obj['Id']] + [record]
    _checkpoint(parent, value)


def _classify(parent, value, item, spec, obj):
    entry = value['ledger'].get(spec['name'], {'intent': None, 'replacements': []})
    if obj is None:
        if spec['role'] not in value['changed_roles'] or not entry['intent']:
            raise ValueError('Native container disappeared outside its recorded upgrade intent')
        return 'absent'
    _owned(parent, value['module_id'], item['instance_id'], obj)
    if obj.get('State', {}).get('Running'):
        raise ValueError('Native writes were not quiesced before module reconstruction')
    if obj['Id'] == spec['id']:
        if not _fingerprint_matches(value, obj, spec['fingerprint']):
            raise ValueError('Preplanned native container changed')
        return 'old'
    for record in entry['replacements']:
        if record['id'] == obj['Id']:
            if _fingerprint_matches(value, obj, record['fingerprint']):
                return record['direction']
            # A crash can occur after the native, fixed ingress connect and
            # before its final checkpoint. Only the complete target controller
            # and immutable preserved shape may prove that intermediate ID.
            if not entry['intent'] or entry['intent']['action'] != 'create':
                raise ValueError('Recorded native replacement changed')
            break
    intent = entry['intent']
    if intent and intent['action'] == 'create':
        direction = intent['direction']; descriptor = value['new_descriptor'] if direction == 'apply' else value['old_descriptor']
        c = _controller(parent, value['module_id'], descriptor)
        checked = _inspect(c, value['module_id'], item['instance_id'], spec['role'])
        if (checked is not None and checked['Id'] == obj['Id']
                and obj['Image'] == _roles(value['module_id'], descriptor)[spec['role']]['id']
                and _fingerprint_matches(value, obj, spec['shape'], shape=True)):
            return 'adopt-' + direction
    raise ValueError('Unproved container cannot be removed or adopted by module rollback')


def _create(parent, value, item, spec, descriptor, direction):
    kind = value['module_id']; c = _controller(parent, kind, descriptor); instance = item['instance_id']; role = spec['role']
    # Persist the actual Docker create ID before a native controller's subsequent
    # validation can fail. This is provenance from this finite create call, not
    # ownership inferred from a name after the fact.
    def create_only(*args, **kwargs):
        if args[:2] in (('container', 'start'), ('container', 'run'), ('run', '--detach')):
            raise ValueError('Native artifact reconstruction cannot start a container')
        output = parent.docker(*args, **kwargs)
        if args[:2] == ('container', 'create'):
            identifier = output.decode().strip()
            obj = _raw(parent, spec['name'])
            if (not re.fullmatch(r'[0-9a-f]{64}', identifier) or obj is None or obj['Id'] != identifier
                    or obj['Image'] != _roles(kind, descriptor)[role]['id'] or obj.get('State', {}).get('Running')):
                raise ValueError('Native create did not prove its exact new container identity')
            _owned(parent, kind, instance, obj)
            _remember(parent, value, spec, obj, direction)
        return output
    c.docker = create_only
    if kind == 'prometheus': c.create(instance)
    elif kind == 'xray': c.create_container(instance, c.active(instance)['current'], start=False)
    elif kind == 'alertmanager': c.create_container(instance, start=False)
    elif kind == 'grafana': c.create(instance)
    elif kind == 'forms': c.create(instance, role)
    elif kind == 'sftpgo':
        state = c.state(instance); c.create(instance, state['configuration'], state['revision'])
    else:
        c.create_container(instance, role)
        if kind == 'bookstack' and role == 'web':
            obj = c.inspect(instance, role, allow_pending=True)
            ingress = parent.installation + '_ingress'
            if ingress not in obj.get('NetworkSettings', {}).get('Networks', {}):
                c.docker('network', 'connect', '--alias', 'pl-bookstack-' + instance, ingress, obj['Id'])
    obj = _inspect(c, kind, instance, role)
    if (obj is None or obj.get('State', {}).get('Running')
            or obj.get('Name') != '/' + spec['name'] or obj['Image'] != _roles(kind, descriptor)[role]['id']
            or not _fingerprint_matches(value, obj, spec['shape'], shape=True)):
        raise ValueError('Native replacement changed its preserved launch contract')
    _remember(parent, value, spec, obj, direction)
    return obj


def _execute(parent, value, direction):
    if (not isinstance(value, dict) or value.get('schema') != 1
            or value.get('installation') != parent.installation or value.get('root') != str(parent.root)
            or value.get('module_id') not in ROLES or not isinstance(value.get('instances'), list)
            or not isinstance(value.get('ledger'), dict) or not callable(getattr(parent, 'module_upgrade_checkpoint', None))):
        raise ValueError('Invalid native module reconstruction plan or checkpoint contract')
    scoped = _scoped(value)
    _fingerprint_version(value)
    state, registry = _registry(parent); kind = value['module_id']
    descriptor = value['new_descriptor'] if direction == 'apply' else value['old_descriptor']
    if (state.get('version') != value['core_version'] or registry.get('manifest_sha256') != value['core_manifest_sha256']
            or registry.get(kind) != descriptor
            or (not scoped and digest({k: v for k, v in registry.items() if k != kind}) != value['other_registry_sha256'])):
        raise ValueError('Native module registry/core was not selected or restored as required')
    if _transition(parent, kind, value['old_descriptor'], value['new_descriptor']) != value['changed_roles']:
        raise ValueError('Native module upgrade image transition changed')
    meta = _snapshot(parent, value)
    expected_names = {c['name'] for c in meta['containers']}
    for obj in _inventory(parent, kind=kind) if scoped else _inventory(parent):
        labels = obj.get('Config', {}).get('Labels') or {}
        web = labels.get('com.docker.compose.project') == parent.installation and labels.get('com.docker.compose.service') == 'web'
        if obj.get('Name', '').removeprefix('/') not in expected_names or obj.get('State', {}).get('Running') and (scoped or not web):
            raise ValueError('Native writes are not quiesced against the module snapshot' if scoped else
                             'Global native writes are not quiesced against the complete snapshot')
    paths = _paths(parent, kind)
    if {p.name for p in paths} != {item['instance_id'] for item in value['instances']}:
        raise ValueError('Native instance inventory changed since module preflight')
    checks = []
    c = _controller(parent, kind, descriptor) if paths else None
    for item in value['instances']:
        if digest(_state(c, kind, item['instance_id'])) != item['state_sha256']:
            raise ValueError('Native private state was not preserved or restored')
        objects = []
        for spec in item['containers']:
            obj = _raw(parent, spec['name']); status = _classify(parent, value, item, spec, obj)
            if (obj is not None and direction == 'apply' and status in ('apply', 'adopt-apply')
                    and not _fingerprint_matches(value, obj, spec['shape'], shape=True)):
                raise ValueError('Existing native replacement changed its preserved launch contract')
            checks.append((item, spec, obj, status))
            if obj is not None: objects.append(obj)
        if scoped:
            _snapshot_paths(parent, paths, objects)
        if _binding_digest(parent, item['bind_sources']) != item['binds_sha256']:
            raise ValueError('Native bound configuration changed since module preflight')
    planned_ids = {obj['Id'] for _, _, obj, _ in checks if obj is not None}
    if {obj['Id'] for obj in _inventory(parent, kind=kind)} != planned_ids:
        raise ValueError('Unplanned owned native module containers exist')
    for item, spec, obj, status in checks:
        if status.startswith('adopt-'):
            _remember(parent, value, spec, obj, status.removeprefix('adopt-'))
    for item, spec, obj, status in checks:
        if spec['role'] not in value['changed_roles']: continue
        desired = 'apply' if direction == 'apply' else 'rollback'
        if status in (desired, 'adopt-' + desired) or direction == 'rollback' and status == 'old': continue
        entry = _entry(value, spec)
        if obj is not None:
            # Re-read exact IDs/fingerprints immediately before destructive removal.
            actual = _raw(parent, spec['name']); _classify(parent, value, item, spec, actual)
            if actual is None or actual['Id'] != obj['Id']:
                raise ValueError('Native container changed immediately before removal')
            entry['intent'] = {'action': 'remove', 'direction': direction, 'id': obj['Id']}
            _checkpoint(parent, value)
            parent.docker('container', 'rm', obj['Id'])
        entry['intent'] = {'action': 'create', 'direction': direction}
        _checkpoint(parent, value)
        _create(parent, value, item, spec, descriptor, direction)
        entry['intent'] = None
        _checkpoint(parent, value)
    return value


def apply(parent, value):
    return _execute(parent, value, 'apply')


def rollback(parent, value):
    """The caller has already restored old root, all volumes and old registry."""
    return _execute(parent, value, 'rollback')


class _VerificationDeadline(BaseException):
    pass


@contextmanager
def _verification_budget(seconds):
    """The finite worker is single-threaded; interrupt even a blocked native IO."""
    if threading.current_thread() is not threading.main_thread() or not hasattr(signal, 'setitimer'):
        raise ValueError('Native readiness verification requires the finite main-thread worker')
    before = time.monotonic(); previous = signal.getitimer(signal.ITIMER_REAL)
    handler = signal.getsignal(signal.SIGALRM)
    def expired(signum, frame): raise _VerificationDeadline()
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, min(seconds, previous[0]) if previous[0] else seconds)
    try:
        yield
    except _VerificationDeadline:
        raise ValueError('Native module readiness exceeded its 120 second verification budget') from None
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, handler)
        if previous[0]:
            signal.setitimer(signal.ITIMER_REAL, max(0.000001, previous[0] - (time.monotonic() - before)), previous[1])


def verify(parent, value, *, direction='apply'):
    """Inspect selected images and original states; probe only running instances.

    The root worker has started its originally running names in dependency order.
    No lifecycle ensure/get method or scheduler/database write is used here.
    """
    if direction not in ('apply', 'rollback'):
        raise ValueError('Invalid native module verification direction')
    with _verification_budget(120):
        _fingerprint_version(value)
        state, registry = _registry(parent)
        kind = value['module_id']
        descriptor = value['new_descriptor'] if direction == 'apply' else value['old_descriptor']
        if (value.get('schema') != 1 or value.get('installation') != parent.installation
                or state.get('version') != value['core_version'] or registry.get(kind) != descriptor
                or registry.get('manifest_sha256') != value['core_manifest_sha256']):
            raise ValueError('Native module verification registry differs')
        _snapshot(parent, value)
        c = _controller(parent, kind, descriptor) if value['instances'] else None
        deadline = time.monotonic() + 120
        for item in value['instances']:
            if digest(_state(c, kind, item['instance_id'])) != item['state_sha256']:
                raise ValueError('Native state changed during artifact verification')
            if _binding_digest(parent, item['bind_sources']) != item['binds_sha256']:
                raise ValueError('Native configuration changed during artifact verification')
            while True:
                try:
                    for spec in item['containers']:
                        obj = _inspect(c, kind, item['instance_id'], spec['role'])
                        if obj is None: raise ValueError('Native verification container is absent')
                        _owned(parent, kind, item['instance_id'], obj)
                        records = value['ledger'].get(spec['name'], {}).get('replacements', [])
                        permitted = {spec['id']}
                        if spec['role'] in value['changed_roles']:
                            permitted = {r['id'] for r in records if r['direction'] == direction}
                            if direction == 'rollback':
                                permitted.add(spec['id'])  # An untouched original needs no reconstruction.
                        if (obj['Id'] not in permitted or obj['Image'] != _roles(kind, descriptor)[spec['role']]['id']
                                or obj.get('State', {}).get('Running') is not item['running']
                                or not _fingerprint_matches(value, obj, spec['shape'], shape=True)):
                            raise ValueError('Native images, ownership or original running state were not preserved')
                    if item['running']:
                        if kind in ('prometheus', 'xray', 'alertmanager'):
                            if c.observe(item['instance_id']).get('state') != 'running':
                                raise ValueError('Native module runtime is not ready')
                        else: c.ready(item['instance_id'])
                    break
                except (OSError, ValueError):
                    if not item['running'] or time.monotonic() >= deadline:
                        raise ValueError('Native module readiness or preserved state is unconfirmed') from None
                    time.sleep(min(0.5, max(0, deadline - time.monotonic())))
        return {'schema': 1, 'module_id': kind, 'instances': len(value['instances']),
                'running': sum(item['running'] for item in value['instances']),
                'stopped': sum(not item['running'] for item in value['instances']), 'verified': True}
