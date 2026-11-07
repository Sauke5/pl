"""Project bounded inventory observations onto the portable map.

These are reports by the polled device. They never create NetBox objects or
authorize physical links, and an IP address alone never identifies a device.
"""
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import hashlib
import ipaddress
import json
import re


PROTOCOLS = {'lldp', 'cdp', 'arp', 'ndp', 'dhcp', 'fdb', 'wifi'}
DISCOVERY_PROTOCOLS = {'lldp', 'cdp'}
NEIGHBOR_FIELDS = {'protocol', 'address', 'mac', 'hostname', 'local_port', 'remote_port', 'expires_at'}
MAX_NEIGHBORS = 1024
MAP_LIMIT = 4096
MAX_REPORTS = 32
OBSERVATION_AGE = timedelta(hours=1)


def label(value, limit=256):
    if isinstance(value, str) and len(value) <= limit and not any(ord(c) < 32 or ord(c) == 127 for c in value):
        return value.strip()
    return ''


def address(value):
    if not isinstance(value, str) or len(value) > 64 or '%' in value:
        return ''
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return ''
    return str(ip) if not (ip.is_multicast or ip.is_unspecified or ip.is_loopback or str(ip) == '255.255.255.255') else ''


def mac_address(value):
    if not isinstance(value, str) or not 12 <= len(value) <= 17:
        return ''
    compact = re.sub(r'[:.\-]', '', value).lower()
    if not re.fullmatch(r'[0-9a-f]{12}', compact) or int(compact, 16) == 0 or int(compact[:2], 16) & 1:
        return ''
    return ':'.join(compact[i:i + 2] for i in range(0, 12, 2))


def moment(value):
    try:
        result = datetime.fromisoformat(label(value, 48).replace('Z', '+00:00'))
        return result.astimezone(timezone.utc) if result.utcoffset() is not None else None
    except (ValueError, OverflowError):
        return None


def neighbor(raw, *, stored=False):
    allowed = NEIGHBOR_FIELDS | {'observed_at'} if stored else NEIGHBOR_FIELDS
    if not isinstance(raw, dict) or set(raw) - allowed:
        raise ValueError('inventory_invalid_snapshot')
    protocol = label(raw.get('protocol'), 8).lower()
    ip, mac = address(raw.get('address')), mac_address(raw.get('mac'))
    if protocol not in PROTOCOLS or not (ip or mac):
        raise ValueError('inventory_invalid_snapshot')
    for field, value in (('address', ip), ('mac', mac)):
        if raw.get(field) and not value:
            raise ValueError('inventory_invalid_snapshot')
    result = {'protocol': protocol, 'address': ip, 'mac': mac}
    for field, limit in (('hostname', 253), ('local_port', 128), ('remote_port', 128)):
        value = label(raw.get(field), limit)
        if raw.get(field) and not value:
            raise ValueError('inventory_invalid_snapshot')
        # A forwarding entry can name its local bridge/port. It contains no
        # evidence of a peer port, even if an upstream payload provides one.
        if value and (field != 'remote_port' or protocol in DISCOVERY_PROTOCOLS):
            result[field] = value
    for field in ('observed_at', 'expires_at'):
        if raw.get(field):
            value = moment(raw[field])
            if value is None:
                raise ValueError('inventory_invalid_snapshot')
            result[field] = value.isoformat()
    return result


def inventory_metadata(record):
    fields = record.get('custom_fields') or {}
    source = fields.get('pl_inventory_source') if isinstance(fields, dict) else None
    if not isinstance(source, str) or not re.fullmatch(r'inventory:[a-f0-9-]{36}', source):
        return {}, {}
    meta = fields.get('pl_inventory')
    observed = meta.get('observed') if isinstance(meta, dict) and meta.get('schema') == 1 else None
    return (meta, observed) if isinstance(observed, dict) else ({}, {})


def read_neighbors(observed, fallback):
    rows = observed.get('neighbors')
    if not isinstance(rows, list):
        return
    for raw in rows[:MAX_NEIGHBORS]:
        try:
            record = neighbor(raw, stored=True)
        except ValueError:
            continue
        timestamp = moment(record.get('observed_at') or fallback)
        if timestamp is not None:
            yield {**record, 'observed_at': timestamp.isoformat()}


