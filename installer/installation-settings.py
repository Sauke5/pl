#!/usr/bin/env python3
"""Finite, reversible public origin, TLS and destination policy configuration."""
from __future__ import annotations

import copy
import base64
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.parse

_spec = importlib.util.spec_from_file_location('pl_configuration_files', Path(__file__).with_name('delivery.py'))
files = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(files)

TERMINAL = ('complete', 'failed', 'rolled_back', 'recovery_required')
ORIGIN_MODULES = {'forms', 'doska', 'netmap', 'bookstack', 'grafana'}
CONFIG_FILES = ('config/compose.json', 'state/installation.json', 'private/tls.crt', 'private/tls.key', 'private/outbound-ca.pem')


class ConfigurationError(ValueError):
    def __init__(self, code='installation_invalid', message='Проверьте адрес PL, сетевые разрешения и TLS-сертификат.', status=400):
        self.public_code, self.public_message, self.status = code, message, status
        super().__init__(message)


def origin(value):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise ConfigurationError()
    try:
        url = urllib.parse.urlsplit(value)
        host, port = url.hostname, url.port if url.port is not None else 443
        if (url.scheme != 'https' or not host or url.username is not None or url.password is not None
                or url.path not in ('', '/') or url.query or url.fragment or not 1 <= port <= 65535):
            raise ValueError()
        if '%' in host:
            raise ValueError()
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None:
            if address.is_unspecified or address.is_multicast or address.is_link_local:
                raise ValueError()
            host = str(address)
            hostname = '[' + host + ']' if address.version == 6 else host
        else:
            if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?', host):
                raise ValueError()
            if any(not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label) for label in host.rstrip('.').split('.')):
                raise ValueError()
            host = host.lower().rstrip('.')
            hostname = host
        return 'https://' + hostname + (':' + str(port) if port != 443 else ''), host, port
    except (ValueError, TypeError):
        raise ConfigurationError(message='Укажите HTTPS-адрес PL без пути, параметров и учётных данных.') from None


def validate(body):
    required = {'operation_id', 'revision', 'public_url', 'bind_address', 'allowed_cidrs', 'allowed_ports'}
    optional = {'tls_cert_pem', 'tls_key_pem', 'outbound_ca_pem'}
    if not isinstance(body, dict) or not required <= body.keys() <= required | optional:
        raise ConfigurationError()
    try:
        files.canonical_id(body['operation_id'])
        if type(body['revision']) is not int or not 0 <= body['revision'] < 2**53 - 1:
            raise ValueError()
        public, host, port = origin(body['public_url'])
        bind = ipaddress.ip_address(body['bind_address'])
        if str(bind) != body['bind_address'] or bind.is_multicast or bind.is_link_local or '%' in body['bind_address']:
            raise ValueError()
        cidrs = body['allowed_cidrs']
        if not isinstance(cidrs, list) or len(cidrs) > 64:
            raise ValueError()
        networks = []
        for value in cidrs:
            network = ipaddress.ip_network(value, strict=True)
            if not isinstance(value, str) or str(network) != value or network.prefixlen == 0:
                raise ValueError()
            networks.append(value)
        ports = body['allowed_ports']
        if not isinstance(ports, list) or not 1 <= len(ports) <= 64 or any(type(p) is not int or not 1 <= p <= 65535 for p in ports):
            raise ValueError()
        cert, key = body.get('tls_cert_pem', ''), body.get('tls_key_pem', '')
        if (not isinstance(cert, str) or not isinstance(key, str) or bool(cert) != bool(key)
                or len(cert.encode()) > 64 * 1024 or len(key.encode()) > 64 * 1024
                or cert and (b'PRIVATE KEY' in cert.encode() or 'BEGIN CERTIFICATE' not in cert)
                or key and not re.search(r'-----BEGIN (?:RSA |EC )?PRIVATE KEY-----', key)):
            raise ValueError()
        if 'outbound_ca_pem' in body and (not isinstance(body['outbound_ca_pem'], str) or len(body['outbound_ca_pem'].encode()) > 64 * 1024):
            raise ValueError()
    except ConfigurationError:
        raise
    except (ValueError, TypeError, AttributeError):
        raise ConfigurationError() from None
    return {**body, 'public_url': public, 'hostname': host, 'port': port,
            'allowed_cidrs': sorted(set(networks)), 'allowed_ports': sorted(set(ports)),
            'tls_cert_pem': cert, 'tls_key_pem': key}


