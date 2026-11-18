"""Validated gateway settings and a recoverable transaction for the owned ocserv instance."""
import base64
from datetime import datetime, timezone
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import stat
import subprocess
import tempfile
import time
import uuid
from urllib.parse import urlsplit


REQUIRED = {'revision', 'actor', 'name', 'issuer', 'client_id', 'public_host', 'public_port',
            'bind_address', 'port', 'pool'}
OPTIONAL = {'cert_pem', 'key_pem', 'client_secret', 'idp_ca_pem'}
DISCOVERY = '/.well-known/openid-configuration'
CALLBACK = '/sso/callback'
FILES = ('gateway.json', 'oidc.json', 'server.crt', 'server.key', 'idp-ca.pem', 'ingress.json', 'ca.crt', 'client-ca.key', 'public.json', 'server-auto.json')
SECRET_FILES = {'oidc.json', 'server.key', 'client-ca.key'}
SUBJECT = re.compile(r'[A-Za-z0-9][A-Za-z0-9._@:+-]{0,61}')
CERT = re.compile(rb'-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+?\s+-----END CERTIFICATE-----')
RESERVED = tuple(ipaddress.IPv4Network(value) for value in
                 ('0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '240.0.0.0/4'))
MAX_PEM = 128 * 1024


class Failure(ValueError):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def invalid(message):
    return Failure(422, 'ocserv_invalid', message)


def unavailable():
    return Failure(404, 'ocserv_connection', 'Профиль подключения VPN недоступен.')


def valid_text(value, limit):
    return isinstance(value, str) and 1 <= len(value) <= limit and value == value.strip() and value.isprintable()


def valid_portal_id(value):
    return isinstance(value, str) and re.fullmatch(
        r'[0-9a-f]{64}|local:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}', value) is not None


def host(value):
    if not valid_text(value, 253) or not value.isascii():
        raise ValueError('Invalid hostname')
    try:
        return str(ipaddress.IPv4Address(value))
    except ValueError:
        if (re.fullmatch(r'[0-9.]+', value) or not all(re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?', part)
                                                     for part in value.split('.'))):
            raise ValueError('Invalid hostname') from None
        return value.lower()


def https(value):
    if not valid_text(value, 2048) or not value.isascii() or any(c in value for c in ('\\', '#', '?', ' ', '%00')):
        raise ValueError('Invalid HTTPS endpoint')
    u = urlsplit(value)
    if u.scheme != 'https' or u.username is not None or u.password is not None or not u.hostname or u.port == 0:
        raise ValueError('Invalid HTTPS endpoint')
    # Dex may run on an IPv6 backend. The published VPN ingress uses IPv4 or a DNS name.
    if ':' in u.hostname:
        ipaddress.IPv6Address(u.hostname)
    else:
        host(u.hostname)
    return u


def discovery_json(url, context):
    u = https(url)
    conn = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=4, context=context)
    try:
        conn.request('GET', u.path or '/', headers={'Accept': 'application/json'})
        response = conn.getresponse()
        if response.status != 200:
            raise ValueError('OIDC endpoint unavailable')
        raw = response.read(512 * 1024 + 1)
        if len(raw) > 512 * 1024:
            raise ValueError('OIDC response exceeds size limit')
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError('Invalid OIDC metadata')
        return data
    finally:
        conn.close()


def preflight_dex(issuer, ca):
    context = ssl.create_default_context()
    if ca:
        try:
            blocks = CERT.findall(ca)
            if not 1 <= len(blocks) <= 32 or CERT.sub(b'', ca).strip():
                raise ValueError('Invalid PEM bundle')
            for block in blocks:
                checker = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                checker.load_verify_locations(cadata=block.decode('ascii'))
                if checker.cert_store_stats()['x509_ca'] != 1:
                    raise ValueError('Expected a CA')
            context.load_verify_locations(cadata=ca.decode('ascii'))
        except (ValueError, ssl.SSLError):
            raise invalid('Загрузите цепочку удостоверяющих центров Dex в формате PEM.') from None
    try:
        info = discovery_json(issuer.rstrip('/') + DISCOVERY, context)
        if info.get('issuer') != issuer:
            raise ValueError('Issuer mismatch')
        origin = https(issuer)
        for field in ('authorization_endpoint', 'token_endpoint', 'jwks_uri'):
            endpoint = https(info.get(field))
            if (endpoint.hostname, endpoint.port or 443) != (origin.hostname, origin.port or 443):
                raise ValueError('Dex endpoint origin mismatch')
        keys = discovery_json(info['jwks_uri'], context).get('keys')
        if not isinstance(keys, list) or not any(isinstance(k, dict) and k.get('kid') and k.get('use', 'sig') == 'sig'
                and ((k.get('kty') == 'RSA' and k.get('n') and k.get('e')) or
                     (k.get('kty') == 'EC' and k.get('crv') and k.get('x') and k.get('y'))) for k in keys):
            raise ValueError('Signing keys unavailable')
    except (OSError, ValueError, http.client.HTTPException, RecursionError):
        raise invalid('Проверьте HTTPS-адрес Dex, доверие к сертификату, discovery и ключи подписи JWKS.') from None


def openssl(args, data=b'', pass_fds=()):
    try:
        return subprocess.run(['openssl', *args], input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              check=True, timeout=10, pass_fds=pass_fds).stdout
    except (OSError, subprocess.SubprocessError):
        raise ValueError('VPN certificate operation failed') from None


def generate_key():
    # The employee key remains in process memory and an anonymous pipe to OpenSSL.
    return openssl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256'])


def self_signed(label, extensions, days, key=None):
    key = key or generate_key()
    args = ['req', '-new', '-x509', '-key', '/dev/stdin', '-subj', '/CN=' + label, '-sha256', '-days', str(days)]
    for extension in extensions:
        args += ['-addext', extension]
    return openssl(args, key), key


def server_pair(public, key=None):
    try:
        ipaddress.IPv4Address(public)
        san = 'IP:'
    except ValueError:
        san = 'DNS:'
    return self_signed('PL VPN gateway', ['basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature',
                       'extendedKeyUsage=serverAuth', 'subjectAltName=' + san + public], 365, key)


def ca_pair():
    return self_signed('PL VPN client CA', ['basicConstraints=critical,CA:TRUE,pathlen:0',
                       'keyUsage=critical,keyCertSign,cRLSign'], 3650)


def client_pair(cn, certfile, keyfile):
    if not isinstance(cn, str) or not re.fullmatch('plc-[0-9a-f]{32}', cn):
        raise unavailable()
    key = generate_key()
    csr = openssl(['req', '-new', '-key', '/dev/stdin', '-subj', '/CN=' + cn, '-sha256'], key)
    with tempfile.TemporaryFile() as extension:
        extension.write(b'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n')
        extension.seek(0)
        fd = extension.fileno()
        # CA material is referenced by verified host-owned paths. Each issuance gets a fresh random serial.
        cert = openssl(['x509', '-req', '-CA', str(certfile), '-CAkey', str(keyfile),
                        '-set_serial', '0x' + uuid.uuid4().hex, '-days', '30', '-sha256',
                        '-extfile', '/dev/fd/' + str(fd)], csr, pass_fds=(fd,))
    return cert.decode('ascii'), key.decode('ascii')


def spki(der):
    return 'pin-sha256:' + base64.b64encode(hashlib.sha256(der).digest()).decode('ascii')


def pin(cert):
    try:
        public_key = openssl(['x509', '-pubkey', '-noout'], cert)
        der = openssl(['pkey', '-pubin', '-outform', 'DER'], public_key)
    except (OSError, ValueError):
        raise invalid('Не удалось прочитать открытый ключ сертификата шлюза.') from None
    return spki(der)


def verify_certificate(stage, cert, key, public_host, atomic):
    if not cert or not key:
        raise invalid('Загрузите сертификат шлюза и соответствующий закрытый ключ в формате PEM.')
    try:
        blocks = CERT.findall(cert)
        if not 1 <= len(blocks) <= 32 or CERT.sub(b'', cert).strip():
            raise ValueError('Invalid certificate chain')
        cert_path, key_path = stage / 'check.crt', stage / 'check.key'
        atomic(cert_path, cert)
        atomic(key_path, key)
        # Supplying a password callback also prevents Python/OpenSSL from prompting on an encrypted key.
        ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(cert_path, key_path, password=lambda: '')
        leaf = ssl._ssl._test_decode_cert(str(cert_path))
        now = time.time()
        if not ssl.cert_time_to_seconds(leaf['notBefore']) <= now < ssl.cert_time_to_seconds(leaf['notAfter']):
            raise ValueError('Certificate outside validity period')
        names = leaf.get('subjectAltName', ())
        try:
            addr = ipaddress.IPv4Address(public_host)
        except ValueError:
            name = public_host.lower()
            matches = any(kind == 'DNS' and (value.lower() == name or (value.startswith('*.') and
                          value.count('.') == name.count('.') and name.endswith(value[1:].lower())))
                          for kind, value in names)
        else:
            matches = any(kind == 'IP Address' and value == str(addr) for kind, value in names)
        if not matches:
            raise invalid('В сертификате шлюза отсутствует DNS-имя или IP внешнего адреса в subjectAltName.')
    except Failure:
        raise
    except (OSError, ValueError, KeyError):
        raise invalid('Проверьте срок действия, формат сертификата и соответствие закрытого ключа.') from None
    finally:
        for name in ('check.crt', 'check.key'):
            (stage / name).unlink(missing_ok=True)
    return pin(cert)


def pem(payload, field, previous):
    if field not in payload:
        return previous
    value = payload[field]
    if not isinstance(value, str) or not value.isascii() or len(value) > MAX_PEM:
        raise invalid('Файл PEM должен быть в текстовом формате, размером до 128 КиБ.')
    if not value and field != 'idp_ca_pem':
        raise invalid('Загрузите непустые сертификат и ключ шлюза.')
    return value.encode('ascii') or None


def check_ports(address, port):
    try:
        for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
            with socket.socket(socket.AF_INET, kind) as probe:
                probe.bind((address, port))
    except OSError:
        raise invalid('Не удалось привязать порт TCP и UDP к выбранному адресу шлюза.') from None


def operator_entry(path, secret):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(fd)
        mode = stat.S_IMODE(info.st_mode)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or mode & (0o7077 if secret else 0o7022)
                or not 0 < info.st_size <= 1024 * 1024):
            raise ValueError('Unsafe VPN operator configuration')
        data = stream.read(1024 * 1024 + 1)
        if len(data) != info.st_size:
            raise ValueError('VPN operator configuration changed')
        return data, mode, (info.st_ino, info.st_ctime_ns, info.st_size)


