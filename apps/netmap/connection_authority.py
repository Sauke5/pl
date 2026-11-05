"""Read-only relationship authority shared by all topology projections.

NetBox registers cables; collectors report observations. This module never writes
inventory and never turns an address/FDB direction into a physical cable.
"""
from __future__ import annotations
import hashlib
import re
from collections import defaultdict


def relationship_id(a, ap, b, bp, kind='physical'):
    ends = sorted((str(a) + '/' + str(ap or ''), str(b) + '/' + str(bp or '')))
    return hashlib.sha256(('|'.join(ends) + '|' + kind).encode()).hexdigest()[:20]


MAX_OBSERVATION_SOURCES = 32


def _bounded_observations(observations):
    """Retain last successful fact per observer/protocol, not polling history.

    A finite source cap also bounds malformed/pathological collector payloads.
    Reciprocal LLDP observers remain distinct sources with separate timestamps.
    """
    latest = {}
    for observation in observations:
        key = (observation.get('protocol'), observation.get('source'))
        prior = latest.get(key)
        if prior is None or (observation.get('observed_at') or '') > (prior.get('observed_at') or ''):
            latest[key] = dict(observation)
    result = list(latest.values())
    if len(result) > MAX_OBSERVATION_SOURCES:
        result.sort(key=lambda item: (item.get('observed_at') or '', str(item.get('protocol') or ''),
                                     str(item.get('source') or '')), reverse=True)
        result = result[:MAX_OBSERVATION_SOURCES]
    return result


def _protocols(edge):
    explicit = edge.get('details', {}).get('relationship', {}).get('observations', [])
    if explicit:
        return _bounded_observations(explicit)
    result = []
    for label in edge.get('evidence', []):
        protocol = next((p for p in ('LLDP', 'CDP', 'FDB', 'ARP') if re.search(r'\b' + p + r'\b', str(label))), None)
        if protocol:
            result.append({'protocol': protocol, 'source': str(label), 'observed_at': edge.get('last_seen'),
                           'status': edge.get('status', 'unknown')})
    return result


def add_observations(edge, evidence, observed_at, status):
    """Keep each collector/protocol timestamp before reciprocal edges merge."""
    rel = edge.setdefault('details', {}).setdefault('relationship', {})
    observations = rel.setdefault('observations', [])
    candidate = {'evidence': evidence, 'last_seen': observed_at, 'status': status}
    for observation in _protocols(candidate):
        if observation not in observations:
            observations.append(observation)
    rel['observations'] = _bounded_observations(observations)


def _physical_port(value):
    value = str(value or '').strip()
    if not value or re.fullmatch(r'(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}', value, re.I):
        return False
    return not re.match(r'(?i)^(?:vlan|vl\d|loop|tunnel|vSwitch|vmk|eth-trunk|bond|lag|port-channel|не|unknown)', value)


def _netbox_device_id(node):
    """Only canonical object references bind an observation node to inventory."""
    identifiers = set()
    stable = re.fullmatch(r'device:([1-9][0-9]*)', str(node.get('id', '')))
    if stable:
        identifiers.add(int(stable.group(1)))
    url = re.fullmatch(r'(?:/netmap/netbox)?/dcim/devices/([1-9][0-9]*)/',
                       str(node.get('netbox_url', '')))
    if url:
        identifiers.add(int(url.group(1)))
    return next(iter(identifiers)) if len(identifiers) == 1 else None