class InstallationSettings:
    def __init__(self, delivery):
        self.delivery, self.parent, self.root = delivery, delivery.parent, delivery.root

    def revision(self, state):
        value = state.get('config_revision', 0)
        if type(value) is not int or not 0 <= value < 2**53 - 1:
            raise ConfigurationError(message='Запись настроек установки повреждена.')
        return value

    def custom_tls(self, state):
        if type(state.get('config', {}).get('custom_tls')) is bool:
            return state['config']['custom_tls']
        # Compatibility for installations made before this explicit metadata.
        try:
            data = self.delivery.host(['openssl', 'x509', '-in', str(self.root / 'private/tls.crt'), '-noout', '-subject', '-issuer', '-nameopt', 'RFC2253'])
            lines = data.decode().splitlines()
            return lines[0].partition('=')[2] != lines[1].partition('=')[2]
        except (ValueError, OSError, IndexError, subprocess.SubprocessError):
            raise ConfigurationError(message='Не удалось прочитать установленный TLS-сертификат.') from None

    def status(self, body):
        if body != {}:
            raise ConfigurationError()
        state = self.delivery.state()
        model = files.read(self.root / 'config/compose.json')
        env = model['services']['api']['environment']
        try:
            cidrs = [v for v in env.get('PORTAL_ALLOWED_CIDRS', '').split(',') if v]
            ports = [int(v) for v in env.get('PORTAL_ALLOWED_PORTS', '80,443').split(',') if v]
        except (ValueError, TypeError):
            raise ConfigurationError(message='Не удалось прочитать действующие сетевые разрешения PL.') from None
        operation = self.delivery.status({}, refresh=False).get('operation')
        projection = None
        if operation:
            projection = {k: operation.get(k, '') for k in ('operation_id', 'phase', 'error', 'next_url', 'started_at', 'finished_at', 'kind')}
        outbound = self.root / 'private/outbound-ca.pem'
        if outbound.is_symlink() or outbound.exists() and (not outbound.is_file() or outbound.stat().st_size > 64 * 1024):
            raise ConfigurationError(message='Не удалось прочитать доверенные исходящие CA.')
        if env.get('PORTAL_OUTBOUND_CA_FILE', '') not in ('', '/run/secrets/outbound-ca.pem'):
            raise ConfigurationError(message='Исходящее доверие задано устаревшим серверным контрактом. Требуется перенос в настройки установки.')
        if env.get('PORTAL_OUTBOUND_CA_FILE') and not outbound.exists():
            raise ConfigurationError(message='Файл доверенных исходящих CA недоступен.')
        ca_pem = outbound.read_text() if env.get('PORTAL_OUTBOUND_CA_FILE') else ''
        if len(ca_pem.encode()) > 64 * 1024:
            raise ConfigurationError(message='Файл доверенных исходящих CA превышает допустимый размер.')
        return {'core_api': 1, 'public_url': state['config']['public_url'], 'bind_address': state['config']['bind_address'],
                'allowed_cidrs': cidrs, 'allowed_ports': ports, 'custom_tls': self.custom_tls(state),
                'outbound_ca_pem': ca_pem, 'outbound_ca_sha256': hashlib.sha256(ca_pem.encode()).hexdigest() if ca_pem else '',
                'revision': self.revision(state), 'operation': projection}

    def configure(self, body):
        value = validate(body)
        fingerprint = hashlib.sha256(files.json_bytes(value)).hexdigest()
        with self.delivery.lock():
            state = self.delivery.state()
            previous_path = self.delivery.base / 'operation.json'
            if previous_path.exists():
                previous = files.read(previous_path)
                if previous.get('operation_id') == value['operation_id']:
                    if previous.get('kind') != 'configuration' or previous.get('fingerprint') != fingerprint:
                        raise ConfigurationError('installation_conflict', 'Идентификатор уже использован для других настроек.', 409)
                    return self.status({})
            try:
                self.delivery.require_idle()
            except ValueError:
                raise ConfigurationError('installation_conflict', 'Другая операция установки выполняется или требует восстановления.', 409) from None
            if value['revision'] != self.revision(state):
                raise ConfigurationError('installation_conflict', 'Настройки уже изменились. Обновите данные перед сохранением.', 409)
            self.preflight_port(value, state['config'])
            pending = self.root / 'private/installation-configurations'
            files.directory(pending)
            folder = pending / value['operation_id']
            if folder.exists() or folder.is_symlink():
                raise ConfigurationError('installation_conflict', 'Идентификатор уже использован для настройки установки.', 409)
            files.directory(folder)
            try:
                custom, changed = self.prepare_tls(folder, value, state)
                candidate = {**state['config'], **{k: value[k] for k in ('public_url', 'hostname', 'port', 'bind_address', 'allowed_cidrs', 'allowed_ports')}, 'custom_tls': custom}
                if 'outbound_ca_pem' in value:
                    candidate['outbound_ca_pem'] = value['outbound_ca_pem']
                if candidate.get('outbound_ca_pem'):
                    files.atomic(folder / 'outbound-ca.pem', candidate['outbound_ca_pem'].encode())
                    self.validate_outbound_ca(folder / 'outbound-ca.pem')
                plan = self.origin_plan(state['config'], candidate, changed)
                # The request saved for the worker contains no PEM/private key.
                request = {'schema': 1, 'revision': value['revision'], 'config': candidate, 'tls_changed': changed,
                           'module_plan': plan, 'fingerprint': fingerprint}
                files.atomic(folder / 'request.json', request)
                operation = {'operation_id': value['operation_id'], 'kind': 'configuration', 'version': state['version'],
                             'from_version': state['version'], 'phase': 'queued', 'fingerprint': fingerprint,
                             'next_url': candidate['public_url'], 'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'error': ''}
                self.delivery._launch(operation, recovering=False)
            except BaseException:
                if not previous_path.exists() or files.read(previous_path).get('operation_id') != value['operation_id']:
                    shutil.rmtree(folder)
                raise
        return self.status({})

    def origin_helper(self):
        path = Path(__file__).with_name('module-origin.py')
        if not path.exists():
            return None
        if path.is_symlink() or not path.is_file():
            raise ConfigurationError()
        spec = importlib.util.spec_from_file_location('pl_configuration_module_origin', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def origin_plan(self, previous, candidate, tls_changed):
        helper = self.origin_helper()
        if helper:
            plan = helper.plan(self.parent, previous, candidate, tls_changed)
            if plan is not None and (not isinstance(plan, dict) or plan.get('schema') != 1 or plan.get('requires_full_snapshot') is not True):
                raise ConfigurationError(message='Не подтверждён безопасный перенос origin установленных модулей.')
            return plan
        installed = []
        for kind in sorted(ORIGIN_MODULES):
            parent = self.root / 'modules' / kind / 'instances'
            if parent.exists() and any(parent.iterdir()):
                installed.append(kind)
        if previous['public_url'] != candidate['public_url'] and installed:
            raise ConfigurationError('installation_origin_modules', 'Перенос адреса требует совместимого обновления origin модулей: ' + ', '.join(installed) + '.', 409)
        if tls_changed and 'doska' in installed:
            raise ConfigurationError('installation_tls_modules', 'Замена TLS требует совместимого обновления доверенного сертификата модуля: doska.', 409)
        return None

    def preflight_port(self, value, previous):
        addresses = files.load_json(self.delivery.host(['ip', '-j', 'address', 'show']))
        assigned = {entry['local'] for interface in addresses for entry in interface.get('addr_info', []) if entry.get('local')}
        if value['bind_address'] not in assigned | {'0.0.0.0', '::'}:
            raise ConfigurationError(message='Адрес прослушивания должен принадлежать этому устройству.')
        ids = self.parent.docker('container', 'ls', '-a', '--format', '{{.ID}}').decode().split()
        for container in files.load_json(self.parent.docker('container', 'inspect', *ids)) if ids else []:
            labels = container.get('Config', {}).get('Labels') or {}
            own_web = labels.get('com.docker.compose.project') == self.delivery.installation and labels.get('com.docker.compose.service') == 'web'
            if own_web:
                continue
            for bindings in (container.get('HostConfig', {}).get('PortBindings') or {}).values():
                for binding in bindings or []:
                    if str(binding.get('HostPort')) == str(value['port']) and overlapping_bind(binding.get('HostIp') or '0.0.0.0', value['bind_address']):
                        raise ConfigurationError(message='Выбранный HTTPS-порт занят другим контейнером.')
        # The owned web listener is expected to occupy its current address.
        if value['port'] != previous['port'] or not overlapping_bind(value['bind_address'], previous['bind_address']):
            self.available(value['bind_address'], value['port'])

    @staticmethod
    def available(address, port):
        try:
            with socket.socket(socket.AF_INET6 if ':' in address else socket.AF_INET) as listener:
                listener.bind((address, port))
        except OSError:
            raise ConfigurationError(message='Выбранный адрес или HTTPS-порт недоступен для PL.') from None

    def prepare_tls(self, folder, value, state):
        current_cert = self.root / 'private/tls.crt'
        old_host = urllib.parse.urlsplit(state['config']['public_url']).hostname
        custom = self.custom_tls(state)
        if value['tls_cert_pem']:
            cert, key = value['tls_cert_pem'].encode(), value['tls_key_pem'].encode()
            files.atomic(folder / 'tls.crt', cert); files.atomic(folder / 'tls.key', key)
            custom = True
        elif value['hostname'] != old_host and not custom:
            san = ('IP:' if is_ip(value['hostname']) else 'DNS:') + value['hostname']
            self.delivery.host(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-noenc', '-sha256', '-days', '365',
                                '-subj', '/CN=' + value['hostname'], '-addext', 'subjectAltName=' + san,
                                '-keyout', str(folder / 'tls.key'), '-out', str(folder / 'tls.crt')], timeout=30)
            (folder / 'tls.key').chmod(0o600); (folder / 'tls.crt').chmod(0o600)
        else:
            files.atomic(folder / 'tls.crt', current_cert.read_bytes())
            files.atomic(folder / 'tls.key', (self.root / 'private/tls.key').read_bytes())
        self.validate_tls(folder / 'tls.crt', folder / 'tls.key', value['hostname'])
        return custom, files.digest(folder / 'tls.crt') != files.digest(current_cert)

    def validate_tls(self, cert, key, hostname):
        try:
            san = self.delivery.host(['openssl', 'x509', '-in', str(cert), '-noout', '-ext', 'subjectAltName'])
            if b'DNS:' not in san and b'IP Address:' not in san:
                raise ValueError()
            self.delivery.host(['openssl', 'x509', '-in', str(cert), '-noout', '-checkend', '86400'])
            self.delivery.host(['openssl', 'verify', '-partial_chain', '-trusted', str(cert),
                                '-verify_ip' if is_ip(hostname) else '-verify_hostname', hostname, str(cert)])
            public = self.delivery.host(['openssl', 'x509', '-in', str(cert), '-pubkey', '-noout'])
            actual = self.delivery.host(['openssl', 'pkey', '-in', str(key), '-passin', 'pass:', '-pubout'])
            if public != actual:
                raise ValueError()
        except (ValueError, OSError, subprocess.SubprocessError):
            raise ConfigurationError(message='TLS-сертификат должен быть действующим, содержать SAN для адреса PL и соответствовать незашифрованному приватному ключу.') from None

    def validate_outbound_ca(self, path):
        raw = path.read_bytes()
        blocks = re.findall(rb'-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----', raw)
        remainder = raw
        for block in blocks:
            remainder = remainder.replace(block, b'', 1)
        if not blocks or len(blocks) > 64 or remainder.strip() or b'PRIVATE KEY' in raw:
            raise ConfigurationError(message='Для исходящих соединений нужен PEM bundle сертификатов без приватных ключей.')
        try:
            with tempfile.TemporaryDirectory(dir=path.parent) as temporary:
                for index, block in enumerate(blocks):
                    cert = Path(temporary) / ('ca-' + str(index) + '.pem')
                    files.atomic(cert, block + b'\n')
                    self.delivery.host(['openssl', 'x509', '-in', str(cert), '-noout', '-checkend', '0'])
                    self.delivery.host(['openssl', 'verify', '-partial_chain', '-trusted', str(cert), str(cert)])
        except (ValueError, OSError, subprocess.SubprocessError):
            raise ConfigurationError(message='Не удалось проверить сертификаты доверия для исходящих соединений.') from None

    def snapshot(self, operation):
        parent = self.root / 'private/config-backups'; files.directory(parent)
        folder = parent / operation['operation_id']; files.directory(folder)
        metadata = {}
        for index, name in enumerate(CONFIG_FILES):
            source = self.root / name
            if name == 'private/outbound-ca.pem' and not source.exists() and not source.is_symlink():
                metadata[name] = {'present': False}
                continue
            info = source.lstat()
            if source.is_symlink() or not source.is_file():
                raise ConfigurationError()
            destination = folder / str(index)
            files.atomic(destination, source.read_bytes())
            attrs = {attribute: base64.b64encode(os.getxattr(source, attribute, follow_symlinks=False)).decode()
                     for attribute in os.listxattr(source, follow_symlinks=False)}
            metadata[name] = {'present': True, 'file': str(index), 'sha256': files.digest(destination), 'mode': info.st_mode & 0o7777,
                              'uid': info.st_uid, 'gid': info.st_gid, 'xattrs': attrs}
        files.atomic(folder / 'snapshot.json', {'schema': 1, 'installation': self.delivery.installation,
                                               'operation_id': operation['operation_id'], 'files': metadata})
        return folder

    def recreate_core(self):
        self.delivery.compose('up', '--detach', '--pull', 'never', '--no-build', '--force-recreate', '--no-deps',
                              '--wait', '--wait-timeout', '150', 'api', 'web')

    def readback(self, config, model):
        for service in ('api', 'web'):
            ids = self.parent.docker('container', 'ls', '-a', '--filter', 'label=com.docker.compose.project=' + self.delivery.installation,
                                     '--filter', 'label=com.docker.compose.service=' + service, '--format', '{{.ID}}').decode().split()
            if len(ids) != 1:
                raise ValueError('Configured core service identity differs')
            actual = files.load_json(self.parent.docker('container', 'inspect', ids[0]))[0]
            if actual.get('Image') != model['services'][service]['image'] or not actual.get('State', {}).get('Running'):
                raise ValueError('Configured core image or readiness differs')
            if service == 'api':
                env = dict(entry.split('=', 1) for entry in actual.get('Config', {}).get('Env', []))
                for name in ('PORTAL_PUBLIC_URL', 'PORTAL_ALLOWED_CIDRS', 'PORTAL_ALLOWED_PORTS', 'PORTAL_CHECK_INHERIT_INTEGRATION_POLICY',
                             'PORTAL_CHECK_ALLOWED_CIDRS', 'PORTAL_CHECK_ALLOWED_PORTS'):
                    if env.get(name) != model['services']['api']['environment'][name]:
                        raise ValueError('Configured API policy differs from runtime')
                expected_ca = model['services']['api']['environment'].get('PORTAL_OUTBOUND_CA_FILE', '')
                if env.get('PORTAL_OUTBOUND_CA_FILE', '') != expected_ca:
                    raise ValueError('Configured outbound CA differs from runtime')
                if expected_ca:
                    mounts = [m for m in actual.get('Mounts', []) if m.get('Destination') == expected_ca]
                    if len(mounts) != 1 or mounts[0].get('Source') != str(self.root / 'private/outbound-ca.pem') or mounts[0].get('RW'):
                        raise ValueError('Configured outbound CA mount differs from runtime')
            else:
                bindings = actual.get('HostConfig', {}).get('PortBindings') or {}
                if bindings != {'8443/tcp': [{'HostIp': config['bind_address'], 'HostPort': str(config['port'])}]}:
                    raise ValueError('Configured HTTPS binding differs from runtime')

    def perform(self):
        operation = files.read(self.delivery.base / 'operation.json')
        pending = self.root / 'private/installation-configurations' / operation['operation_id']
        request = files.read(pending / 'request.json')
        changed, full, quiesced = False, False, False
        try:
            if request.get('schema') != 1 or request.get('fingerprint') != operation.get('fingerprint'):
                raise ConfigurationError(message='Запись запроса настройки установки повреждена.')
            state = self.delivery.state()
            if request['revision'] != self.revision(state):
                raise ConfigurationError('installation_conflict', 'Настройки уже изменились. Обновите данные перед сохранением.', 409)
            config = request['config']
            self.delivery.operation('validating_configuration')
            self.preflight_port(config, state['config'])
            self.validate_tls(pending / 'tls.crt', pending / 'tls.key', config['hostname'])
            if config.get('outbound_ca_pem'):
                if (pending / 'outbound-ca.pem').read_text() != config['outbound_ca_pem']:
                    raise ConfigurationError()
                self.validate_outbound_ca(pending / 'outbound-ca.pem')
            plan = self.origin_plan(state['config'], config, request['tls_changed'])
            if plan != request['module_plan']:
                raise ConfigurationError('installation_conflict', 'Состав модулей изменился. Повторите сохранение настроек.', 409)
            containers = None
            if plan:
                containers = self.delivery.inventory()
                self.delivery.operation('quiescing', containers=containers)
                full, quiesced = True, True
                self.delivery.stop(containers)
                snapshot = self.delivery.snapshot(operation, containers)
                plan = {**plan, 'snapshot_operation_id': operation['operation_id']}
            else:
                snapshot = self.snapshot(operation)
                quiesced = True
                self.delivery.compose('stop', '--timeout', '30', 'api', 'web')
            self.delivery.operation('applying_configuration', snapshot=str(snapshot), full_snapshot=full, module_origin_plan=plan)
            self.available(config['bind_address'], config['port'])
            model = files.read(self.root / 'config/compose.json')
            api = model['services']['api']
            policy = {'PORTAL_PUBLIC_URL': config['public_url'], 'PORTAL_ALLOWED_CIDRS': ','.join(config['allowed_cidrs']),
                      'PORTAL_ALLOWED_PORTS': ','.join(map(str, config['allowed_ports'])), 'PORTAL_CHECK_INHERIT_INTEGRATION_POLICY': 'false',
                      'PORTAL_CHECK_ALLOWED_CIDRS': ','.join(config['allowed_cidrs']), 'PORTAL_CHECK_ALLOWED_PORTS': ','.join(map(str, config['allowed_ports']))}
            api['environment'].update(policy)
            changed = True
            if 'outbound_ca_pem' in config:
                api['volumes'] = [mount for mount in api.get('volumes', []) if not isinstance(mount, dict) or mount.get('target') != '/run/secrets/outbound-ca.pem']
                if config['outbound_ca_pem']:
                    files.atomic(self.root / 'private/outbound-ca.pem', config['outbound_ca_pem'].encode())
                    (self.root / 'private/outbound-ca.pem').chmod(0o444)
                    api['environment']['PORTAL_OUTBOUND_CA_FILE'] = '/run/secrets/outbound-ca.pem'
                    api['volumes'].append({'type': 'bind', 'source': str(self.root / 'private/outbound-ca.pem'),
                                           'target': '/run/secrets/outbound-ca.pem', 'read_only': True, 'bind': {'create_host_path': False}})
                else:
                    api['environment'].pop('PORTAL_OUTBOUND_CA_FILE', None)
                    (self.root / 'private/outbound-ca.pem').unlink(missing_ok=True)
            model['services']['web']['ports'] = [{'target': 8443, 'published': str(config['port']), 'host_ip': config['bind_address'], 'protocol': 'tcp'}]
            files.atomic(self.root / 'config/compose.json', model)
            files.atomic(self.root / 'private/tls.crt', (pending / 'tls.crt').read_bytes())
            (self.root / 'private/tls.crt').chmod(0o444)
            files.atomic(self.root / 'private/tls.key', (pending / 'tls.key').read_bytes())
            image = files.load_json(self.parent.docker('image', 'inspect', model['services']['web']['image']))[0]
            user = image.get('Config', {}).get('User', '')
            if not re.fullmatch(r'[1-9][0-9]{0,9}:[1-9][0-9]{0,9}', user):
                raise ValueError('Unsupported web image credential owner')
            os.chown(self.root / 'private/tls.key', 0, int(user.split(':')[1]))
            (self.root / 'private/tls.key').chmod(0o640)
            state.update(config=config, config_revision=request['revision'] + 1, phase='configuring')
            files.atomic(self.root / 'state/installation.json', state)
            if plan:
                self.origin_helper().apply(self.parent, plan)
                self.delivery.activate_host(state['version'])
                self.delivery.restart(containers)
                self.origin_helper().verify(self.parent, plan)
            else:
                self.recreate_core()
            self.delivery.operation('verifying_configuration')
            self.readback(config, model)
            self.delivery.readiness()
            state['phase'] = 'ready'; files.atomic(self.root / 'state/installation.json', state)
            self.delivery.operation('complete', error='')
        except BaseException as error:
            self.delivery.record_failure(error)
            if changed or full:
                self.rollback()
            else:
                if quiesced:
                    self.recreate_core()
                    self.delivery.readiness()
                self.delivery.operation('failed', error='Настройки не применены. Предыдущий адрес и конфигурация сохранены.')
        finally:
            if files.read(self.delivery.base / 'operation.json').get('phase') in ('complete', 'failed', 'rolled_back'):
                (pending / 'tls.crt').unlink(missing_ok=True)
                (pending / 'tls.key').unlink(missing_ok=True)

    def rollback(self):
        operation = files.read(self.delivery.base / 'operation.json')
        if (operation.get('full_snapshot') or operation.get('containers')
                or (self.root / 'private/upgrade-backups' / operation['operation_id'] / 'snapshot.json').exists()):
            self.delivery.rollback()
            return
        folder = self.root / 'private/config-backups' / operation['operation_id']
        if (folder / 'snapshot.json').exists():
            snapshot = files.read(folder / 'snapshot.json')
            if (snapshot.get('schema') != 1 or snapshot.get('installation') != self.delivery.installation
                    or snapshot.get('operation_id') != operation['operation_id'] or set(snapshot.get('files', {})) != set(CONFIG_FILES)):
                raise ValueError('Configuration recovery snapshot identity differs')
            for name, meta in snapshot['files'].items():
                if meta.get('present') is False and name == 'private/outbound-ca.pem':
                    continue
                if not re.fullmatch(r'[0-4]', meta.get('file', '')) or files.digest(folder / meta['file']) != meta.get('sha256'):
                    raise ValueError('Configuration recovery snapshot integrity differs')
            self.delivery.operation('restoring_configuration')
            self.delivery.compose('stop', '--timeout', '30', 'api', 'web')
            for name, meta in snapshot['files'].items():
                path = self.root / name
                if meta.get('present') is False:
                    path.unlink(missing_ok=True)
                    continue
                files.atomic(path, (folder / meta['file']).read_bytes())
                os.chown(path, meta['uid'], meta['gid']); path.chmod(meta['mode'])
                for attribute in os.listxattr(path, follow_symlinks=False):
                    os.removexattr(path, attribute, follow_symlinks=False)
                for attribute, value in meta['xattrs'].items():
                    os.setxattr(path, attribute, base64.b64decode(value, validate=True), follow_symlinks=False)
        self.recreate_core()
        self.delivery.readiness()
        self.delivery.operation('rolled_back', error='Настройки не применены. Восстановлены предыдущий адрес, TLS и сетевые разрешения PL.')


def is_ip(value):
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def overlapping_bind(first, second):
    a, b = ipaddress.ip_address(first), ipaddress.ip_address(second)
    return a.version == b.version and (a == b or a.is_unspecified or b.is_unspecified)