def provider_issuer(provider):
    explicit = provider.get('required_claims', {}).get('iss')
    if isinstance(explicit, str) and explicit:
        return explicit
    discovery = provider.get('openid_configuration_url', '')
    return discovery[:-len(DISCOVERY)] if discovery.endswith(DISCOVERY) else ''


def active(grant):
    if grant.get('status') != 'active':
        return False
    expires = grant.get('expires_at')
    if expires == '':
        return True
    try:
        return datetime.strptime(expires, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc) > datetime.now(timezone.utc)
    except (TypeError, ValueError):
        return False


class GatewaySetup:
    def __init__(self, controller, files, discovery):
        self.c, self.files, self.discovery = controller, files, discovery

    def path(self, name):
        if name in ('ingress.json', 'public.json', 'server-auto.json'):
            return self.c.base / name
        if name == 'client-ca.key':
            return self.c.operations / name
        return self.c.operator / name

    def pending(self, instance):
        return self.c.operations / ('setup-' + self.files.identifier(instance) + '.pending')

    def entries(self):
        return {name: operator_entry(self.path(name), name in SECRET_FILES) for name in FILES}

    def provider(self, entries):
        return json.loads(entries['oidc.json'][0]) if entries['oidc.json'] else {}

    def revision(self, entries):
        # Version only file identity, modification and size. No secret-derived digest is exposed.
        return hashlib.sha256(self.files.encoded({k: v[2] if v else None for k, v in entries.items()})).hexdigest()

    def snapshot(self, obj):
        reply = self.c.call(obj, 'state', {})
        if reply['status'] != 200 or not isinstance(reply['body'].get('gateway'), dict):
            raise ValueError('VPN gateway state unavailable')
        return reply['body']

    def describe(self, instance, entries, snapshot):
        gateway = json.loads(entries['gateway.json'][0]) if entries['gateway.json'] else {}
        provider = self.provider(entries) if gateway.get('auth_mode') == 'oidc' else {}
        ingress = self.c.desired_ingress() or {}
        public_host, public_port = ingress.get('address', ''), ingress.get('port', 0)
        if entries['public.json']:
            endpoint = json.loads(entries['public.json'][0])
            public_host, public_port = endpoint['host'], endpoint['port']
        if provider.get('redirect_uri'):
            callback = https(provider['redirect_uri'])
            public_host, public_port = callback.hostname, callback.port or 443
        ready = bool(ingress and self.c.state(instance)['ingress'] == ingress and snapshot.get('gateway', {}).get('ready')
                     and all(gateway.get(k) == snapshot['gateway'].get(k) for k in ('auth_mode', 'pool', 'name')))
        fingerprint = ''
        if entries['server.crt']:
            try:
                fingerprint = pin(entries['server.crt'][0])
            except Failure:
                ready = False
        return {'revision': self.revision(entries), 'name': gateway.get('name', 'Корпоративный VPN'),
                'auth_mode': gateway.get('auth_mode', ''), 'managed_certificates': gateway.get('managed_certificates') is True,
                'pool': gateway.get('pool', ''),
                'issuer': provider_issuer(provider), 'client_id': provider.get('client_id', ''),
                'public_host': public_host, 'public_port': public_port,
                'bind_address': ingress.get('address', ''), 'port': ingress.get('port', 0),
                'has_certificate': bool(entries['server.crt']), 'has_key': bool(entries['server.key']),
                'has_client_secret': bool(provider.get('client_secret')), 'has_idp_ca': bool(entries['idp-ca.pem']),
                'certificate_pin': fingerprint, 'ready': ready}

    def connection(self, instance, payload, obj):
        if not obj or not obj['State'].get('Running') or obj['State'].get('Restarting'):
            raise unavailable()
        snapshot = self.snapshot(obj)
        entries = self.entries()
        setup = self.describe(instance, entries, snapshot)
        mode = setup['auth_mode']
        if not (setup['ready'] and setup['certificate_pin'] and setup['has_key'] and setup['public_host'] and setup['public_port']):
            raise unavailable()
        if mode == 'certificate':
            gateway = json.loads(entries['gateway.json'][0])
            if not (gateway.get('managed_certificates') is True and entries['ca.crt'] and entries['client-ca.key']):
                raise unavailable()
        elif mode != 'oidc' or not setup['issuer']:
            raise unavailable()
        for grant in snapshot['grants']:
            subject = grant.get('subject')
            if not isinstance(subject, str) or not SUBJECT.fullmatch(subject) or not active(grant):
                continue
            principal = subject if mode == 'certificate' else hashlib.sha256((setup['issuer'] + '\0' + subject).encode()).hexdigest()
            if ('subject' in payload and subject != payload['subject']) or ('portal_user_id' in payload and principal != payload['portal_user_id']):
                continue
            result = {**{k: setup[k] for k in ('issuer', 'auth_mode', 'public_host', 'public_port', 'certificate_pin')}, 'subject': subject}
            if mode == 'certificate':
                cn = grant.get('certificate_subject', '')
                if not isinstance(cn, str) or not re.fullmatch('plc-[0-9a-f]{32}', cn):
                    raise unavailable()
                if not payload.get('status_only'):
                    result['client_cert_pem'], result['client_key_pem'] = client_pair(cn, self.path('ca.crt'), self.path('client-ca.key'))
            return result
        raise unavailable()

    def tls_material(self, payload, entries, public, stage):
        cert = pem(payload, 'cert_pem', entries['server.crt'][0] if entries['server.crt'] else None)
        key = pem(payload, 'key_pem', entries['server.key'][0] if entries['server.key'] else None)
        marker = json.loads(entries['server-auto.json'][0]) if entries['server-auto.json'] else None
        uploaded = bool({'cert_pem', 'key_pem'} & payload.keys())
        if not uploaded and marker and (not cert or hashlib.sha256(cert).hexdigest() == marker['certificate_sha256']):
            # Only the PL-issued certificate may be renewed. Keep the private key and every employee's pin.
            if not key or spki(openssl(['pkey', '-pubout', '-outform', 'DER'], key)) != marker['pin']:
                raise invalid('Восстановите закрытый ключ шлюза PL или загрузите новую пару TLS.')
            try:
                fingerprint = verify_certificate(stage, cert, key, public, self.files.atomic)
                openssl(['x509', '-checkend', str(30 * 86400), '-noout'], cert)
            except (Failure, ValueError):
                cert, key = server_pair(public, key)
            else:
                return cert, key, fingerprint, entries['server-auto.json'][0]
        elif not uploaded and not cert and not key and marker is None:
            cert, key = server_pair(public)
        else:
            return cert, key, verify_certificate(stage, cert, key, public, self.files.atomic), None
        fingerprint = verify_certificate(stage, cert, key, public, self.files.atomic)
        return cert, key, fingerprint, self.files.encoded({'certificate_sha256': hashlib.sha256(cert).hexdigest(),
                                                        'pin': fingerprint})

    def prepare(self, payload, entries, snapshot, stage, current_ingress):
        if self.revision(entries) != payload['revision']:
            raise Failure(409, 'ocserv_conflict', 'Настройки шлюза изменились. Откройте мастер ещё раз.')
        mode = payload.get('auth_mode', 'oidc')
        if mode not in ('certificate', 'oidc') or not valid_text(payload['actor'], 256) or not valid_text(payload['name'], 128):
            raise invalid('Проверьте способ входа, имя администратора и название шлюза.')
        issuer = payload.get('issuer', '')
        try:
            if mode == 'oidc':
                if not valid_text(payload.get('client_id'), 256):
                    raise ValueError('Invalid client ID')
                https(issuer)
            public = host(payload['public_host'])
            addr = ipaddress.IPv4Address(payload['bind_address'])
            address = str(addr)
            if address != payload['bind_address'] or addr.is_unspecified or addr.is_multicast or addr.is_reserved or addr.is_link_local:
                raise ValueError('Invalid IPv4 ingress')
            for field in ('port', 'public_port'):
                if type(payload[field]) is not int or not 1 <= payload[field] <= 65535:
                    raise ValueError('Invalid port')
        except (TypeError, ValueError):
            raise invalid('Проверьте HTTPS-адрес Dex, внешний адрес, локальный IPv4 и порты шлюза.') from None
        ingress = {'address': address, 'port': payload['port']}
        addresses, local_networks, _ = self.discovery().local_inventory()
        if address not in addresses:
            raise invalid('Выберите IPv4-адрес, назначенный интерфейсу хоста PL.')
        try:
            pool = ipaddress.IPv4Network(payload['pool']) if isinstance(payload['pool'], str) else None
            if pool is None or str(pool) != payload['pool'] or not 8 <= pool.prefixlen <= 29:
                raise ValueError('Invalid pool')
        except ValueError:
            raise invalid('Задайте пул VPN в формате IPv4 CIDR с префиксом от /8 до /29.') from None
        profile_networks = [ipaddress.IPv4Network(n) for p in snapshot['profiles'] for n in p['networks']]
        if any(pool.overlaps(n) for n in (*RESERVED, *local_networks, *profile_networks)):
            raise invalid('Пул VPN пересекается с интерфейсом хоста, служебной подсетью или сетью профиля.')
        if current_ingress != ingress:
            check_ports(address, payload['port'])

        provider = self.provider(entries)
        gateway = json.loads(entries['gateway.json'][0]) if entries['gateway.json'] else {}
        prior_issuer = provider_issuer(provider)
        changing_authority = (gateway.get('auth_mode') != mode or
                              (mode == 'oidc' and prior_issuer != issuer) or
                              (mode == 'certificate' and gateway.get('managed_certificates') is not True))
        if gateway and changing_authority and any(active(g) or g.get('status') == 'pending' for g in snapshot['grants']):
            raise Failure(409, 'ocserv_active_grants', 'Перед сменой источника идентификации отзовите действующие выдачи VPN.')
        if mode == 'oidc':
            if (provider.get('client_secret') and 'client_secret' not in payload and
                    (prior_issuer != issuer or provider.get('client_id') != payload['client_id'])):
                raise invalid('При смене Dex или клиента укажите секрет нового клиента либо выберите публичный клиент.')
            callback_port = '' if payload['public_port'] == 443 else ':' + str(payload['public_port'])
            next_provider = {**provider, 'openid_configuration_url': issuer.rstrip('/') + DISCOVERY,
                             'client_id': payload['client_id'], 'user_name_claim': 'sub',
                             'redirect_uri': 'https://' + public + callback_port + CALLBACK,
                             'required_claims': {**provider.get('required_claims', {}), 'iss': issuer, 'aud': payload['client_id']}}
            if 'client_secret' in payload:
                secret = payload['client_secret']
                if not isinstance(secret, str) or (secret and not valid_text(secret, 4096)):
                    raise invalid('Проверьте секрет клиента Dex.')
                if secret:
                    next_provider['client_secret'] = secret
                else:
                    next_provider.pop('client_secret', None)

        cert, key, expected_pin, auto = self.tls_material(payload, entries, public, stage)
        next_gateway = {'name': payload['name'], 'auth_mode': mode, 'pool': str(pool)}
        values = {name: entry[0] if entry else None for name, entry in entries.items()}
        values.update({'server.crt': cert, 'server.key': key, 'server-auto.json': auto, 'ingress.json': self.files.encoded(ingress),
                       'public.json': self.files.encoded({'host': public, 'port': payload['public_port']})})
        if mode == 'oidc':
            ca = pem(payload, 'idp_ca_pem', entries['idp-ca.pem'][0] if entries['idp-ca.pem'] else None)
            preflight_dex(issuer, ca)
            values.update({'oidc.json': self.files.encoded(next_provider), 'idp-ca.pem': ca})
        else:
            if ((entries['client-ca.key'] and not entries['ca.crt']) or
                    (gateway.get('managed_certificates') and not (entries['ca.crt'] and entries['client-ca.key']))):
                raise invalid('Восстановите центр выдачи VPN из резервной копии.')
            if not entries['client-ca.key']:
                values['ca.crt'], values['client-ca.key'] = ca_pair()
            else:
                # Refuse a CA replaced by another operator before issuing a broken profile.
                key_public = openssl(['pkey', '-pubout'], entries['client-ca.key'][0])
                cert_public = openssl(['x509', '-pubkey', '-noout'], entries['ca.crt'][0])
                openssl(['x509', '-checkend', '0', '-noout'], entries['ca.crt'][0])
                if key_public != cert_public:
                    raise invalid('Ключ центра выдачи VPN не соответствует сертификату.')
            next_gateway['managed_certificates'] = True
        values['gateway.json'] = self.files.encoded(next_gateway)
        return values, ingress, next_gateway, expected_pin

    def apply_files(self, values):
        for name in FILES:
            if name not in values:
                continue
            path = self.path(name)
            before = operator_entry(path, name in SECRET_FILES)
            value = values[name]
            if value is None:
                if before:
                    path.unlink()
                    self.files.fsync_directory(path.parent)
            elif not before or (before[0], before[1]) != value:
                self.files.atomic(path, *value)

    def apply_ingress(self, instance, obj, ingress):
        state = self.c.state(instance)
        if obj:
            # Docker returns snapshots. Reinspect the exact owned container after stop.
            stopped = self.c.inspect(instance)
            if not stopped or stopped['Id'] != obj['Id'] or stopped['State'].get('Running'):
                raise ValueError('VPN container changed or did not stop')
            obj = stopped
        if state['ingress'] != ingress:
            if obj:
                self.c.docker('container', 'rm', obj['Id'])
                obj = None
            self.files.atomic(self.c.instances / instance / 'state.json', {**state, 'ingress': ingress})
        if not obj:
            # 'docker create --mount type=volume' can otherwise create a missing volume.
            if not self.c.resource(instance, 'volume') or not self.c.resource(instance, 'network'):
                raise ValueError('VPN resources missing')
            obj = self.c.create(instance)
        self.c.start(instance, obj)
        running = self.c.inspect(instance)
        if (not running or running['Id'] != obj['Id'] or not running['State'].get('Running')
                or running['State'].get('Restarting')):
            raise ValueError('Expected VPN container did not start')
        return running

    def ready(self, obj, expected):
        deadline = time.monotonic() + 12
        while True:
            state = self.snapshot(obj)
            gateway = state['gateway']
            if gateway.get('ready') and all(gateway.get(k) == v for k, v in expected.items()):
                return state
            if time.monotonic() >= deadline:
                raise ValueError('VPN gateway readiness timed out')
            time.sleep(.25)

    def check_listener(self, ingress, public, cert):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.hostname_checks_common_name = False
        ctx.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
        ctx.load_verify_locations(cadata=cert.decode('ascii'))
        expected = ssl.PEM_cert_to_DER_cert(CERT.search(cert).group().decode('ascii'))
        with socket.create_connection((ingress['address'], ingress['port']), timeout=4) as sock:
            with ctx.wrap_socket(sock, server_hostname=public) as tls:
                if tls.getpeercert(binary_form=True) != expected:
                    raise ValueError('Published TLS certificate mismatch')

    def stage_path(self, instance):
        return self.pending(instance).with_suffix('.stage')

    def cleanup(self, stage):
        if stage.exists() or stage.is_symlink():
            self.files.directory(stage, create=False)
            shutil.rmtree(stage)
            self.files.fsync_directory(stage.parent)

    def finish(self, instance):
        pending, stage = self.pending(instance), self.stage_path(instance)
        # This rename is the durable commit point. A crash during deletion cannot turn it into a rollback.
        os.rename(pending, stage)
        self.files.fsync_directory(pending.parent)
        self.cleanup(stage)

    def recover(self, instance):
        pending, stage = self.pending(instance), self.stage_path(instance)
        self.cleanup(stage)
        if not pending.exists() and not pending.is_symlink():
            return
        self.files.directory(pending, create=False)
        journal = json.loads(self.files.read_file(pending / 'previous.json'))
        if (set(journal) != {'modes', 'ingress', 'ready'} or set(journal['modes']) != set(FILES)
                or type(journal['ready']) != bool):
            raise ValueError('Invalid VPN setup transaction')
        previous = {}
        for name, mode in journal['modes'].items():
            if mode is None:
                previous[name] = None
            elif type(mode) == int and 0 < mode <= 0o777 and not mode & (0o077 if name in SECRET_FILES else 0o022):
                previous[name] = self.files.read_file(pending / name, limit=1024 * 1024), mode
            else:
                raise ValueError('Invalid VPN setup backup mode')
        obj = self.c.inspect(instance)
        self.c.stop(obj)
        self.apply_files(previous)
        restored = self.apply_ingress(instance, obj, journal['ingress'])
        if journal['ready']:
            self.ready(restored, json.loads(previous['gateway.json'][0]))
        self.finish(instance)

    def configure(self, instance, payload, obj):
        entries = self.entries()
        snapshot = self.snapshot(obj)
        state = self.c.state(instance)
        stage, pending = self.stage_path(instance), self.pending(instance)
        self.files.directory(stage)
        try:
            values, ingress, gateway, expected_pin = self.prepare(payload, entries, snapshot, stage, state['ingress'])
            if (state['ingress'] == ingress and snapshot['gateway'].get('ready') and
                    all(data == (entries[name][0] if entries[name] else None) for name, data in values.items())):
                self.check_listener(ingress, host(payload['public_host']), values['server.crt'])
                return self.describe(instance, entries, snapshot)
            for name, entry in entries.items():
                if entry:
                    self.files.atomic(stage / name, entry[0])
            self.files.atomic(stage / 'previous.json', {'ingress': state['ingress'], 'ready': bool(snapshot['gateway'].get('ready')),
                               'modes': {name: entry[1] if entry else None for name, entry in entries.items()}})
            os.rename(stage, pending)
            self.files.fsync_directory(self.c.operations)
            try:
                self.c.stop(obj)
                self.apply_files({name: (data, entries[name][1] if entries[name] and entries[name][0] == data else 0o600)
                                  if data else None for name, data in values.items()})
                running = self.apply_ingress(instance, obj, ingress)
                updated = self.ready(running, gateway)
                self.check_listener(ingress, host(payload['public_host']), values['server.crt'])
                result = self.describe(instance, self.entries(), updated)
                if not result['ready'] or result['certificate_pin'] != expected_pin:
                    raise ValueError('VPN setup readback failed')
            except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
                try:
                    self.recover(instance)
                except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
                    raise Failure(503, 'ocserv_recovery', 'Откат настроек шлюза ожидает восстановления ресурсов модуля.') from None
                raise Failure(503, 'ocserv_apply', 'Проверка запуска шлюза не прошла. Предыдущая конфигурация восстановлена.') from None
            self.finish(instance)
            return result
        finally:
            self.cleanup(stage)
