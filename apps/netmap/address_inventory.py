"""Pure address presentation from recorded interface facts, never subnet guesses."""
from __future__ import annotations

import ipaddress
import re


def _port(value):
    value = str(value or '')
    value = re.sub(r'^XGE(?=\d)', 'XGigabitEthernet', value, flags=re.I)
    return re.sub(r'^GE(?=\d)', 'GigabitEthernet', value, flags=re.I).casefold()


def _parse(value, include_link_local):
    if isinstance(value, dict):
        address = value.get('address')
        prefix = value.get('prefix_length')
        value = str(address) + (f'/{prefix}' if prefix is not None and '/' not in str(address) else '')
    if not isinstance(value, str):
        return None
    try:
        parsed = ipaddress.ip_interface(value.strip())
    except ValueError:
        return None
    ip = parsed.ip
    if ip.is_unspecified or ip.is_multicast or ip.is_loopback or (ip.is_link_local and not include_link_local):
        return None
    # ip_interface assigns /32 or /128 to bare values: do not report an invented mask.
    return str(parsed) if '/' in value else str(ip), str(ip), ip.version, ip.is_link_local


def _role(iface):
    name = str(iface.get('name') or '')
    if re.search(r'(?:^|[^a-z])(?:bmc|idrac|ipmi|ilo|megarac)(?:$|[^a-z])', name, re.I):
        return 'bmc'
    if iface.get('mgmt_only') or re.search(r'(?:^|[^a-z])(?:mgmt|management)(?:$|[^a-z])', name, re.I) or name.casefold().startswith('meth'):
        return 'management'
    if re.search(r'(?:^|[^a-z])(?:reserve|standby|резерв)(?:$|[^a-zа-я])', name, re.I):
        return 'reserve'
    if re.search(r'(?:^|[^a-z])(?:production|prod)(?:$|[^a-z])', name, re.I):
        return 'production'
    return 'interface'


def node_addresses(node, *, uplink_ports=(), vmknics=(), include_link_local=False):
    """Return own addresses, retaining interface identity and evidence sources.

    Supports inventory ``interfaces`` or graph ``ports``, optional ESXi VMkernel
    rows, primary_ip[46] and management_ip fallbacks. Switch uplinks must be
    supplied by the graph from known connections; peer IPs are never consumed.
    ``role`` is bmc/management/reserve/production/uplink/interface/primary.
    ``primary`` is independent of role. Prefixes are retained only if supplied.
    """
    primary_values = [node.get(key) for key in ('primary_ip', 'primary_ip4', 'primary_ip6')]
    primary = {parsed[1] for value in primary_values if (parsed := _parse(value, include_link_local))}
    management = _parse(node.get('management_ip'), include_link_local)
    switch = node.get('kind') == 'switch'
    uplinks = {_port(value) for value in uplink_ports}
    rows = {}

    def add(value, iface, source):
        parsed = _parse(value, include_link_local)
        if not parsed:
            return
        address, ip, family, link_local = parsed
        name = iface.get('name') or ''
        role = _role(iface)
        if switch:
            if ip in primary or (management and ip == management[1]):
                role = 'management'
            elif _port(name) in uplinks:
                role = 'uplink'
            elif role not in ('management', 'bmc'):
                return
        key = (name, ip)
        if key in rows:
            row = rows[key]
            if '/' in address and '/' not in row['address']:
                row['address'] = address
            if source not in row['sources']:
                row['sources'].append(source)
            return
        rows[key] = dict(address=address, ip=ip, family=family, interface=name or None,
                         interface_id=iface.get('id'), role=role, primary=ip in primary,
                         link_local=link_local, sources=[source])

    for iface in node.get('ports', node.get('interfaces', [])) or []:
        for value in iface.get('ips', []) or []:
            add(value, iface, 'netbox')
        if iface.get('observed_ip'):
            add(iface['observed_ip'], iface, 'operator-observation')
        for value in iface.get('guest_ips', []) or []:
            if iface.get('connected') is False or isinstance(value, dict) and value.get('nic_connected') is False:
                continue
            current = isinstance(value, dict) and value.get('current_powered_on') is True
            add(value, iface, 'guest-tools' if current else 'guest-tools-cached')
    for iface in vmknics:
        for value in iface.get('addresses', []) or []:
            add(value, iface, 'esxi')
    # Unbound primary addresses should not duplicate a known interface row.
    for value, source, role in [(value, 'netbox-primary', 'primary') for value in primary_values] + [(node.get('management_ip'), 'management', 'management')]:
        parsed = _parse(value, include_link_local)
        if not parsed or any(row['ip'] == parsed[1] for row in rows.values()):
            continue
        add(value, {}, source)
        if ('', parsed[1]) in rows:
            rows[('', parsed[1])]['role'] = 'management' if switch else role
    rank = {'primary': 0, 'production': 1, 'management': 2, 'reserve': 3, 'bmc': 4, 'uplink': 5, 'interface': 6}
    return sorted(rows.values(), key=lambda row: (not row['primary'], rank[row['role']], row['interface'] or '', row['family'], int(ipaddress.ip_address(row['ip']))))


def enrich_graph_addresses(graph):
    """Annotate graph nodes in place with addresses and network-peer uplink ports.

    Physical links to network devices establish uplink candidates (not a claim
    of routing direction). Logical tunnels, hints and server-facing links do not.
    The returned list always contains only each device's own interface addresses.
    """
    nodes = {node['id']: node for node in graph.get('nodes', [])}
    uplinks = {identifier: set() for identifier in nodes}
    network_kinds = {'switch', 'router', 'firewall'}
    for edge in graph.get('edges', []):
        if not ((edge.get('kind') == 'physical' and edge.get('confidence') in ('confirmed', 'documented')) or (edge.get('kind') == 'observed' and edge.get('network_path'))):
            continue
        for side, other in [('source', 'target'), ('target', 'source')]:
            node = nodes.get(edge.get(side))
            peer = nodes.get(edge.get(other))
            name = edge.get(side + '_port')
            if not node or not peer or node.get('kind') != 'switch' or peer.get('kind') not in network_kinds or not name:
                continue
            uplinks[node['id']].add(name)
            ports = node.get('ports', node.get('interfaces', [])) or []
            iface = next((port for port in ports if _port(port.get('name')) == _port(name)), {})
            parent = next((port for port in ports if iface.get('lag_id') is not None and port.get('id') == iface['lag_id']), None)
            if parent:
                uplinks[node['id']].add(parent['name'])
    for identifier, node in nodes.items():
        node['uplink_ports'] = sorted(uplinks[identifier])
        node['addresses'] = node_addresses(node, uplink_ports=uplinks[identifier])
    return graph
