"""Passive identity hints from existing observations; no inventory or network IO."""
import re


def annotate(graph):
    """Keep inventory kind intact; expose a bounded, dated hint for UI consumers."""
    evidence_by_node = {}
    for edge in graph.get('edges', []):
        if any(re.search(r'\b(?:LLDP|CDP)\b', str(value), re.I) for value in edge.get('evidence', [])):
            for node_id in (edge.get('source'), edge.get('target')):
                if edge.get('last_seen'):
                    evidence_by_node.setdefault(node_id, []).append(edge['last_seen'])
    for node in graph.get('nodes', []):
        details = node.setdefault('details', {})
        # A registered inventory role always wins. Aggregate populations are not a device.
        if node.get('kind') != 'unknown' or str(node.get('id', '')).startswith(('arp:', 'segment:')):
            continue
        if len(set(details.get('macs', []))) > 1:
            continue
        evidence = []
        suggested = None
        for key in ('lldp', 'lldp_native'):
            peer = details.get(key) or {}
            enabled = next((peer[k] for k in ('remote_enabled_capabilities', 'capabilities_enabled') if k in peer), None)
            supported = next((peer[k] for k in ('remote_capabilities', 'capabilities_supported') if k in peer), '')
            capabilities = enabled if enabled is not None else supported
            if re.search(r'\btelephone\b', str(capabilities), re.I):
                suggested = 'phone'
                times = evidence_by_node.get(node.get('id'), [])
                at = details.get('lldp_observed_at') or details.get('observed_at') or (max(times) if times else None)
                evidence.append({'source': key, 'protocol': 'LLDP', 'observed_at': at,
                                 'value': str(capabilities)[:256]})
        vendors = {}
        for row in details.get('identities', []):
            if row.get('vendor'):
                vendor = str(row['vendor'])[:128]
                vendors[vendor.casefold()] = vendor
                evidence.append({'source': str(row.get('source') or 'identity')[:128],
                                 'protocol': 'OUI' if str(row.get('source', '')).lower() in ('oui', 'mac-oui') else 'identity',
                                 'observed_at': row.get('observed_at'), 'value': vendor})
        vendor = next(iter(vendors.values())) if len(vendors) == 1 else None
        prior = details.get('identity_hint') or {}
        # A curated specific OUI family may supply a low hint. Preserve that
        # separate evidence; a generic vendor match must not erase or promote it.
        if suggested is None and prior.get('status') == 'suggested' and prior.get('suggested_kind') and any(
                item.get('protocol') == 'OUI' for item in prior.get('identity_evidence', [])):
            continue
        if suggested is None and not vendor:
            continue
        unique = []
        for item in evidence:
            if item not in unique:
                unique.append(item)
        details['identity_hint'] = {'suggested_kind': suggested,
                                    'identity_evidence': unique[:8],
                                    'confidence': 'medium' if suggested else 'low', 'status': 'suggested',
                                    **({'vendor': vendor} if vendor else {})}
    return graph