def merge_neighbors(snapshot, previous, previous_time):
    capabilities = snapshot.get('capabilities', {})
    replaced = {p for p in PROTOCOLS if capabilities.get('neighbors_' + p)}
    rows = snapshot.get('neighbors', [])
    if not replaced and capabilities.get('neighbors'):
        replaced = set(PROTOCOLS)
    replaced.update(row['protocol'] for row in rows)
    retained = (row for row in read_neighbors(previous, previous_time) if row['protocol'] not in replaced)
    merged = {neighbor_key(row): row for row in retained}
    for row in rows:
        merged[neighbor_key(row)] = {**row, 'observed_at': snapshot['observed_at']}
    # Leave room for newly collected rows even when several tables were read
    # at different times. A failed optional read never advances their clocks.
    return sorted(merged.values(), key=lambda r: (moment(r['observed_at']), neighbor_key(r)), reverse=True)[:MAX_NEIGHBORS]


def neighbor_key(row):
    return tuple(row.get(k, '') for k in ('protocol', 'address', 'mac', 'local_port', 'remote_port'))


def address_with_prefix(value):
    if not isinstance(value, str) or '/' not in value or '%' in value or len(value) > 80:
        return ''
    try:
        item = ipaddress.ip_interface(value)
    except ValueError:
        return ''
    return str(item) if address(str(item.ip)) else ''


def primary_addresses(asset):
    values = [asset.get(key) for key in ('primary_ip4', 'primary_ip6', 'primary_ip')]
    return list(dict.fromkeys(item for value in values if isinstance(value, dict)
                              if (item := address_with_prefix(value.get('address')))))


def map_port(port, *, virtual=False):
    _, observed = inventory_metadata(port)
    primary_mac = port.get('primary_mac_address')
    mac = mac_address(primary_mac.get('mac_address')) if isinstance(primary_mac, dict) else ''
    native_type = port.get('type')
    value = {'id': ('vm-interface:' if virtual else '') + str(port['id']), 'name': port['name'],
             'type': 'virtual' if virtual else native_type, 'enabled': port.get('enabled')}
    if mac or (mac := mac_address(port.get('mac_address'))):
        value['mac'] = mac
    if type(port.get('enabled')) is bool:
        value['admin_up'] = port['enabled']
    if type(observed.get('link_up')) is bool:
        value['oper_up'] = observed['link_up']
    untagged = port.get('untagged_vlan')
    if isinstance(untagged, dict) and type(untagged.get('vid')) is int:
        value['untagged_vlan'] = untagged['vid']
    tagged = port.get('tagged_vlans')
    if isinstance(tagged, list):
        value['tagged_vlans'] = [vlan['vid'] for vlan in tagged[:4094]
                                 if isinstance(vlan, dict) and type(vlan.get('vid')) is int]
    addresses = observed.get('addresses')
    if isinstance(addresses, list):
        value['ips'] = list(dict.fromkeys(ip for item in addresses[:128] if isinstance(item, dict)
                                        if (ip := address_with_prefix(item.get('address')))))
    return value


def map_asset_facts(asset, ports, management_ip):
    metadata, observed = inventory_metadata(asset)
    device_type = asset.get('device_type') if isinstance(asset.get('device_type'), dict) else {}
    manufacturer = device_type.get('manufacturer')
    manufacturer_name = manufacturer.get('name') if isinstance(manufacturer, dict) else ''
    details = {'manufacturer': label(manufacturer_name) or label(observed.get('manufacturer')),
               'model': label(device_type.get('model')) or label(observed.get('model')),
               'serial': label(asset.get('serial')) or label(observed.get('serial')),
               'os': label(observed.get('os_name')), 'software_version': label(observed.get('os_version')),
               'observed_at': label(metadata.get('observed_at'), 48)}
    primary = primary_addresses(asset)
    details['primary_addresses'] = [value.split('/', 1)[0] for value in primary]
    addresses = {}
    for value in primary:
        addresses[value.split('/', 1)[0]] = {'address': value, 'role': 'primary'}
    if management_ip:
        addresses.setdefault(management_ip, {'address': management_ip, 'role': 'management'})
    observed_addresses = defaultdict(dict)
    for port in ports:
        for value in port.get('ips', []):
            key = value.split('/', 1)[0]
            observed_addresses[key][(value, port['name'])] = {'address': value, 'role': 'interface', 'interface': port['name']}
    extra = []
    for key, entries in observed_addresses.items():
        if key in addresses and len(entries) == 1:
            observed_address, = entries.values()
            native = addresses[key]
            if '/' not in native['address']:
                native['address'] = observed_address['address']
            native['interface'] = observed_address['interface']
        else:
            extra.extend(entries.values())
    return {k: v for k, v in details.items() if v}, [*addresses.values(), *extra]


