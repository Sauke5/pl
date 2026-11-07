"""Finite read-only inventory collectors. No discovery, configuration or plugins.

Own CLI parsers for network appliances; no Orb/NAPALM code.
SSH: Paramiko, explicitly supplied host keys and credentials only.
Windows: pywinrm NTLM, verified HTTPS or mandatory HTTP message encryption.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import io
import ipaddress
import json
import math
from pathlib import Path
import re
import socket
import struct
import subprocess
import sys
import ssl
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET

MAX_OUTPUT = 2 * 1024 * 1024
MAX_SNAPSHOT = 1024 * 1024
MAX_INTERFACES = 1024
MAX_NEIGHBORS = 1024
MAX_DISKS = 128
MAX_DURATION = 90
DRIVERS = ('auto', 'openwrt', 'mikrotik_routeros', 'keenetic', 'tplink_jetstream',
           'huawei_vrp', 'cisco_ios', 'junos')
COMMON = {'id', 'name', 'kind', 'username', 'password', 'private_key', 'passphrase', 'ssh_known_hosts', 'port', 'auth_method'}
CODES = {'inventory_profile_invalid', 'inventory_target_invalid', 'inventory_driver_unsupported',
         'inventory_dependency_missing', 'inventory_timeout', 'inventory_output_limit', 'inventory_auth_failed',
         'inventory_host_key_failed', 'inventory_tls_failed', 'inventory_connection_failed',
         'inventory_command_failed', 'inventory_output_invalid'}


class InventoryCollectionError(ValueError):
    def __init__(self, code):
        self.code = code if code in CODES else 'inventory_command_failed'
        super().__init__(self.code)


def fail(code):
    raise InventoryCollectionError(code)


def _text(value, limit=1024, *, empty=True, multiline=False):
    if (not isinstance(value, str) or len(value.encode('utf-8')) > limit or not empty and not value
            or any(ord(c) < 32 and not (multiline and c in '\n\r\t') or ord(c) == 127 for c in value)):
        fail('inventory_profile_invalid')
    return value


def _known_hosts(value):
    _text(value, 262144, empty=False, multiline=True)
    entries = 0
    for line in value.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        parts = line.split()
        if len(parts) < 3 or parts[1] not in ('ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'):
            fail('inventory_profile_invalid')
        for host in parts[0].split(','):
            if host.startswith('['):
                match = re.fullmatch(r'\[([^]]+)\]:([0-9]{1,5})', host)
                if not match or not 1 <= int(match[2]) <= 65535: fail('inventory_profile_invalid')
                host = match[1]
            try: ipaddress.ip_address(host)
            except ValueError: fail('inventory_profile_invalid')
        try: raw = base64.b64decode(parts[2], validate=True)
        except ValueError: fail('inventory_profile_invalid')
        if not 32 <= len(raw) <= 8192: fail('inventory_profile_invalid')
        entries += 1
    if not entries: fail('inventory_profile_invalid')
    return value


def host_key_name(ip, port):
    return ip if port == 22 else f'[{ip}]:{port}'


def ssh_host_pins(known_hosts, expected):
    pins = []
    for line in known_hosts.splitlines():
        parts = line.split(maxsplit=3)
        if len(parts) >= 3 and not parts[0].startswith('#') and expected in parts[0].split(','):
            pins.append((parts[1], parts[2]))
    return pins


def validate_ssh_host_key(value, expected):
    if not isinstance(value, str) or not value.isascii():
        fail('inventory_profile_invalid')
    _text(value, 16384, empty=False)
    parts = value.split()
    if len(parts) != 3 or parts[0] != expected:
        fail('inventory_profile_invalid')
    _known_hosts(value)
    try:
        import paramiko
    except ImportError:
        fail('inventory_dependency_missing')
    algorithm, encoded = parts[1:]
    raw = base64.b64decode(encoded, validate=True)
    try:
        key = paramiko.PKey.from_type_string(algorithm, raw)
        parsed = key.asbytes()
    except (TypeError, ValueError, paramiko.SSHException, struct.error):
        fail('inventory_profile_invalid')
    if key.get_name() != algorithm or parsed != raw:
        fail('inventory_profile_invalid')
    return f'{expected} {algorithm} {key.get_base64()}'


def validate_profile(profile, *, allow_unpinned_ssh=False):
    try:
        if not isinstance(profile, dict) or profile.get('kind') not in ('network', 'linux', 'windows'):
            fail('inventory_profile_invalid')
        kind = profile['kind']
        allowed = COMMON | ({'driver', 'enable_password'} if kind == 'network' else {'scheme', 'transport', 'ca_pem'} if kind == 'windows' else set())
        if set(profile) - allowed or not {'id', 'name', 'kind', 'username'} <= set(profile): fail('inventory_profile_invalid')
        result = dict(profile)
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', result['id']): fail('inventory_profile_invalid')
        _text(result['name'], 256, empty=False); _text(result['username'], 256, empty=False)
        for key, limit in (('password', 4096), ('passphrase', 4096), ('private_key', 65536)):
            result[key] = _text(result.get(key, ''), limit, multiline=key == 'private_key')
        port = result.setdefault('port', 5986 if kind == 'windows' and result.get('scheme', 'https') == 'https' else 5985 if kind == 'windows' else 22)
        if type(port) is not int or not 1 <= port <= 65535: fail('inventory_profile_invalid')
        if kind == 'windows':
            if result.get('auth_method') not in (None, 'password') or result['private_key'] or result['passphrase'] or result.get('ssh_known_hosts'):
                fail('inventory_profile_invalid')
            if not result['password']: fail('inventory_profile_invalid')
            result['auth_method'] = 'password'
            result.setdefault('scheme', 'https'); result.setdefault('transport', 'ntlm'); result.setdefault('ca_pem', '')
            if result['scheme'] not in ('https', 'http') or result['transport'] != 'ntlm': fail('inventory_profile_invalid')
            _text(result['ca_pem'], 65536, multiline=True)
            if result['ca_pem']:
                if result['scheme'] != 'https' or 'PRIVATE KEY' in result['ca_pem']: fail('inventory_profile_invalid')
                ssl.create_default_context(cadata=result['ca_pem'])
        else:
            known_hosts = result.get('ssh_known_hosts', '')
            result['ssh_known_hosts'] = '' if allow_unpinned_ssh and known_hosts == '' else _known_hosts(known_hosts)
            result.setdefault('auth_method', 'key' if result['private_key'] else 'password')
            if result['auth_method'] not in ('password', 'key') or (result['auth_method'] == 'key') != bool(result['private_key']):
                fail('inventory_profile_invalid')
            if bool(result['password']) == bool(result['private_key']) or result['passphrase'] and not result['private_key']:
                fail('inventory_profile_invalid')
            if result['private_key'] and ('PRIVATE KEY-----' not in result['private_key'] or not result['private_key'].strip().endswith('PRIVATE KEY-----')):
                fail('inventory_profile_invalid')
            if kind == 'network':
                if result.get('driver') not in DRIVERS: fail('inventory_driver_unsupported')
                result['enable_password'] = _text(result.get('enable_password', ''), 4096)
                if result['enable_password'] and result['driver'] not in ('cisco_ios', 'tplink_jetstream'):
                    fail('inventory_profile_invalid')
        return result
    except InventoryCollectionError:
        raise
    except (ValueError, TypeError, KeyError, UnicodeError, ssl.SSLError):
        fail('inventory_profile_invalid')


def _target(target, kind):
    try:
        if not isinstance(target, dict) or target.get('kind') != kind or kind not in ('network', 'linux', 'windows'):
            fail('inventory_target_invalid')
        if str(uuid.UUID(target['id'])) != target['id']: fail('inventory_target_invalid')
        address = ipaddress.ip_address(target['address'])
        # Link-local includes cloud metadata. Do not allow scoped IPv6 targets.
        policy_address = getattr(address, 'ipv4_mapped', None) or address
        if ('%' in target['address'] or any((policy_address.is_loopback, policy_address.is_link_local, policy_address.is_multicast, policy_address.is_unspecified))
                or str(policy_address) in ('100.100.100.200', 'fd00:ec2::254')):
            fail('inventory_target_invalid')
        if str(address) != target['address']: fail('inventory_target_invalid')
        if target.get('network_id') not in (None, '') and not re.fullmatch(r'[0-9a-f]{16}', target['network_id']): fail('inventory_target_invalid')
        return str(address)
    except InventoryCollectionError:
        raise
    except (ValueError, KeyError, TypeError):
        fail('inventory_target_invalid')


class Budget:
    def __init__(self, deadline=None):
        now = time.monotonic()
        if deadline is not None and (type(deadline) not in (int, float) or not math.isfinite(deadline)):
            fail('inventory_timeout')
        self.deadline = min(now + MAX_DURATION, deadline) if deadline is not None else now + MAX_DURATION
        self.total = 0

    def remaining(self, maximum=15):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0: fail('inventory_timeout')
        return min(maximum, remaining)

    def add(self, data):
        self.total += len(data)
        if self.total > MAX_OUTPUT: fail('inventory_output_limit')


def _snapshot(kind):
    return {'schema': 1, 'kind': kind, 'observed_at': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
        'hostname': '', 'manufacturer': '', 'model': '', 'serial': '', 'os_name': '', 'os_version': '',
        'virtualization': 'unknown', 'cpu_count': None, 'memory_mib': None, 'disks': [], 'interfaces': [],
        'neighbors': [], 'vlans': [], 'vrfs': [], 'modules': [], 'chassis': [], 'warnings': [],
        'capabilities': {name: False for name in ('system', 'interfaces', 'addresses', 'cpu', 'memory', 'disks', 'neighbors', 'vlans', 'vrfs', 'modules', 'chassis', 'interface_vlans')}}


def _string(value, maximum=1024):
    return ''.join(c for c in str(value or '') if ord(c) >= 32 and ord(c) != 127)[:maximum]


def _integer(value, maximum=2**63 - 1):
    try:
        if isinstance(value, bool): return None
        result = int(value)
        return result if 0 <= result <= maximum else None
    except (ValueError, TypeError, OverflowError): return None


def _address(value):
    try:
        # Do not silently turn an address with a missing prefix into /32 or /128.
        if not isinstance(value, str) or '/' not in value or '%' in value: return None
        return str(ipaddress.ip_interface(value))
    except ValueError: return None


def _interface(name, key=None):
    return {'key': _string(key or name, 256), 'name': _string(name, 256), 'description': '', 'mac_address': '',
        'mtu': None, 'speed_mbps': None, 'enabled': None, 'link_up': None, 'type': 'unknown', 'addresses': []}


def _mac(value):
    digits = re.sub(r'[:.\-]', '', value or '').lower()
    return ':'.join(digits[i:i + 2] for i in range(0, 12, 2)) if re.fullmatch(r'[0-9a-f]{12}', digits) and int(digits, 16) else ''


def _finish(value):
    if len(value['interfaces']) > MAX_INTERFACES or len(value['disks']) > MAX_DISKS: fail('inventory_output_limit')
    keys = set()
    for port in value['interfaces']:
        if not port['key'] or not port['name'] or port['key'] in keys: fail('inventory_output_invalid')
        keys.add(port['key'])
        addresses = []
        for row in port['addresses']:
            address = _address(row.get('address'))
            if not address and row.get('address'):
                value['warnings'].append('address_invalid')
            if address and address not in {v['address'] for v in addresses}:
                addresses.append({'address': address, 'vrf': _string(row.get('vrf', ''), 128)})
        if len(addresses) > 128: fail('inventory_output_limit')
        port['addresses'] = addresses
    value['warnings'] = sorted(set(value['warnings']))[:32]
    if len(json.dumps(value).encode()) > MAX_SNAPSHOT: fail('inventory_output_limit')
    return value


@contextmanager
def _ssh(address, profile, budget):
    try: import paramiko
    except ImportError: fail('inventory_dependency_missing')
    client = paramiko.SSHClient()
    with tempfile.TemporaryDirectory(prefix='pl-inventory-ssh-') as folder:
        path = Path(folder, 'known_hosts'); path.write_text(profile['ssh_known_hosts']); path.chmod(0o600)
        try:
            client.load_host_keys(str(path)); client.set_missing_host_key_policy(paramiko.RejectPolicy())
            pkey = None
            if profile['private_key']:
                key_path = Path(folder, 'key'); key_path.write_text(profile['private_key']); key_path.chmod(0o600)
                pkey = paramiko.PKey.from_path(str(key_path), password=profile['passphrase'] or None)
            timeout = budget.remaining()
            client.connect(address, port=profile['port'], username=profile['username'],
                password=profile['password'] or None, pkey=pkey, look_for_keys=False, allow_agent=False,
                timeout=timeout, banner_timeout=timeout, auth_timeout=timeout, channel_timeout=timeout)
            yield client
        except paramiko.BadHostKeyException:
            fail('inventory_host_key_failed')
        except paramiko.AuthenticationException:
            fail('inventory_auth_failed')
        except paramiko.SSHException as error:
            if 'known_hosts' in str(error): fail('inventory_host_key_failed')
            fail('inventory_connection_failed')
        finally:
            client.close()


def _exec(client, command, budget, *, until=None):
    def remaining():
        timeout = budget.remaining()
        if until is not None:
            timeout = min(timeout, until - time.monotonic())
            if timeout <= 0:
                raise socket.timeout()
        return timeout

    channel = client.get_transport().open_session(timeout=remaining())
    try:
        channel.settimeout(remaining()); channel.exec_command(command)
        output, errors = bytearray(), bytearray()
        while True:
            remaining()
            for ready, receive, destination in ((channel.recv_ready, channel.recv, output), (channel.recv_stderr_ready, channel.recv_stderr, errors)):
                if ready():
                    part = receive(65536); budget.add(part); destination.extend(part)
            if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready(): break
            time.sleep(min(0.01, remaining()))
        if channel.recv_exit_status() != 0: fail('inventory_command_failed')
        return bytes(output).decode('utf-8-sig', errors='strict')
    finally: channel.close()


# Linux requires Python3 on the target; ip/lsblk/systemd-detect-virt are optional
# readonly helpers. Missing helpers are explicit, never installed remotely.
LINUX_SCRIPT = r'''import json,os,socket,subprocess
from pathlib import Path
out={'hostname':socket.gethostname(),'manufacturer':'','model':'','serial':'','os_name':'Linux','os_version':'','virtualization':'unknown','cpu_count':os.cpu_count(),'memory_mib':None,'disks':[],'interfaces':[],'warnings':[],'capabilities':{}}
def read(path):
 try:return Path(path).read_text().strip()
 except OSError:return ''
def command(args, codes=(0,)):
 try:
  p=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=8)
  if len(p.stdout)>1048576:raise ValueError('output')
  return p.stdout.decode() if p.returncode in codes else None
 except (OSError,subprocess.TimeoutExpired):return None
for field,path in [('manufacturer','sys_vendor'),('model','product_name'),('serial','product_serial')]:out[field]=read('/sys/class/dmi/id/'+path)
release={}
for line in read('/etc/os-release').splitlines():
 if '=' in line:
  k,v=line.split('=',1);release[k]=v.strip('"')
out['os_name']=release.get('NAME','Linux');out['os_version']=release.get('VERSION_ID','')
for line in read('/proc/meminfo').splitlines():
 if line.startswith('MemTotal:'):out['memory_mib']=int(line.split()[1])//1024
virt=command(['systemd-detect-virt','--vm'],(0,1))
if virt is not None:out['virtualization']='vm' if virt.strip() not in ('','none') else 'physical'

links=command(['ip','-j','-d','address','show'])
if links is None:out['warnings'].append('ip_tool_unavailable')
else:
 for row in json.loads(links):
  link_kind=(row.get('linkinfo') or {}).get('info_kind','')
  if row.get('link_type')=='loopback' or 'LOOPBACK' in row.get('flags',[]) or link_kind=='veth':continue
  name=row['ifname'];p=Path('/sys/class/net')/name
  kind='physical' if (p/'device').exists() else 'virtual' if '/virtual/' in str(p.resolve()) else 'unknown'
  if link_kind in ('bond','team'):kind='lag'
  elif link_kind in ('bridge','vlan','tun','vxlan','ipip','sit','gre','gretap','wireguard','dummy','macvlan','ipvlan'):kind='virtual'
  speed=read(str(p/'speed'))
  out['interfaces'].append({'key':name,'name':name,'description':read(str(p/'ifalias')),'mac_address':row.get('address',''),'mtu':row.get('mtu'),'speed_mbps':int(speed) if speed.isdigit() else None,'enabled':'UP' in row.get('flags',[]),'link_up':row.get('operstate')=='UP','type':kind,'addresses':[{'address':a['local']+'/'+str(a['prefixlen']),'vrf':''} for a in row.get('addr_info',[])]})
 out['capabilities'].update(interfaces=True,addresses=True)
disks=command(['lsblk','-b','-J','-o','NAME,SIZE,TYPE'])
if disks is None:out['warnings'].append('disk_tool_unavailable')
else:
 for row in json.loads(disks).get('blockdevices',[]):
  if row.get('type')=='disk':out['disks'].append({'name':row['name'],'size_bytes':int(row['size'])})
 out['capabilities']['disks']=True
if not out['serial']:out['warnings'].append('serial_unavailable')
if len(out['interfaces'])>1024 or len(out['disks'])>128:raise ValueError('inventory_limit')
raw=json.dumps(out,separators=(',',':'))
if len(raw.encode())>2097152:raise ValueError('inventory_limit')
print(raw)
'''
LINUX_COMMAND = "python3 -c \"import base64;exec(base64.b64decode('" + base64.b64encode(LINUX_SCRIPT.encode()).decode() + "'))\""


def _host_snapshot(kind, raw):
    try: data = json.loads(raw)
    except (ValueError, TypeError): fail('inventory_output_invalid')
    if not isinstance(data, dict): fail('inventory_output_invalid')
    result = _snapshot(kind)
    for key in ('hostname', 'manufacturer', 'model', 'serial', 'os_name', 'os_version'):
        result[key] = _string(data.get(key, ''))
    result['virtualization'] = data.get('virtualization') if data.get('virtualization') in ('physical', 'vm', 'unknown') else 'unknown'
    for key in ('cpu_count', 'memory_mib'): result[key] = _integer(data.get(key))
    ports, disks = data.get('interfaces', []), data.get('disks', [])
    if not isinstance(ports, list) or not isinstance(disks, list) or len(ports) > MAX_INTERFACES or len(disks) > MAX_DISKS:
        fail('inventory_output_limit')
    for row in ports:
        if not isinstance(row, dict): fail('inventory_output_invalid')
        port = _interface(row.get('name'), row.get('key'))
        port.update(description=_string(row.get('description')), mac_address=_mac(row.get('mac_address')),
            mtu=_integer(row.get('mtu')), speed_mbps=_integer(row.get('speed_mbps')),
            enabled=row.get('enabled') if type(row.get('enabled')) is bool else None,
            link_up=row.get('link_up') if type(row.get('link_up')) is bool else None,
            type=row.get('type') if row.get('type') in ('physical', 'virtual', 'lag', 'unknown') else 'unknown')
        addresses = row.get('addresses') or []
        if not isinstance(addresses, list) or len(addresses) > 128: fail('inventory_output_limit')
        for item in addresses:
            if not isinstance(item, dict): fail('inventory_output_invalid')
            address = item.get('address', '')
            if item.get('prefix') is not None:
                try: address = str(ipaddress.ip_interface(address + '/' + str(item['prefix'])))
                except (ValueError, TypeError):
                    result['warnings'].append('address_invalid'); continue
            port['addresses'].append({'address': address, 'vrf': item.get('vrf', '')})
        result['interfaces'].append(port)
    for row in disks:
        if not isinstance(row, dict) or not _string(row.get('name')): fail('inventory_output_invalid')
        size = _integer(row.get('size_bytes'))
        if size is not None: result['disks'].append({'name': _string(row['name'], 256), 'size_bytes': size})
    capabilities = data.get('capabilities', {})
    if not isinstance(capabilities, dict): fail('inventory_output_invalid')
    for key in result['capabilities']:
        result['capabilities'][key] = capabilities.get(key) is True
    result['capabilities'].update(system=bool(result['hostname']), cpu=result['cpu_count'] is not None, memory=result['memory_mib'] is not None)
    result['warnings'] += [code for code in data.get('warnings', []) if code in ('virtualization_unconfirmed', 'ip_tool_unavailable', 'disk_tool_unavailable', 'serial_unavailable', 'interface_provider_unavailable')]
    if result['virtualization'] == 'unknown': result['warnings'].append('virtualization_unconfirmed')
    return _finish(result)


COMMANDS = {
    'huawei_vrp': ('screen-length 0 temporary', 'display version', 'display interface', 'display device manuinfo'),
    'cisco_ios': ('terminal length 0', 'show version', 'show interfaces', 'show inventory'),
    'junos': ('set cli screen-length 0', 'show version | display xml', 'show interfaces | display xml', 'show chassis hardware | display xml'),
}
HUAWEI_OPTIONAL = ('display vlan brief', 'display port vlan', 'display ip vpn-instance', 'display ip vpn-instance interface', 'display stack')
PROMPT = re.compile(r'(?m)^(?:<[^<>\r\n]{1,100}>|[A-Za-z0-9_.@:/()\-]{1,160}[>#])\s*$')
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')


def _shell_read(channel, budget, prompt=None, *, password=False, until=None, paging=False):
    data = bytearray()
    while True:
        remaining = budget.remaining()
        if until is not None:
            remaining = min(remaining, until - time.monotonic())
            if remaining <= 0: raise socket.timeout()
        channel.settimeout(remaining)
        part = channel.recv(65536)
        if not part: fail('inventory_command_failed')
        budget.add(part); data.extend(part)
        text = ANSI.sub('', data.decode('utf-8', errors='replace')).replace('\r', '')
        if paging and (page := re.search(r'(?:--+\s*More\s*--+|Press (?:any key|<space>) to continue)[ \t\b]*$', text, re.I)):
            data = bytearray(text[:page.start()].encode())
            channel.sendall(' ')
            continue
        if password and re.search(r'(?i)password:\s*$', text): return text, None
        matches = list(PROMPT.finditer(text))
        if matches and (prompt is None or matches[-1][0].strip() == prompt):
            return text[:matches[-1].start()], matches[-1][0].strip()


CLI_ERROR = re.compile(r"(?im)^\s*(?:error:|%\s*(?:invalid|unknown|error|unrecognized|incomplete|ambiguous|authorization)|unrecognized command)")


def _huawei_serial(outputs):
    # ESN identifies the chassis; a board-only getter is an optional fallback.
    # A stack reporting multiple different serials is not one invented chassis.
    esns = re.findall(r'^\s*ESN(?: of [^:\r\n]+)?\s*[:=]\s*(\S+)', outputs.get('display esn', ''), re.I | re.M)
    values = esns or re.findall(r'(?:BarCode|Serial Number)\s*[:=]\s*(\S+)', outputs.get('display device manuinfo', ''), re.I)
    serials = {value for value in values if value.lower() not in ('n/a', 'none', 'unknown', '--')}
    return _string(next(iter(serials))) if len(serials) == 1 else ''


def _network_raw(client, profile, budget):
    channel = client.invoke_shell(width=200, height=24)
    try:
        _, prompt = _shell_read(channel, budget)
        if profile.get('enable_password'):
            channel.sendall('enable\n'); _, elevated = _shell_read(channel, budget, password=True)
            if elevated is None:
                channel.sendall(profile['enable_password'] + '\n'); _, prompt = _shell_read(channel, budget)
            else: prompt = elevated
            if not prompt.endswith('#'): fail('inventory_auth_failed')
        output = {}
        commands = COMMANDS[profile['driver']]
        def run(command, *, optional=False):
            channel.sendall(command + '\n')
            body, _ = _shell_read(channel, budget, prompt,
                                  until=time.monotonic() + min(5, budget.remaining()) if optional else None)
            lines = body.splitlines()
            if lines and lines[0].strip() == command: lines.pop(0)
            output[command] = '\n'.join(lines)
            if not optional and command != commands[0] and (not output[command].strip() or CLI_ERROR.search(output[command])):
                fail('inventory_command_failed')
        for command in commands[:3]:
            run(command)
        try:
            run(commands[3], optional=True)
            if profile['driver'] == 'huawei_vrp' and not _huawei_serial(output):
                run('display esn', optional=True)
        except (OSError, EOFError):
            return output, prompt  # Lost prompt: preserve mandatory facts, do not issue more commands.
        except InventoryCollectionError as error:
            if error.code not in ('inventory_timeout', 'inventory_command_failed'): raise
            return output, prompt
        if profile['driver'] == 'huawei_vrp':
            for command in HUAWEI_OPTIONAL:
                try:
                    run(command, optional=True)
                    if command == 'display vlan brief' and (not output[command].strip() or CLI_ERROR.search(output[command])):
                        run('display vlan', optional=True)
                except (OSError, EOFError, InventoryCollectionError) as error:
                    if isinstance(error, InventoryCollectionError) and error.code not in ('inventory_timeout', 'inventory_command_failed'): raise
                    output[command] = '__inventory_optional_failed__'
                    break  # Lost prompt/EOF: never send another command into an unsynchronized stream.
        return output, prompt
    finally: channel.close()


def _match(pattern, text, flags=re.I | re.M):
    found = re.search(pattern, text, flags)
    return _string(found[1]) if found else ''


def _text_interfaces(text, driver):
    pattern = (r'^\s*([^\s]+) current state\s*:\s*([^\r\n]+)' if driver == 'huawei_vrp'
               else r'^\s*([^\s]+) is ([^\r\n]+), line protocol is ([^\r\n]+)')
    headers = list(re.finditer(pattern, text, re.M))
    if len(headers) > MAX_INTERFACES: fail('inventory_output_limit')
    ports = []
    for index, match in enumerate(headers):
        body = text[match.end():headers[index + 1].start() if index + 1 < len(headers) else len(text)]
        port = _interface(match[1])
        state = match[2].strip().lower()
        port['enabled'] = not any(value in state for value in ('administratively', 'admin down'))
        port['link_up'] = state == 'up' and (driver != 'cisco_ios' or match[3].strip().lower().startswith('up'))
        port['description'] = _match(r'^\s*Description\s*:\s*(.*)', body)
        port['mac_address'] = _mac(_match(r'(?:Hardware address is|Hardware is[^\r\n]*?\baddress is)\s+([0-9a-f.:-]+)', body))
        port['mtu'] = _integer(_match(r'(?:Maximum Transmit Unit is|MTU)\s+(\d+)', body))
        speed = _match(r'\bSpeed\s*:\s*(\d+)', body)
        if speed: port['speed_mbps'] = _integer(speed)
        else:
            negotiated = re.search(r'\b(\d+(?:\.\d+)?)\s*([MGT])(?:b/s|bps)\b', body, re.I)
            if negotiated:
                port['speed_mbps'] = int(float(negotiated[1]) * {'m': 1, 'g': 1000, 't': 1000000}[negotiated[2].lower()])
        hardware = _match(r'Hardware is\s+([^,\r\n]+)', body).lower()
        if hardware in ('ethernet', 'gigabit ethernet', 'fast ethernet', 'ten gigabit ethernet') or re.search(r'Port Mode:\s*(?:COMMON COPPER|COMMON FIBER)', body): port['type'] = 'physical'
        elif hardware in ('ethersvi', 'loopback', 'tunnel'): port['type'] = 'virtual'
        elif hardware in ('etherchannel', 'aggregated ethernet'): port['type'] = 'lag'
        for address in re.findall(r'(?:Internet [Aa]ddress is|Internet Address is|Internet protocol processing\s*:\s*)\s*([0-9a-fA-F:./]+)', body):
            normalized = _address(address)
            if normalized: port['addresses'].append({'address': normalized, 'vrf': ''})
        ports.append(port)
    return ports


def _xml(text):
    if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper(): fail('inventory_output_invalid')
    start = text.find('<rpc-reply')
    if start < 0: fail('inventory_output_invalid')
    end = text.rfind('</rpc-reply>')
    if end < start: fail('inventory_output_invalid')
    try: root = ET.fromstring(text[start:end + len('</rpc-reply>')])
    except ET.ParseError: fail('inventory_output_invalid')
    for node in root.iter(): node.tag = node.tag.rsplit('}', 1)[-1]
    if root.find('.//rpc-error') is not None: fail('inventory_command_failed')
    return root


def _junos(outputs):
    result = _snapshot('network'); result.update(manufacturer='Juniper', os_name='Junos')
    version = _xml(outputs[COMMANDS['junos'][1]])
    result.update(hostname=_string(version.findtext('.//host-name')), model=_string(version.findtext('.//product-model')), os_version=_string(version.findtext('.//junos-version')))
    interfaces = _xml(outputs[COMMANDS['junos'][2]])
    for row in interfaces.findall('.//physical-interface'):
        port = _interface(row.findtext('name'), row.findtext('snmp-index') or row.findtext('name'))
        port.update(description=_string(row.findtext('description')), mac_address=_mac(row.findtext('current-physical-address')),
            mtu=_integer(row.findtext('mtu')), enabled=row.findtext('admin-status') == 'up', link_up=row.findtext('oper-status') == 'up')
        itype = (row.findtext('if-type') or '').lower()
        port['type'] = 'lag' if itype in ('ae', 'aggregated-ethernet', 'aggregatedethernet') else 'physical' if itype in ('ethernet', 'fast-ethernet', 'gigabit-ethernet') else 'unknown'
        speed = row.findtext('speed') or ''
        match = re.fullmatch(r'(\d+(?:\.\d+)?)\s*([kmgt])(?:bps)?', speed, re.I)
        if match and match[2].lower() in ('k', 'm', 'g', 't'):
            port['speed_mbps'] = int(float(match[1]) * {'k': .001, 'm': 1, 'g': 1000, 't': 1000000}[match[2].lower()])
        result['interfaces'].append(port)
        for logical in row.findall('logical-interface'):
            child = _interface(logical.findtext('name'), logical.findtext('snmp-index') or logical.findtext('name'))
            child.update(type='virtual', description=_string(logical.findtext('description')))
            for address in logical.findall('.//interface-address'):
                local, destination = address.findtext('ifa-local') or '', address.findtext('ifa-destination') or ''
                if '/' not in local and '/' in destination: local += '/' + destination.rsplit('/', 1)[1]
                if _address(local): child['addresses'].append({'address': local, 'vrf': ''})
            result['interfaces'].append(child)
    hardware = outputs.get(COMMANDS['junos'][3], '')
    if '<rpc-reply' in hardware:
        try:
            tree = _xml(hardware)
            result['serial'] = _string(tree.findtext('.//chassis/serial-number'))
        except InventoryCollectionError:
            pass
    return result


def _vlan_ids(text):
    values = set()
    if text.strip() in ('-', '--', ''): return []
    for token in text.replace(',', ' ').split():
        match = re.fullmatch(r'(\d+)(?:-(\d+))?', token)
        if not match: raise ValueError()
        start, end = int(match[1]), int(match[2] or match[1])
        if not 1 <= start <= end <= 4094: raise ValueError()
        values.update(range(start, end + 1))
    return sorted(values)


def _huawei_optional(result, outputs):
    # These parsers consume only finite show tables. Unknown formats never
    # authorize clearing an existing assignment in the writer.
    ports = {port['name']: port for port in result['interfaces']}
    def body(command):
        text = outputs.get(command)
        if text is None: return None
        if not text.strip() or CLI_ERROR.search(text) or text == '__inventory_optional_failed__':
            result['warnings'].append('optional_getter_failed')
            return None
        return text
    preferred = outputs.get('display vlan brief', '')
    text = body('display vlan brief') if preferred.strip() and not CLI_ERROR.search(preferred) else body('display vlan')
    if text is not None:
        rows = {}
        for line in text.splitlines():
            match = re.match(r'^\s*(\d+)\s+(?:enable|disable)\s+\S+\s+\S+\s+\S+\s+(.+?)\s*$', line, re.I)
            if not match:
                match = re.match(r'^\s*(\d+)\s+(?:enable|disable)\s+(?:forward|discard)\s+(.+?)\s*$', line, re.I)
            if match and 1 <= int(match[1]) <= 4094:
                rows[int(match[1])] = _string(match[2], 128)
        if rows:
            result['vlans'] = [{'vid': vid, 'name': name} for vid, name in sorted(rows.items())]
            result['capabilities']['vlans'] = True
        else: result['warnings'].append('optional_format_unrecognized')
    text = body('display port vlan')
    if text is not None:
        staged = {}; valid = bool(re.search(r'Port\s+Link Type\s+PVID', text))
        logical = []
        for line in text.splitlines():
            if re.fullmatch(r'\s+\d+(?:[-,\s]+\d+)*\s*', line) and logical:
                logical[-1] += ' ' + line.strip()
            else: logical.append(line)
        for line in logical:
            match = re.match(r'^\s*(\S+)\s+(access|trunk|hybrid|auto|-)\s+(\d+)\s+(.+?)\s*$', line, re.I)
            if not match: continue
            if match[2].lower() in ('auto', '-'):
                continue  # Auto-negotiated/routed state is not an observed switchport mode.
            if match[1] not in ports: valid = False; continue
            # A hybrid port can have multiple untagged VLANs; PVID alone cannot
            # represent that. Preserve its assignments rather than guessing.
            if match[2].lower() == 'hybrid':
                result['warnings'].append('hybrid_vlan_unrepresented'); continue
            try:
                pvid = int(match[3]); tagged = _vlan_ids(match[4])
                if not 1 <= pvid <= 4094: raise ValueError()
            except ValueError: valid = False; continue
            mode = 'access' if match[2].lower() == 'access' else 'tagged-all' if len(tagged) == 4094 else 'tagged'
            staged[match[1]] = {'mode': mode, 'untagged_vlan': pvid,
                'tagged_vlans': [vid for vid in tagged if vid != pvid] if mode == 'tagged' else []}
        if valid:
            for name, fields in staged.items(): ports[name].update(fields)
            result['capabilities']['interface_vlans'] = True
        else: result['warnings'].append('optional_format_unrecognized')
    text = body('display ip vpn-instance')
    if text is not None:
        rows = {}; valid = 'VPN-Instance' in text or bool(re.search(r'no VPN|Total VPN', text, re.I))
        for line in text.splitlines():
            match = re.match(r'^\s*(\S+)\s+(?:(\S+:\S+)\s+)?IPv[46](?:-family)?\s*$', line, re.I)
            if match:
                name, rd = _string(match[1],128), match[2] or None
                if name in rows and rd and rows[name] and rows[name] != rd:
                    valid = False; break
                rows[name] = rd or rows.get(name)
        if valid:
            result['vrfs'] = [{'name': name, 'rd': rd} for name,rd in sorted(rows.items())]
            result['capabilities']['vrfs'] = True
        else: result['warnings'].append('optional_format_unrecognized')
    # Membership parser is populated only by a recognized named block/table.
    text = body('display ip vpn-instance interface')
    if text is not None:
        name = None; seen = False
        for line in text.splitlines():
            match = re.search(r'VPN-Instance\s+(?:Name\s*(?::|and ID\s*:))\s*([^,\s]+)', line, re.I)
            if match: name = match[1]; seen = True; continue
            if name:
                for candidate in line.replace(',', ' ').split():
                    if candidate in ports and any(row['name'] == name for row in result['vrfs']):
                        for address in ports[candidate]['addresses']: address['vrf'] = name
        if not seen: result['warnings'].append('optional_format_unrecognized')
    text = body('display stack')
    if text is not None:
        rows = []
        for line in text.splitlines():
            parts = line.split()
            if len(parts) >= 5 and parts[0].lstrip('+').isdigit() and parts[1].lower() in ('master','standby','slave') and _mac(parts[2]) and parts[3].isdigit():
                rows.append({'slot': int(parts[0].lstrip('+')), 'role': _string(parts[1],32), 'mac_address': _mac(parts[2]),
                    'priority': int(parts[3]), 'model': _string(' '.join(parts[4:]),128)})
        if len(rows) > 128: fail('inventory_output_limit')
        if rows or re.search(r'Stack mode\s*:\s*No', text, re.I):
            result['chassis'] = rows; result['capabilities']['chassis'] = True
        else: result['warnings'].append('optional_format_unrecognized')


def parse_network(driver, outputs, prompt=''):
    if driver not in COMMANDS: fail('inventory_driver_unsupported')
    outputs = {key: re.sub(r'----\s*More\s*----', '', ANSI.sub('', value)).replace('\r', '') for key, value in outputs.items()}
    for command in COMMANDS[driver][1:3]:
        if not outputs.get(command, '').strip() or CLI_ERROR.search(outputs[command]): fail('inventory_command_failed')
    if driver == 'junos': result = _junos(outputs)
    else:
        result = _snapshot('network')
        version = outputs.get(COMMANDS[driver][1], '')
        if not version or re.search(r'(?im)^\s*(?:%\s*(?:invalid|unknown|error)|error:|unrecognized command)', version): fail('inventory_command_failed')
        result.update(manufacturer='Huawei' if driver == 'huawei_vrp' else 'Cisco', os_name='VRP' if driver == 'huawei_vrp' else 'IOS')
        if driver == 'huawei_vrp':
            result['os_version'] = _match(r'Versatile Routing Platform Software\s*\n[^\n]*Version\s+([^\n]+)', version) or _match(r'VRP.*?Version\s+([^\n]+)', version)
            result['model'] = (_match(r'^(?:HUAWEI|Huawei)\s+([A-Za-z0-9_.-]+)\s+(?:Routing Switch|Router|Switch)(?:\s+uptime|\s*$)', version)
                               or _match(r'^([A-Za-z][A-Za-z0-9_.-]*[0-9][A-Za-z0-9_.-]*)\s+uptime is', version))
            hardware = outputs.get(COMMANDS[driver][3], '')
            result['serial'] = _huawei_serial(outputs)
        else:
            result['os_version'] = _match(r'\bVersion\s+([^,\s]+)', version)
            result['model'] = _match(r'^cisco\s+(\S+)\s+\(', version)
            result['serial'] = _match(r'Processor board ID\s+(\S+)', version) or _match(r'\bSN:\s*(\S+)', outputs.get(COMMANDS[driver][3], ''))
            result['hostname'] = _match(r'^([^\s]+) uptime is', version)
        result['interfaces'] = _text_interfaces(outputs.get(COMMANDS[driver][2], ''), driver)
    if driver == 'huawei_vrp': _huawei_optional(result, outputs)
    if not result['hostname']:
        result['hostname'] = _string(prompt.strip('<>#').split('@')[-1])
    if not result['interfaces'] or not result['os_version']: fail('inventory_output_invalid')
    if not result['serial']: result['warnings'].append('serial_unavailable')
    if not result['model']: result['warnings'].append('model_unavailable')
    result['capabilities'].update(system=bool(result['hostname'] or result['model']), interfaces=bool(result['interfaces']), addresses=any(p['addresses'] for p in result['interfaces']))
    return _finish(result)


OPENWRT_BOARD = 'ubus call system board'
OPENWRT_PORTS = 'ip address show'
OPENWRT_ARP = 'ip -4 neigh show'
OPENWRT_ARP_FALLBACK = 'cat /proc/net/arp'
OPENWRT_NDP = 'ip -6 neigh show'
OPENWRT_DHCP = 'cat /tmp/dhcp.leases'
OPENWRT_FDB = 'bridge fdb show'
ROS_SYSTEM = '/system resource print'
ROS_IDENTITY = '/system identity print'
ROS_BOARD = '/system routerboard print'
ROS_INTERFACES = '/interface print terse without-paging'
ROS_IP = '/ip address print terse without-paging'
ROS_IPV6 = '/ipv6 address print terse without-paging'
ROS_ARP = '/ip arp print terse without-paging'
ROS_NDP = '/ipv6 neighbor print terse without-paging'
ROS_DHCP = '/ip dhcp-server lease print terse without-paging'
ROS_FDB = '/interface bridge host print terse without-paging'
ROS_NEIGHBOR = '/ip neighbor print terse without-paging'
KEENETIC_VERSION = 'show version'
KEENETIC_PORTS = 'show interface'
KEENETIC_ARP = 'show ip arp'
KEENETIC_DHCP = 'show ip dhcp bindings'
TPLINK_SYSTEM = 'show system-info'
TPLINK_PORTS = 'show interface status'
TPLINK_IP_BRIEF = 'show ip interface brief'
TPLINK_IP = 'show ip address'
TPLINK_FDB = 'show mac address-table'
VENDOR_CLI_ERROR = re.compile(r'(?im)^\s*(?:bad command name|syntax error|expected end of command|'
                              r'failure:|input does not match|not enough permissions|'
                              r'permission denied|unknown command|command not found|'
                              r'Core::Configurator: (?:no such command|invalid))')


def _router_finish(result):
    if not result['interfaces'] or not result['os_version']:
        fail('inventory_output_invalid')
    for name in ('serial', 'model'):
        if not result[name]:
            result['warnings'].append(name + '_unavailable')
    result['capabilities'].update(system=True, interfaces=True,
                                  addresses=any(_address(a.get('address')) for p in result['interfaces'] for a in p['addresses']))
    if not result['capabilities']['neighbors']:
        result['warnings'].append('neighbor_sources_unavailable')
    return _finish(result)


def _peer_ip(value):
    try:
        addr = ipaddress.ip_address(value)
    except (TypeError, ValueError):
        return ''
    effective = getattr(addr, 'ipv4_mapped', None) or addr
    if (getattr(addr, 'scope_id', None) or effective.is_unspecified or effective.is_multicast
            or effective.is_loopback or effective.is_link_local or str(effective) == '255.255.255.255'):
        return ''
    return str(addr)


def _observed_neighbors(result, protocol, rows):
    if rows is None:
        return
    # An empty valid table can expire old data. An unreadable or truncated one cannot.
    seen = {}
    for row in rows:
        ip = _peer_ip(row.get('address', ''))
        mac = _mac(row.get('mac', ''))
        if mac and int(mac[:2], 16) & 1:
            mac = ''
        if not ip and not mac:
            continue
        item = {'protocol': protocol}
        for name, value in (('address', ip), ('mac', mac), ('hostname', row.get('hostname')),
                            ('local_port', row.get('local_port')), ('expires_at', row.get('expires_at'))):
            if value and value != '*':
                item[name] = _string(value, 128)
        if protocol in ('lldp', 'cdp') and row.get('remote_port'):
            item['remote_port'] = _string(row['remote_port'], 128)
        seen[tuple(item.get(k, '') for k in ('address', 'mac', 'local_port', 'remote_port'))] = item
        if len(result['neighbors']) + len(seen) > MAX_NEIGHBORS:
            result['warnings'].append('neighbor_limit_reached')
            return
    result['neighbors'].extend(seen.values())
    result['capabilities']['neighbors'] = True
    result['capabilities']['neighbors_' + protocol] = True


def _kv_lines(value, separator=r':'):
    return {key.strip().lower(): data.strip()
            for key, data in re.findall(r'(?m)^[ \t]*([^:\r\n]+?)[ \t]*' + separator + r'[ \t]*([^\r\n]*)$', value or '')}


def _openwrt_board(value):
    try:
        board = json.loads(value or '')
    except (ValueError, TypeError):
        return None
    release = board.get('release') if isinstance(board, dict) else None
    if isinstance(release, dict) and isinstance(release.get('distribution'), str):
        if release['distribution'].casefold() in ('openwrt', 'friendlywrt'):
            return board
    return None


def _openwrt_ports(value):
    ports, current = [], None
    for line in (value or '').splitlines():
        if head := re.match(r'^\d+:\s+([^\s:]+):\s+<([^>]*)>.*?\bmtu\s+(\d+)\b(.*)$', line):
            current = None
            flags = head[2].split(',')
            if 'LOOPBACK' in flags:
                continue
            name = head[1].split('@', 1)[0]
            current = _interface(name)
            current.update(mtu=_integer(head[3], 65536), enabled='UP' in flags)
            state = _match(r'\bstate\s+(UP|DOWN)\b', head[4])
            if state:
                current['link_up'] = state.upper() == 'UP'
            elif 'LOWER_UP' in flags:
                current['link_up'] = True
            ports.append(current)
        if current is None:
            continue
        if mac := re.match(r'\s+link/ether\s+(\S+)', line):
            current['mac_address'] = _mac(mac[1])
        if addr := re.match(r'\s+inet6?\s+(\S+)', line):
            current['addresses'].append({'address': addr[1], 'vrf': ''})
    return ports


def _ip_neighbors(value):
    rows = []
    for line in value.splitlines():
        if not line.strip():
            continue
        match = re.match(r'^(\S+)\s+dev\s+(\S+)(?:\s+(.*))?$', line)
        if not match:
            return None
        attributes = (match[3] or '').split()
        if 'lladdr' in attributes and not {'FAILED', 'INCOMPLETE', 'NOARP'} & set(attributes):
            at = attributes.index('lladdr') + 1
            if at < len(attributes):
                rows.append({'address': match[1], 'mac': attributes[at], 'local_port': match[2]})
    return rows


def _proc_arp(value):
    lines = value.splitlines()
    if not lines or not lines[0].startswith('IP address'):
        return None
    rows = []
    for line in lines[1:]:
        fields = line.split()
        if not fields:
            continue
        if len(fields) != 6 or not re.fullmatch(r'0x[0-9a-fA-F]+', fields[2]):
            return None
        flags = int(fields[2], 16)
        if flags & 2 and not flags & 8:
            rows.append({'address': fields[0], 'mac': fields[3], 'local_port': fields[5]})
    return rows


def _dnsmasq_leases(value):
    rows = []
    for line in value.splitlines():
        fields = line.split()
        if not fields:
            continue
        if len(fields) != 5 or not re.fullmatch(r'[0-9]{1,12}', fields[0]):
            return None
        timestamp = int(fields[0])
        expires = ''
        if timestamp:
            try:
                expires = datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
            except (ValueError, OverflowError, OSError):
                continue
        rows.append({'address': fields[2], 'mac': fields[1], 'hostname': fields[3], 'expires_at': expires})
    return rows


def _bridge_fdb(value):
    rows = []
    for line in value.splitlines():
        fields = line.split()
        if not fields:
            continue
        if len(fields) < 3 or fields[1] != 'dev' or not _mac(fields[0]):
            return None
        if not {'self', 'permanent', 'static'} & set(fields[3:]):
            rows.append({'mac': fields[0], 'local_port': fields[2]})
    return rows


def _neighbor_table(result, outputs, protocol, command, parser):
    value = outputs.get(command)
    if value is None:
        return
    rows = parser(value)
    if rows is None:
        result['warnings'].append('neighbor_format_unrecognized')
        return
    _observed_neighbors(result, protocol, rows)


def _openwrt_snapshot(board, outputs):
    result = _snapshot('network')
    release = board['release']
    model = board.get('model')
    board_name = board.get('board_name')
    brand = board_name.split(',')[0].lower() if isinstance(board_name, str) and ',' in board_name else ''
    manufacturers = {'friendlyarm': 'FriendlyElec', 'friendlyelec': 'FriendlyElec',
                     'tplink': 'TP-Link', 'glinet': 'GL.iNet', 'mikrotik': 'MikroTik'}
    result.update(
        manufacturer=manufacturers.get(brand, brand),
        model=_string(model) if isinstance(model, str) else '',
        hostname=_string(board.get('hostname')) if isinstance(board.get('hostname'), str) else '',
        os_name=_string(release['distribution']),
        os_version=_string(release.get('version')) if isinstance(release.get('version'), str) else '',
        serial=_string(board.get('serial')) if isinstance(board.get('serial'), str) else '',
        interfaces=_openwrt_ports(outputs.get(OPENWRT_PORTS)),
    )
    arp_source, arp_parser = ((OPENWRT_ARP_FALLBACK, _proc_arp)
                              if outputs.get(OPENWRT_ARP) is None else (OPENWRT_ARP, _ip_neighbors))
    _neighbor_table(result, outputs, 'arp', arp_source, arp_parser)
    _neighbor_table(result, outputs, 'ndp', OPENWRT_NDP, _ip_neighbors)
    _neighbor_table(result, outputs, 'dhcp', OPENWRT_DHCP, _dnsmasq_leases)
    _neighbor_table(result, outputs, 'fdb', OPENWRT_FDB, _bridge_fdb)
    return _router_finish(result)


ROS_FIELD = re.compile(r'(?:^|[ \t])([A-Za-z][A-Za-z0-9-]*)=(?:"((?:[^"\\]|\\.)*)"|(\S*))')


def _ros_rows(value):
    records, record = [], None
    for line in value.splitlines():
        line = line.strip()
        if not line or line.startswith(('Flags:', 'Columns:', ';;;', '#')):
            continue
        if row := re.match(r'^\d+\s+(.*)$', line):
            record = row[1]
            records.append(record)
        elif record is not None and ROS_FIELD.search(line):
            record += ' ' + line
            records[-1] = record
        else:
            return None
    rows = []
    for record in records:
        fields = list(ROS_FIELD.finditer(record))
        if not fields:
            return None
        flags = record[:fields[0].start()].strip().replace(' ', '')
        values = {key: (re.sub(r'\\(["\\])', r'\1', quoted) if quoted is not None else plain)
                  for key, quoted, plain in (item.groups() for item in fields)}
        rows.append((flags, values))
    return rows


def _ros_yes(value):
    return {'yes': True, 'true': True, 'no': False, 'false': False}.get(value)


def _lease_expiry(value, observed_at):
    if not value:
        return ''
    seconds = 0
    if re.fullmatch(r'\d{1,6}(?::\d{2}){2}', value):
        h, m, s = map(int, value.split(':'))
        seconds = 3600 * h + 60 * m + s
    elif re.fullmatch(r'(?:\d{1,7}[wdhms])+', value):
        units = {'w': 604800, 'd': 86400, 'h': 3600, 'm': 60, 's': 1}
        seconds = sum(int(n) * units[unit] for n, unit in re.findall(r'(\d+)([wdhms])', value))
    elif re.fullmatch(r'\d{1,9}', value):
        seconds = int(value)
    if not 0 < seconds <= 366 * 86400:
        return ''
    return (datetime.fromisoformat(observed_at.replace('Z', '+00:00')) + timedelta(seconds=seconds)).isoformat()


def _ros_neighbors(result, outputs, protocol, command):
    value = outputs.get(command)
    if value is None:
        return
    rows = _ros_rows(value)
    if rows is None:
        result['warnings'].append('neighbor_format_unrecognized')
        return
    observations = []
    for flags, row in rows:
        if 'X' in flags or 'I' in flags or _ros_yes(row.get('disabled')) is True:
            continue
        if protocol == 'dhcp':
            if row.get('status') != 'bound':
                continue
            observations.append({'address': row.get('active-address', row.get('address', '')),
                                 'mac': row.get('active-mac-address', row.get('mac-address', '')),
                                 'hostname': row.get('host-name', ''),
                                 'expires_at': _lease_expiry(row.get('expires-after'), result['observed_at'])})
        elif protocol == 'fdb':
            if 'L' not in flags and _ros_yes(row.get('local')) is not True and ('D' in flags or _ros_yes(row.get('dynamic')) is True):
                observations.append({'mac': row.get('mac-address', ''), 'local_port': row.get('on-interface') or row.get('interface')})
        elif protocol in ('lldp', 'cdp'):
            methods = re.findall(r'\b(?:lldp|cdp|mndp)\b', row.get('discovered-by', '').lower())
            if protocol in methods:
                observations.append({'address': row.get('address') or row.get('address6', ''),
                                     'mac': row.get('mac-address', ''), 'hostname': row.get('identity', ''),
                                     'local_port': row.get('interface'),
                                     'remote_port': row.get('interface-name') if protocol == 'cdp' else None})
        elif row.get('status', '').lower() not in ('failed', 'incomplete') and row.get('mac-address'):
            observations.append({'address': row.get('address', ''), 'mac': row['mac-address'], 'local_port': row.get('interface')})
    # Older RouterOS cannot distinguish MNDP from LLDP/CDP on nonempty tables.
    if protocol in ('lldp', 'cdp') and any(not row.get('discovered-by') for _, row in rows):
        result['warnings'].append('neighbor_format_unrecognized')
        return
    _observed_neighbors(result, protocol, observations)


def _routeros_snapshot(outputs):
    result = _snapshot('network')
    system = _kv_lines(outputs.get(ROS_SYSTEM))
    if system.get('platform', '').lower() != 'mikrotik':
        fail('inventory_driver_unsupported')
    board = _kv_lines(outputs.get(ROS_BOARD))
    identity = _kv_lines(outputs.get(ROS_IDENTITY))
    result.update(manufacturer='MikroTik', os_name='RouterOS', os_version=_string(system.get('version')),
                  hostname=_string(identity.get('name')),
                  model=_string(board.get('model') or system.get('board-name')),
                  serial=_string(board.get('serial-number')))
    ports = {}
    for flags, row in _ros_rows(outputs.get(ROS_INTERFACES) or '') or []:
        name = row.get('name')
        if not name or row.get('type') == 'loopback':
            continue
        port = _interface(name)
        kind = row.get('type', '')
        port.update(mac_address=_mac(row.get('mac-address', '')),
                    mtu=_integer(row.get('actual-mtu') or row.get('mtu'), 65536),
                    enabled='X' not in flags if 'disabled' not in row else not _ros_yes(row['disabled']),
                    link_up=_ros_yes(row.get('running')) if 'running' in row else 'R' in flags,
                    type=('physical' if kind in ('ether', 'wlan', 'wifi') else
                          'lag' if kind == 'bonding' else
                          'virtual' if kind in ('bridge', 'vlan', 'wireguard', 'vrrp', 'eoip', 'vxlan') else 'unknown'))
        ports[name] = port
    for command in (ROS_IP, ROS_IPV6):
        raw = outputs.get(command)
        if raw is None:
            continue
        addresses = _ros_rows(raw)
        if addresses is None:
            result['warnings'].append('optional_format_unrecognized')
            continue
        for flags, row in addresses:
            port = ports.get(row.get('interface'))
            if port and 'X' not in flags and 'I' not in flags and row.get('address'):
                port['addresses'].append({'address': row['address'], 'vrf': ''})
    result['interfaces'] = list(ports.values())
    for protocol, command in (('arp', ROS_ARP), ('ndp', ROS_NDP), ('dhcp', ROS_DHCP), ('fdb', ROS_FDB),
                              ('lldp', ROS_NEIGHBOR), ('cdp', ROS_NEIGHBOR)):
        _ros_neighbors(result, outputs, protocol, command)
    return _router_finish(result)


def _mask_address(address, mask):
    if not address:
        return None
    if '/' in address:
        candidate = _address(address)
    elif mask:
        candidate = _address(f"{address}/{mask.lstrip('/')}")
    else:
        candidate = None
    if candidate and not ipaddress.ip_interface(candidate).ip.is_unspecified:
        return candidate
    return None


def _keenetic_identity(value):
    fields = _kv_lines(value)
    marker = ' '.join(fields.get(name, '') for name in ('vendor', 'manufacturer', 'series', 'device', 'title', 'model'))
    if re.search(r'\bkeenetic\b|\bkeeneticos\b', marker, re.I) and fields.get('release'):
        return fields
    return None


def _keenetic_ports(value):
    result = {}
    chunks = re.split(r'(?mi)(?=^[ \t]*id:[ \t]*\S+)', value)
    has_ids = len(chunks) > 1
    if not has_ids:
        chunks = re.split(r'(?mi)(?=^[ \t]*interface,[ \t]*name[ \t]*=)', value)
    for chunk in chunks:
        fields = _kv_lines(chunk)
        name = (fields.get('id') if has_ids else
                _match(r'^[ \t]*interface,\s*name\s*=\s*"?([^":\r\n]+)"?:\s*$', chunk))
        if not name:
            continue
        kind = fields.get('type', '').lower()
        if kind == 'loopback':
            continue
        port = _interface(name)
        port.update(description=_string(fields.get('description')), mac_address=_mac(fields.get('mac', '')),
                    mtu=_integer(fields.get('mtu'), 65536), speed_mbps=_integer((fields.get('speed') or '').rstrip('mM'), 2147483),
                    enabled={'up': True, 'down': False}.get(fields.get('state')),
                    link_up={'up': True, 'down': False}.get(fields.get('link')),
                    type=('physical' if kind in ('port', 'ethernet', 'fastethernet', 'gigabitethernet') else
                          'virtual' if kind in ('vlan', 'bridge', 'wireguard', 'pppoe', 'tunnel') else 'unknown'))
        if address := _mask_address(fields.get('address'), fields.get('mask')):
            port['addresses'].append({'address': address, 'vrf': ''})
        result[name] = port
    return list(result.values())


def _keenetic_arp(value):
    rows = []
    for line in value.splitlines():
        fields = line.strip().split(maxsplit=2)
        if not fields or re.fullmatch(r'[=-]+', fields[0]) or fields[0].lower() == 'ip':
            continue
        if len(fields) != 3 or not _peer_ip(fields[0]):
            return None
        rows.append({'address': fields[0], 'mac': fields[1], 'local_port': fields[2]})
    return rows


def _keenetic_leases(value, observed_at):
    chunks = re.split(r'(?mi)^[ \t]*lease[ \t]*:[ \t]*$', value)
    if len(chunks) < 2:
        return [] if not value.strip() else None
    rows = []
    for chunk in chunks[1:]:
        fields = _kv_lines(chunk)
        if not fields.get('ip'):
            return None
        rows.append({'address': fields['ip'], 'mac': fields.get('mac', ''), 'hostname': fields.get('hostname'),
                     'expires_at': _lease_expiry(fields.get('expires'), observed_at)})
    return rows


def _keenetic_snapshot(outputs):
    version = _keenetic_identity(outputs.get(KEENETIC_VERSION))
    if version is None:
        fail('inventory_driver_unsupported')
    result = _snapshot('network')
    result.update(manufacturer='Keenetic', os_name='KeeneticOS', os_version=_string(version['release']),
                  model=_string(version.get('model') or version.get('device')),
                  hostname=_string(version.get('hostname') or version.get('host-name')),
                  serial=_string(version.get('serial') or version.get('serial-number')),
                  interfaces=_keenetic_ports(outputs.get(KEENETIC_PORTS, '')))
    _neighbor_table(result, outputs, 'arp', KEENETIC_ARP, _keenetic_arp)
    _neighbor_table(result, outputs, 'dhcp', KEENETIC_DHCP,
                    lambda value: _keenetic_leases(value, result['observed_at']))
    return _router_finish(result)


def _tplink_identity(value):
    fields = _kv_lines(value, r'[ \t]+-[ \t]+')
    fields.update(_kv_lines(value))
    marker = ' '.join(fields.get(name, '') for name in ('system description', 'bootloader version', 'device description'))
    if re.search(r'\b(?:jetstream|tp-link|tp link|omada)\b', marker, re.I) and fields.get('hardware version'):
        return fields
    return None


def _tplink_ports(value):
    result = []
    for line in value.splitlines():
        row = re.match(r'^\s*([A-Za-z]+[0-9]+(?:/[0-9]+){1,2})\s+'
                       r'(LinkUp|LinkDown|Up|Down|Disabled?)\s+(\S+)', line, re.I)
        if not row:
            continue
        port = _interface(row[1])
        status = row[2].lower()
        speed = re.fullmatch(r'(\d{1,4}(?:\.\d{1,3})?)([mMgG])', row[3])
        port.update(type='physical', link_up=status in ('linkup', 'up'))
        if status.startswith('disabl'):
            port['enabled'] = False
        if speed:
            port['speed_mbps'] = _integer(int(float(speed[1]) * (1000 if speed[2].lower() == 'g' else 1)), 2147483)
        result.append(port)
    return result


def _tplink_fdb(value):
    rows = []
    recognized = not value.strip()
    for line in value.splitlines():
        if re.search(r'\b(?:MAC|Destination)\s+Address\b|\btotal\s+(?:entries|addresses)\b', line, re.I):
            recognized = True
        fields = line.split()
        if not fields:
            continue
        mac = next((word for word in fields if _mac(word)), None)
        if not mac:
            continue
        recognized = True
        if 'dynamic' in (word.lower() for word in fields):
            port = next((word for word in fields if re.fullmatch(r'[A-Za-z]*\d+(?:/\d+){1,2}', word)), None)
            if not port:
                return None
            rows.append({'mac': mac, 'local_port': port})
    return rows if recognized else None


def _tplink_snapshot(outputs):
    system = _tplink_identity(outputs.get(TPLINK_SYSTEM))
    if system is None:
        fail('inventory_driver_unsupported')
    result = _snapshot('network')
    result.update(manufacturer='TP-Link', os_name='Omada' if 'omada' in system.get('system description', '').lower() else 'JetStream',
                  os_version=_string(system.get('software version') or system.get('firmware version')),
                  model=_string(system.get('hardware version')), hostname=_string(system.get('system name') or system.get('device name')),
                  serial=_string(system.get('serial number')), interfaces=_tplink_ports(outputs.get(TPLINK_PORTS, '')))
    ports = {port['name'].lower(): port for port in result['interfaces']}
    for line in (outputs.get(TPLINK_IP_BRIEF) or '').splitlines():
        row = re.match(r'^\s*(\S+)\s+(\S+)\s+\S+\s+(Up|Down)\s+(Up|Down)\s+(yes|no)\s*$', line, re.I)
        if not row or not (address := _mask_address(row[2], '')):
            continue
        key = row[1].lower()
        port = ports.get(key)
        if port is None:
            if not re.fullmatch(r'vlan\d{1,4}', key):
                continue
            port = ports[key] = _interface(row[1])
            port['type'] = 'virtual'
            result['interfaces'].append(port)
        port.update(enabled=row[5].lower() == 'no', link_up=row[4].lower() == 'up')
        port['addresses'].append({'address': address, 'vrf': ''})
    management = _kv_lines(outputs.get(TPLINK_IP), r'[ \t]+-[ \t]+')
    management.update(_kv_lines(outputs.get(TPLINK_IP)))
    vlan = _integer(management.get('management vlan') or management.get('vlan id'), 4094)
    address = _mask_address(management.get('ip address'), management.get('subnet mask'))
    if vlan and address:
        port = ports.get(f'vlan{vlan}')
        if port is None:
            port = _interface(f'Vlan{vlan}')
            port['type'] = 'virtual'
            result['interfaces'].append(port)
        if mac := _mac(management.get('mac address', '')):
            port['mac_address'] = mac
        port['addresses'].append({'address': address, 'vrf': ''})
    _neighbor_table(result, outputs, 'fdb', TPLINK_FDB, _tplink_fdb)
    return _router_finish(result)


def _optional_exec(client, command, budget, *, seconds=3):
    now = time.monotonic()
    # Preserve time to return the mandatory facts when optional tables stall.
    until = min(now + seconds, budget.deadline - 0.25)
    if until <= now:
        return None
    try:
        value = _exec(client, command, budget, until=until)
    except (socket.timeout, EOFError):
        return None
    except InventoryCollectionError as error:
        if error.code == 'inventory_command_failed':
            return None
        raise
    except Exception as error:
        # A server can refuse exec while its interactive shell is supported.
        import paramiko
        if isinstance(error, paramiko.SSHException):
            return None
        raise
    return None if CLI_ERROR.search(value) or VENDOR_CLI_ERROR.search(value) else value


def _openwrt_collect(client, board, budget):
    outputs = {OPENWRT_PORTS: _exec(client, OPENWRT_PORTS, budget)}
    for command in (OPENWRT_ARP, OPENWRT_NDP, OPENWRT_DHCP, OPENWRT_FDB):
        outputs[command] = _optional_exec(client, command, budget)
    if outputs[OPENWRT_ARP] is None:
        outputs[OPENWRT_ARP_FALLBACK] = _optional_exec(client, OPENWRT_ARP_FALLBACK, budget)
    return _openwrt_snapshot(board, outputs)


def _routeros_collect(client, system, budget):
    outputs = {ROS_SYSTEM: system, ROS_INTERFACES: _exec(client, ROS_INTERFACES, budget)}
    for command in (ROS_IDENTITY, ROS_BOARD, ROS_IP, ROS_IPV6, ROS_ARP, ROS_NDP, ROS_DHCP, ROS_NEIGHBOR, ROS_FDB):
        outputs[command] = _optional_exec(client, command, budget)
    return _routeros_snapshot(outputs)


def _appliance_shell(client, profile, budget):
    driver = profile['driver']
    channel = client.invoke_shell(width=200, height=100)
    try:
        _, prompt = _shell_read(channel, budget, until=time.monotonic() + budget.remaining(4))
        outputs = {}

        def run(command, *, optional=False):
            channel.sendall(command + '\n')
            body, _ = _shell_read(channel, budget, prompt, paging=driver in ('auto', 'tplink_jetstream'),
                                  until=time.monotonic() + budget.remaining(4 if optional else 12))
            lines = body.strip('\n').splitlines()
            if lines and lines[0].strip() == command:
                lines.pop(0)
            value = '\n'.join(lines)
            if CLI_ERROR.search(value) or VENDOR_CLI_ERROR.search(value):
                if not optional:
                    fail('inventory_command_failed')
                return None
            outputs[command] = value
            return value

        if driver == 'auto':
            if prompt.startswith('<'):
                version = run('display version', optional=True) or ''
                if re.search(r'Versatile Routing Platform|\bVRP\b.*Version', version, re.I):
                    return 'huawei_vrp', None
            else:
                version = run(KEENETIC_VERSION, optional=True) or ''
                if _keenetic_identity(version):
                    driver = 'keenetic'
                elif re.search(r'\bCisco\s+IOS(?:[\s-]|$)', version, re.I):
                    return 'cisco_ios', None
                elif re.search(r'(?mi)^\s*(?:Junos|JUNOS Software Release)\s*[:\[]', version):
                    return 'junos', None
                elif _tplink_identity(run(TPLINK_SYSTEM, optional=True)):
                    driver = 'tplink_jetstream'
            if driver == 'auto':
                fail('inventory_driver_unsupported')

        if driver == 'tplink_jetstream' and prompt.endswith('>'):
            channel.sendall('enable\n')
            _, elevated = _shell_read(channel, budget, password=True)
            if elevated is None:
                if not profile.get('enable_password'):
                    fail('inventory_auth_failed')
                channel.sendall(profile['enable_password'] + '\n')
                _, elevated = _shell_read(channel, budget, password=True)
            if elevated is None or not elevated.endswith('#'):
                fail('inventory_auth_failed')
            prompt = elevated

        if driver == 'keenetic':
            required, optional = (KEENETIC_VERSION, KEENETIC_PORTS), (KEENETIC_ARP, KEENETIC_DHCP)
        else:
            required, optional = (TPLINK_SYSTEM, TPLINK_PORTS), (TPLINK_IP_BRIEF, TPLINK_IP, TPLINK_FDB)
        for command in required:
            if command not in outputs and not run(command):
                fail('inventory_command_failed')
        for command in optional:
            try:
                run(command, optional=True)
            except (OSError, EOFError):
                break  # Lost prompt: do not send another command into the stream.
            except InventoryCollectionError as error:
                if error.code not in ('inventory_timeout', 'inventory_command_failed'):
                    raise
                break
        return driver, outputs
    finally:
        channel.close()


def _collect_network(client, profile, budget):
    driver = profile['driver']
    if driver in ('openwrt', 'auto'):
        board = _openwrt_board(_optional_exec(client, OPENWRT_BOARD, budget))
        if board is not None:
            return _openwrt_collect(client, board, budget)
        if driver == 'openwrt':
            fail('inventory_driver_unsupported')
    if driver in ('mikrotik_routeros', 'auto'):
        system = _optional_exec(client, ROS_SYSTEM, budget)
        if _kv_lines(system).get('platform', '').lower() == 'mikrotik':
            return _routeros_collect(client, system, budget)
        if driver == 'mikrotik_routeros':
            fail('inventory_driver_unsupported')
    if driver in ('keenetic', 'tplink_jetstream', 'auto'):
        driver, outputs = _appliance_shell(client, profile, budget)
        if driver == 'keenetic':
            return _keenetic_snapshot(outputs)
        if driver == 'tplink_jetstream':
            return _tplink_snapshot(outputs)
    outputs, prompt = _network_raw(client, {**profile, 'driver': driver}, budget)
    return parse_network(driver, outputs, prompt)


WINDOWS_SCRIPT = r'''$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$cs=Get-CimInstance -OperationTimeoutSec 5 -ClassName Win32_ComputerSystem
$os=Get-CimInstance -OperationTimeoutSec 5 -ClassName Win32_OperatingSystem
$bios=Get-CimInstance -OperationTimeoutSec 5 -ClassName Win32_BIOS
$disks=@(Get-CimInstance -OperationTimeoutSec 5 -ClassName Win32_DiskDrive | Select-Object -First 129 | ForEach-Object { @{name=[string]$_.DeviceID;size_bytes=$_.Size} })
$adapters=@(Get-CimInstance -OperationTimeoutSec 5 -ClassName Win32_NetworkAdapter | Select-Object -First 1025)
$configs=@{};Get-CimInstance -OperationTimeoutSec 5 -ClassName Win32_NetworkAdapterConfiguration | ForEach-Object { $configs[[int]$_.Index]=$_ }
$interfaces=@($adapters | ForEach-Object {
 $a=$_;$c=$configs[[int]$a.Index];$addresses=@()
 if($c -and $c.IPAddress){for($i=0;$i -lt $c.IPAddress.Count;$i++){if($i -lt $c.IPSubnet.Count){$addresses+=@{address=[string]$c.IPAddress[$i];prefix=[string]$c.IPSubnet[$i]}}}}
 @{key=$(if($a.GUID){[string]$a.GUID}else{[string]$a.Index});name=$(if($a.NetConnectionID){[string]$a.NetConnectionID}else{[string]$a.Name});description=[string]$a.Description;mac_address=[string]$a.MACAddress;mtu=$(if($c){$c.MTU}else{$null});speed_mbps=$(if($a.Speed){[long]([double]$a.Speed/1000000)}else{$null});enabled=$a.NetEnabled;link_up=($a.NetConnectionStatus -eq 2);type=$(if($a.PhysicalAdapter){'physical'}else{'unknown'});addresses=$addresses}
})
$virtual='unknown'
if(($cs.Manufacturer -match '^VMware') -or ($cs.Manufacturer -eq 'Microsoft Corporation' -and $cs.Model -eq 'Virtual Machine') -or ($cs.Manufacturer -eq 'QEMU')){$virtual='vm'}
$out=@{hostname=[string]$cs.Name;manufacturer=[string]$cs.Manufacturer;model=[string]$cs.Model;serial=[string]$bios.SerialNumber;os_name=[string]$os.Caption;os_version=[string]$os.Version;virtualization=$virtual;cpu_count=$cs.NumberOfLogicalProcessors;memory_mib=$(if($cs.TotalPhysicalMemory){[long]([double]$cs.TotalPhysicalMemory/1048576)}else{$null});disks=$disks;interfaces=$interfaces;warnings=@();capabilities=@{interfaces=$true;addresses=$true;disks=$true}}
$json=$out | ConvertTo-Json -Depth 8 -Compress
if([System.Text.Encoding]::UTF8.GetByteCount($json) -gt 2097152){throw 'inventory_limit'}
[Console]::Write($json)
'''


def _windows(address, profile, budget):
    try:
        from winrm.protocol import Protocol
        from winrm.exceptions import WinRMOperationTimeoutError, InvalidCredentialsError
    except ImportError: fail('inventory_dependency_missing')
    endpoint = profile['scheme'] + '://' + ('[' + address + ']' if ':' in address else address) + ':' + str(profile['port']) + '/wsman'
    with tempfile.TemporaryDirectory(prefix='pl-inventory-ca-') as folder:
        ca_path = None
        if profile['ca_pem']:
            ca_path = Path(folder, 'ca.pem'); ca_path.write_text(profile['ca_pem']); ca_path.chmod(0o600)
        duration = budget.remaining(10)
        protocol = Protocol(endpoint=endpoint, transport='ntlm', username=profile['username'], password=profile['password'],
            server_cert_validation='validate', ca_trust_path=str(ca_path) if ca_path else None, proxy=None,
            message_encryption='always', read_timeout_sec=max(2, int(duration)), operation_timeout_sec=max(1, int(duration) - 1))
        # build_session otherwise immediately performs NTLM negotiation before
        # callers can replace its HTTP adapters. Defer only that instance call.
        setup = protocol.transport.setup_encryption
        protocol.transport.setup_encryption = lambda session: None
        session = protocol.transport.build_session(); session.trust_env = False; session.proxies = {}
        protocol.transport.setup_encryption = setup
        import requests
        class FiniteHTTP(requests.adapters.HTTPAdapter):
            def send(self, request, **kwargs):
                kwargs.update(stream=True, timeout=(budget.remaining(10), budget.remaining(10)))
                response = super().send(request, **kwargs)
                if response.status_code in (401, 407):
                    # requests-ntlm obtains TLS channel bindings from the live
                    # urllib3 socket BEFORE it consumes the challenge body.
                    # Preserve that object/connection for its response hook.
                    # Bound later body reads without replacing response.raw.
                    original_read = response.raw.read
                    received = 0
                    def read(amt=None, *args, **options):
                        nonlocal received
                        budget.remaining()
                        if amt is None or amt < 0: amt = MAX_OUTPUT * 2 + 1
                        chunk = original_read(min(amt, MAX_OUTPUT * 2 + 1), *args, **options)
                        received += len(chunk)
                        if received > MAX_OUTPUT * 2:
                            response.close(); fail('inventory_output_limit')
                        return chunk
                    response.raw.read = read
                    return response
                try:
                    if 300 <= response.status_code < 400: fail('inventory_connection_failed')
                    chunks, size = [], 0
                    for chunk in response.iter_content(65536):
                        budget.remaining(); size += len(chunk)
                        if size > MAX_OUTPUT * 2: fail('inventory_output_limit')
                        chunks.append(chunk)
                    response._content = b''.join(chunks)
                    response._content_consumed = True
                    return response
                finally: response.close()
        for old in session.adapters.values(): old.close()
        session.mount('http://', FiniteHTTP()); session.mount('https://', FiniteHTTP())
        original_send = session.send
        def send(request, **kwargs):
            kwargs['allow_redirects'] = False
            return original_send(request, **kwargs)
        session.send = send
        shell, command = None, None
        try:
            setup(session)
            shell = protocol.open_shell()
            encoded = base64.b64encode(WINDOWS_SCRIPT.encode('utf-16le')).decode()
            command = protocol.run_command(shell, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])
            stdout, stderr, status = bytearray(), bytearray(), None
            while True:
                budget.remaining()
                try: out, err, status, done = protocol.get_command_output_raw(shell, command)
                except WinRMOperationTimeoutError: continue
                budget.add(out); budget.add(err); stdout.extend(out); stderr.extend(err)
                if done: break
            if status != 0: fail('inventory_command_failed')
            return _host_snapshot('windows', bytes(stdout).decode('utf-8-sig'))
        except requests.exceptions.SSLError:
            fail('inventory_tls_failed')
        except requests.exceptions.Timeout:
            fail('inventory_timeout')
        except InvalidCredentialsError:
            fail('inventory_auth_failed')
        finally:
            # Cleanup must remain finite even when the caller's budget expired.
            if command and shell:
                try: protocol.cleanup_command(shell, command)
                except Exception: pass
            if shell:
                try: protocol.close_shell(shell)
                except Exception: pass
            session.close()


def _collect_impl(target, profile, *, deadline=None):
    try:
        profile = validate_profile(profile)
        address = _target(target, profile['kind'])
        budget = Budget(deadline)
        budget.remaining()
        if profile['kind'] == 'windows': return _windows(address, profile, budget)
        with _ssh(address, profile, budget) as client:
            if profile['kind'] == 'linux': return _host_snapshot('linux', _exec(client, LINUX_COMMAND, budget))
            return _collect_network(client, profile, budget)
    except InventoryCollectionError:
        raise
    except (socket.timeout, TimeoutError): fail('inventory_timeout')
    except ssl.SSLError: fail('inventory_tls_failed')
    except ImportError: fail('inventory_dependency_missing')
    except Exception:
        # Never include raw SSH/WinRM errors, stdout or private profile fields.
        fail('inventory_connection_failed')


def collect(target, profile, *, deadline=None):
    """One finite process contains dependency threads and all remote IO.

    Credentials are passed through a pipe, never argv/environment. Killing a
    timed-out process also closes its SSH/WinRM sockets; no local worker remains.
    """
    profile = validate_profile(profile)
    ip = _target(target, profile['kind'])
    if profile['kind'] != 'windows' and not ssh_host_pins(profile['ssh_known_hosts'], host_key_name(ip, profile['port'])):
        fail('inventory_host_key_failed')
    budget = Budget(deadline)
    budget.remaining()
    request = json.dumps({'target': target, 'profile': profile, 'deadline': budget.deadline}).encode()
    try:
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--worker'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            close_fds=True, start_new_session=True)
    except OSError:
        fail('inventory_dependency_missing')
    try:
        try: output, _ = child.communicate(request, timeout=budget.remaining(MAX_DURATION))
        except subprocess.TimeoutExpired:
            child.kill(); child.communicate()
            fail('inventory_timeout')
        if child.returncode != 0 or len(output) > MAX_SNAPSHOT: fail('inventory_output_invalid')
        try: value = json.loads(output)
        except (ValueError, TypeError): fail('inventory_output_invalid')
        if isinstance(value, dict) and set(value) == {'error'}: fail(value['error'])
        if not isinstance(value, dict) or value.get('schema') != 1 or value.get('kind') != profile['kind']:
            fail('inventory_output_invalid')
        return value
    finally:
        if child.poll() is None:
            child.kill(); child.communicate()


if __name__ == '__main__':
    if sys.argv[1:] != ['--worker']:
        raise SystemExit(2)
    try:
        raw = sys.stdin.buffer.read(512 * 1024 + 1)
        if len(raw) > 512 * 1024: fail('inventory_profile_invalid')
        request = json.loads(raw)
        result = _collect_impl(request['target'], request['profile'], deadline=request['deadline'])
    except InventoryCollectionError as error:
        result = {'error': error.code}
    except Exception:
        result = {'error': 'inventory_output_invalid'}
    sys.stdout.write(json.dumps(result, separators=(',', ':')))
