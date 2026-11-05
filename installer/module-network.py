"""Per-installation module IPAM; callers hold modules/controller.lock."""
import ipaddress
import json
from pathlib import Path
import re
import subprocess

MODULES = {'forms', 'doska', 'wayline', 'grafana', 'sftpgo', 'netmap', 'bookstack', 'inventory'}
ROLES = {'forms': ('mongo', 'keydb', 'engine', 'adapter', 'engine-bootstrap'),
         'doska': ('database', 'api', 'web'), 'wayline': ('runner', 'api', 'gateway'),
         'netmap': ('database', 'cache', 'netbox', 'netbox-worker', 'oxidized', 'gitea', 'adapter'),
         'bookstack': ('database', 'web'), 'inventory': ('server',)}
PRIVATE = tuple(ipaddress.IPv4Network(v) for v in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))


class PoolExhausted(ValueError):
    public_code = 'module_network_pool_exhausted'


def extra_pool(value):
    net = ipaddress.IPv4Network(value, strict=True)
    if str(net) != value or not 16 <= net.prefixlen <= 26 or not any(net.subnet_of(p) for p in PRIVATE):
        raise ValueError('Module network CIDR must be canonical RFC1918 /16 through /26')
    return net


def pools(config):
    result = []
    if config.get('network_cidr'):
        core = ipaddress.IPv4Network(config['network_cidr'], strict=True)
        if core.prefixlen != 24 or not any(core.subnet_of(p) for p in PRIVATE):
            raise ValueError('Invalid core network CIDR')
        result.append(list(core.subnets(new_prefix=26))[3])
    if config.get('module_network_cidr'):
        additional = extra_pool(config['module_network_cidr'])
        if config.get('network_cidr') and additional.overlaps(ipaddress.IPv4Network(config['network_cidr'])):
            raise ValueError('Module network CIDR overlaps core network CIDR')
        result.append(additional)
    return result


def owned_network(obj, installation, available, inspect_container, *, prometheus=''):
    labels = obj.get('Labels') or {}
    module, instance = labels.get('pl.module'), labels.get('pl.instance', '')
    if labels.get('pl.installation') != installation or module not in MODULES:
        return None
    if not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', instance):
        return None
    if prometheus and (module != 'grafana' or not isinstance(prometheus, str)
                       or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', prometheus)):
        return None
    prefix = installation + '-' + module + '-' + instance
    configs = obj.get('IPAM', {}).get('Config') or []
    try:
        subnet = ipaddress.IPv4Network(configs[0]['Subnet'], strict=True)
    except (ValueError, IndexError, KeyError, TypeError):
        return None
    if (not re.fullmatch(r'[0-9a-f]{64}', obj.get('Id', '')) or obj.get('Name') != prefix + '-net' or obj.get('Driver') != 'bridge' or obj.get('Scope') != 'local'
            or obj.get('Ingress') or obj.get('Internal', False) != (module in ('forms', 'inventory')) or obj.get('Options')
            or obj.get('IPAM', {}).get('Driver') != 'default' or obj.get('IPAM', {}).get('Options') or len(configs) != 1
            or configs[0].get('Gateway') != str(subnet.network_address + 1)
            or configs[0].get('IPRange') or configs[0].get('AuxiliaryAddresses')
            or subnet.prefixlen != (28 if module == 'netmap' else 29) or not any(subnet.subnet_of(p) for p in available)
            or labels.get('pl.module.network.version') != '1' or labels.get('pl.module.network.subnet') != str(subnet)):
        return None
    allowed_names = {prefix + '-' + role for role in ROLES[module]} if module in ROLES else {prefix}
    prometheus_name = installation + '-prometheus-' + prometheus if prometheus else ''
    if prometheus_name:
        allowed_names.add(prometheus_name)
    for identity, member in (obj.get('Containers') or {}).items():
        container = inspect_container(identity)
        cl = container.get('Config', {}).get('Labels') or {}
        selected_prometheus = member.get('Name') == prometheus_name
        expected_labels = ({'pl.installation': installation, 'pl.module': 'prometheus', 'pl.instance': prometheus}
                           if selected_prometheus else {key: labels.get(key) for key in ('pl.installation', 'pl.module', 'pl.instance')})
        if (container.get('Id') != identity or container.get('Name', '').lstrip('/') != member.get('Name')
                or member.get('Name') not in allowed_names
                or any(cl.get(k) != value for k, value in expected_labels.items())
                or module in ROLES and cl.get('pl.module.role') != member.get('Name')[len(prefix) + 1:]):
            return None
    return subnet


def allocation_args(root, installation, docker, *, prefixlen=29):
    if prefixlen not in (28, 29):
        raise ValueError('Unsupported module network size')
    root = Path(root)
    statepath = root / 'state/installation.json'
    if statepath.is_symlink():
        raise ValueError('Unsafe installation network configuration')
    available = pools(json.loads(statepath.read_bytes()).get('config', {}))
    # Legacy installations without explicit IPAM retain their existing contract.
    if not available:
        return []
    identities = docker('network', 'ls', '--quiet', '--no-trunc').decode().split()
    if len(identities) > 4096 or any(not re.fullmatch(r'[0-9a-f]{64}', v) for v in identities):
        raise ValueError('Invalid Docker network inventory')
    occupied = []
    for identity in identities:
        obj = json.loads(docker('network', 'inspect', identity))[0]
        if obj.get('Id') != identity:
            raise ValueError('Docker network inventory changed')
        occupied.extend(ipaddress.ip_network(v['Subnet'], strict=True) for v in (obj.get('IPAM', {}).get('Config') or []) if v.get('Subnet'))
    result = subprocess.run(['ip', '-j', '-4', 'route', 'show', 'table', 'all'], cwd=root, capture_output=True, timeout=30)
    if result.returncode:
        raise ValueError('Module network route preflight failed')
    routes = json.loads(result.stdout)
    if not isinstance(routes, list):
        raise ValueError('Invalid module network route inventory')
    for route in routes:
        if route.get('dst') == 'default':
            continue
        net = ipaddress.IPv4Network(route['dst'], strict=False)
        if net.prefixlen:
            occupied.append(net)
    for pool in available:
        for subnet in pool.subnets(new_prefix=prefixlen):
            if not any(net.version == 4 and subnet.overlaps(net) for net in occupied):
                return ['--subnet', str(subnet), '--gateway', str(subnet.network_address + 1), '--label', 'pl.module.network.version=1', '--label', 'pl.module.network.subnet=' + str(subnet)]
    raise PoolExhausted('Module network pool exhausted; configure an additional module network CIDR')


def validate_existing(root, installation, obj, docker, *, prometheus=''):
    labels = obj.get('Labels') or {}
    if not {'pl.module.network.version', 'pl.module.network.subnet'} & labels.keys():
        return  # Legacy subnet stays under the controller's existing ownership guard.
    config = json.loads((Path(root) / 'state/installation.json').read_bytes()).get('config', {})
    if owned_network(obj, installation, pools(config), lambda identity: json.loads(docker('container', 'inspect', identity))[0],
                     prometheus=prometheus) is None:
        raise ValueError('Managed module network IPAM or ownership drift')