def normalize(graph, inventory=None):
    """Add authority metadata and registered cables, in place, with bounded conflict metadata.

    Without inventory the graph remains an observation projection. Existing edge
    IDs are retained; relationship.id is a stable undirected endpoint identity.
    Unknown/multi-termination cables are not guessed into point-to-point links.
    """
    nodes = {n['id']: n for n in graph.get('nodes', [])}
    by_interface = {}
    known_ports = set()
    for node in nodes.values():
        for iface in node.get('ports', []):
            if (iface.get('type') not in ('virtual', 'lag') and _physical_port(iface.get('name'))
                    and not str(iface.get('provenance', '')).startswith('Neighbor')):
                known_ports.add((node['id'], iface['name']))
            if iface.get('id') is not None:
                by_interface[iface['id']] = (node['id'], iface)
    if inventory is not None:
        # APR/live readers may replace ports with current rows lacking NetBox
        # interface IDs. Reattach inventory metadata using a verified object
        # reference; names, addresses and MACs are never identity fallbacks.
        device_nodes = defaultdict(list)
        for node in graph.get('nodes', []):
            identifier = _netbox_device_id(node)
            if identifier is not None:
                device_nodes[identifier].append(node)
        interface_owners = defaultdict(list)
        for device in inventory.get('devices', []):
            matches = device_nodes.get(device.get('id'), [])
            if len(matches) != 1:
                continue
            node_id = matches[0]['id']
            for iface in device.get('interfaces', []):
                if iface.get('id') is None or not iface.get('name'):
                    continue
                interface_owners[iface['id']].append((node_id, iface))
                if iface.get('type') not in ('virtual', 'lag') and _physical_port(iface['name']):
                    known_ports.add((node_id, iface['name']))
        by_interface = {identifier: owners[0] for identifier, owners in interface_owners.items() if len(owners) == 1}
    edges = graph.setdefault('edges', [])
    validated_cables = set()
    pairs = {}
    for edge in edges:
        if edge.get('kind') == 'physical':
            pairs.setdefault(frozenset(((edge['source'], edge.get('source_port', '')),
                                      (edge['target'], edge.get('target_port', '')))), edge)
    for cable in (inventory or {}).get('cables', []):
        a_ids, b_ids = cable.get('a_interface_ids'), cable.get('b_interface_ids')
        if a_ids is not None or b_ids is not None:
            if len(a_ids or []) != 1 or len(b_ids or []) != 1:
                continue
            ids = a_ids + b_ids
        else:
            ids = cable.get('interface_ids', [])
        if len(ids) != 2 or ids[0] == ids[1] or any(i not in by_interface for i in ids):
            continue
        (a, ai), (b, bi) = (by_interface[i] for i in ids)
        if a == b or any(i.get('type') in ('virtual', 'lag') for i in (ai, bi)):
            continue
        key = frozenset(((a, ai['name']), (b, bi['name'])))
        edge = pairs.get(key)
        if edge is None:
            edge = {'id': relationship_id(a, ai['name'], b, bi['name']), 'source': a, 'source_port': ai['name'],
                    'target': b, 'target_port': bi['name'], 'kind': 'physical', 'confidence': 'confirmed',
                    'status': 'documented', 'last_seen': None, 'evidence': ['NetBox: зарегистрированный кабель'],
                    'a_interface_id': ai['id'], 'b_interface_id': bi['id']}
            edges.append(edge)
            pairs[key] = edge
        edge['netbox_cable_id'] = cable['id']
        validated_cables.add(id(edge))
        has_lldp = any(o.get('protocol') in ('LLDP', 'CDP') for o in _protocols(edge))
        if cable.get('managed') and not has_lldp:
            edge['confidence'] = 'observed'
        url = cable.get('netbox_url') or '/dcim/cables/' + str(cable['id']) + '/'
        edge['netbox_url'] = '/netmap/netbox' + url if url.startswith('/dcim/') else url
        rel = edge.setdefault('details', {}).setdefault('relationship', {})
        rel.update(authority='netbox', cable_id=cable['id'], managed=bool(cable.get('managed')),
                   assurance='legacy_inferred' if cable.get('managed') and not has_lldp else 'registered')
    # A known registered cable may be corroborated by a one-sided direction;
    # preserve its observation without drawing a duplicate or calling it a new cable.
    registered = defaultdict(list)
    for edge in edges:
        if edge.get('details', {}).get('relationship', {}).get('authority') == 'netbox':
            registered[frozenset((edge['source'], edge['target']))].append(edge)
    retained = []
    for edge in edges:
        matches = []
        if edge.get('kind') == 'observed':
            for candidate in registered.get(frozenset((edge['source'], edge['target'])), ()):
                ports = {candidate['source']: candidate.get('source_port'), candidate['target']: candidate.get('target_port')}
                if all(not edge.get(side + '_port') or edge.get(side + '_port') == ports[edge[side]] for side in ('source', 'target')):
                    matches.append(candidate)
        if len(matches) == 1:
            rel = matches[0]['details']['relationship']
            current = _protocols(matches[0])
            rel['observations'] = _bounded_observations(current + _protocols(edge))
        else:
            retained.append(edge)
    edges[:] = retained
    occupancy = defaultdict(list)
    for edge in edges:
        details = edge.setdefault('details', {})
        old = details.get('relationship', {})
        observations = _bounded_observations(_protocols(edge))
        kind = edge.get('kind')
        exact = kind == 'physical' and all(_physical_port(edge.get(k)) for k in ('source_port', 'target_port'))
        protocols = {o.get('protocol') for o in observations}
        if kind == 'physical' and not exact and old.get('authority') != 'netbox':
            edge.update(kind='observed', confidence='unknown')
            kind = 'observed'
        if kind == 'physical' and not protocols.intersection(('LLDP', 'CDP')) and old.get('authority') != 'netbox' and edge.get('identity_evidence') != 'operator':
            edge.update(kind='observed', confidence='observed')
            kind = 'observed'
        authority = old.get('authority') if old.get('authority') == 'netbox' else (
            'operator' if edge.get('identity_evidence') == 'operator' else
            'esxi_api' if kind == 'virtual' else 'wan_configuration' if kind == 'tunnel' else
            'routing_configuration' if kind == 'routed' else 'observation')
        assurance = old.get('assurance') if authority == 'netbox' else (
            'documented' if authority in ('operator', 'wan_configuration', 'routing_configuration') else
            'explicit' if authority == 'esxi_api' else 'exact_lldp' if exact and protocols.intersection(('LLDP', 'CDP')) else 'direction')
        rel = {'id': relationship_id(edge['source'], edge.get('source_port'), edge['target'], edge.get('target_port'),
                                   'physical' if authority == 'netbox' or kind == 'physical' or (protocols.intersection(('LLDP', 'CDP')) and all(_physical_port(edge.get(k)) for k in ('source_port', 'target_port'))) else kind),
               'authority': authority, 'assurance': assurance, 'observations': observations,
               'conflicts': [], **{k: old[k] for k in ('cable_id', 'managed') if k in old}}
        details['relationship'] = rel
        # FDB/ARP directions describe reachability behind a port and never
        # assert exclusive physical occupancy (a phone may bridge a PC).
        # One-ended LLDP and advertised descriptions are also insufficient.
        exact_known = all((edge[side], edge.get(side + '_port')) in known_ports for side in ('source', 'target'))
        cable_fact = authority == 'netbox' or (authority == 'operator' and exact)
        lldp_claim = bool(protocols.intersection(('LLDP', 'CDP'))) and exact_known
        if cable_fact or lldp_claim:
            for side in ('source', 'target'):
                node_id, name = edge[side], edge.get(side + '_port')
                if _physical_port(name) and node_id in nodes:
                    occupancy[(node_id, name)].append(edge)
    conflicts = defaultdict(set)
    truncated = set()
    for candidates in occupancy.values():
        distinct = {e['details']['relationship']['id'] for e in candidates}
        if len(distinct) < 2:
            continue
        bounded = sorted(distinct)[:9]
        for edge in candidates:
            own = edge['details']['relationship']['id']
            conflicts[edge['id']].update(key for key in bounded if key != own)
            if len(distinct) > 9:
                truncated.add(edge['id'])
    for edge in edges:
        rel = edge['details']['relationship']
        conflict_ids = sorted(conflicts.get(edge['id'], ()))
        rel['conflicts'] = conflict_ids[:8]
        rel['conflicts_truncated'] = edge['id'] in truncated or len(conflict_ids) > 8
        if rel['conflicts'] and rel['authority'] == 'observation':
            edge.update(kind='observed', confidence='unknown')
            rel['assurance'] = 'conflict'
        # Inventory registration is a present fact, independent of whether FDB
        # still sees traffic. Historical retention must not turn that fact into
        # a failed physical observation; only LLDP/CDP carries that freshness.
        if (id(edge) in validated_cables and not rel['conflicts']
                and edge.get('status') in ('stale', 'missing')
                and not any(o.get('protocol') in ('LLDP', 'CDP') for o in rel['observations'])):
            edge.update(status='documented', missing_cycles=0, seen_cycles=0, fresh_observation=False)
    graph['relationship_schema_version'] = 1
    return graph