def stable_id(prefix, value):
    raw = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
    return prefix + hashlib.sha256(raw).hexdigest()[:24]


def projection_scope(node):
    scope = node['details'].get('source')
    return scope if isinstance(scope, str) and re.fullmatch(r'network:[a-f0-9]{16}', scope) else ''


def append_observations(nodes, edges, inventories, timestamp, *, selected=None):
    """Add safe observed links and presentation-only neighbors in place."""
    native = {node['id']: node for node in nodes if node['netbox_url']}
    by_mac, by_ip = defaultdict(set), defaultdict(set)
    for node in native.values():
        for port in node.get('ports', []):
            if port.get('mac'):
                by_mac[port['mac']].add(node['id'])
        for ip in (node['management_ip'], *node['details'].get('primary_addresses', ())):
            if ip:
                by_ip[ip].add(node['id'])

    now = moment(timestamp)
    network = ipaddress.ip_network(selected['cidr']) if selected else None
    native_cables = defaultdict(list)
    for edge in edges:
        native_cables[edge_key(edge)].append(edge)
    peers, links = {}, {}
    examined, truncated = 0, False
    for source_id, (meta, observed) in inventories.items():
        source = native[source_id]
        if source['details'].get('support_only'):
            continue
        source_scope = projection_scope(source)
        if selected and source_scope and source_scope != 'network:' + selected['id']:
            continue
        reports = list(read_neighbors(observed, meta.get('observed_at')))
        scoped_macs = ({row['mac'] for row in reports if row['mac'] and row['address'] and
                        ipaddress.ip_address(row['address']) in network} if network else set())
        for record in reports:
            ip, mac = record['address'], record['mac']
            if network and (ipaddress.ip_address(ip) not in network if ip else mac not in scoped_macs):
                continue
            at, expires = moment(record['observed_at']), moment(record.get('expires_at'))
            if at > now + timedelta(minutes=5):
                continue
            if examined >= MAP_LIMIT:
                truncated = True
                break
            examined += 1
            stale = at + OBSERVATION_AGE <= now or expires is not None and expires <= now
            mac_owners = by_mac.get(mac, ())
            candidate_id = next(iter(mac_owners)) if len(mac_owners) == 1 else None
            candidate = native.get(candidate_id)
            if source_id == candidate_id or ip and ip == source['management_ip']:
                continue
            # Do not identify clients by IP, hostnames or a shared chassis MAC.
            # Attach only an unambiguous MAC/IP pair or a direct LLDP/CDP MAC.
            if candidate and (ip and by_ip[ip] == {candidate_id} or
                              not ip and record['protocol'] in DISCOVERY_PROTOCOLS):
                peer_scope = projection_scope(candidate)
                if not source_scope or not peer_scope or source_scope == peer_scope:
                    target_id = candidate_id
                else:
                    target_id = None
            else:
                target_id = None
            if target_id is None:
                # A scoped MAC groups observations of the same local endpoint,
                # including IPv4 and IPv6. It is not a persistent device ID.
                identity = (source_scope or source_id, 'mac', mac) if mac else (source_scope or source_id, 'ip', ip)
                target_id = stable_id('neighbor:', identity)
                peer = peers.setdefault(target_id, {'id': target_id, 'name': '', '_ips': set(),
                    'kind': 'unknown', 'management_ip': ip, 'ports': [], 'netbox_url': '',
                    'config_url': '', 'config_history_url': '', 'details': {
                        'mac': mac, 'observation_methods': [], 'reports': [],
                        'observation_state': 'stale', 'last_seen': ''}})
                details = peer['details']
                if ip:
                    peer['_ips'].add(ipaddress.ip_address(ip))
                if record['protocol'] not in details['observation_methods']:
                    details['observation_methods'].append(record['protocol'])
                name = record.get('hostname', '')
                details['last_seen'] = max(details['last_seen'], record['observed_at'])
                if not stale:
                    details['observation_state'] = 'reported'
                    if name and record['observed_at'] >= peer.get('_name_at', ''):
                        peer['name'], peer['_name_at'] = name, record['observed_at']
                if len(details['reports']) < MAX_REPORTS:
                    details['reports'].append({'source': source['name'], 'hostname': name, 'mac': mac, 'address': ip,
                        'methods': [record['protocol']], 'observed_at': record['observed_at'],
                        'expires_at': record.get('expires_at', ''), 'state': 'stale' if stale else 'reported'})
                if ip and by_ip.get(ip):
                    details['identity_unconfirmed'] = True
            source_port, target_port = record.get('local_port', ''), record.get('remote_port', '')
            direct = record['protocol'] in DISCOVERY_PROTOCOLS and source_port and target_port
            edge = {'source': source_id, 'target': target_id, 'source_port': source_port, 'target_port': target_port}
            key = edge_key(edge) if direct else (source_id, target_id)
            fact = {'protocol': record['protocol'].upper(), 'source': source['name'], 'source_id': source_id,
                    'observed_at': record['observed_at'], 'status': 'stale' if stale else 'active'}
            if source_port:
                fact['source_port'] = source_port
            if target_port:
                fact['target_port'] = target_port
            registered = native_cables.get(key, ()) if direct else ()
            if len(registered) == 1:
                relation = registered[0]['details']['relationship']
                add_fact(relation, fact)
                continue
            link = links.setdefault(key, {**edge, 'id': stable_id('neighbor-link:', key), 'kind': 'observed',
                'status': 'stale', 'last_seen': '', 'evidence': [], 'details': {'relationship': {
                    'authority': 'observation', 'assurance': 'exact_lldp' if direct else 'direction',
                    'observations': []}}})
            link['last_seen'] = max(link['last_seen'], record['observed_at'])
            if not stale:
                link['status'] = 'active'
            add_fact(link['details']['relationship'], fact)
        if truncated:
            break
    for peer in peers.values():
        peer.pop('_name_at', None)
        ips = [str(ip) for ip in sorted(peer.pop('_ips'), key=lambda ip: (ip.is_link_local, ip.version, int(ip)))]
        peer['management_ip'] = ips[0] if ips else ''
        peer['name'] = peer['name'] or peer['management_ip'] or peer['details']['mac']
        peer['addresses'] = [{'address': ip, 'role': 'observed'} for ip in ips]
        peer['status'] = 'stale' if peer['details']['observation_state'] == 'stale' else 'observed'
    for link in links.values():
        relation = link['details']['relationship']
        if relation['assurance'] == 'exact_lldp':
            continue
        current = [fact for fact in relation['observations'] if fact['status'] == link['status']]
        for field in ('source_port', 'target_port'):
            ports = {fact[field] for fact in current if fact.get(field)}
            link[field] = next(iter(ports)) if len(ports) == 1 else ''
        if not link['source_port'] and not any(fact.get('source_port') for fact in current):
            relation['assurance'] = 'report'
    nodes.extend(peers.values())
    edges.extend(links.values())
    return truncated


def edge_key(edge):
    return tuple(sorted(((edge['source'], edge.get('source_port') or ''), (edge['target'], edge.get('target_port') or ''))))


def add_fact(relation, fact):
    observations = relation.setdefault('observations', [])
    keys = ('source_id', 'protocol', 'source_port', 'target_port')
    for index, previous in enumerate(observations):
        if all(previous.get(key) == fact.get(key) for key in keys):
            if fact['observed_at'] >= previous['observed_at']:
                observations[index] = fact
            return
    if len(observations) < MAX_REPORTS:
        observations.append(fact)
