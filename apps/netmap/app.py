"""Read-only NetMap web boundary, adapted from the existing topology server.

The owned network-stack service materializes snapshots. This process never
starts collectors, accesses credentials, invokes Docker or writes inventory.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import logging
import mimetypes
import os
from pathlib import Path
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from address_inventory import enrich_graph_addresses

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('NETMAP_DATA_DIR', '/data/map'))
LOG = logging.getLogger('netmap')
SCOPE_ID = re.compile(r'^[a-z][a-z0-9-]{0,63}$')
ASSETS = frozenset(('index.html', 'app.js', 'style.css', 'theme-init.js', 'office-view.js'))
MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024


def read_json(path, default=None):
    """Read complete atomically published data; never follow a supplied symlink."""
    if path.is_symlink():
        raise ValueError('Snapshot symlink is not permitted')
    try:
        with path.open('rb') as stream:
            body = stream.read(MAX_SNAPSHOT_BYTES + 1)
    except FileNotFoundError:
        return default
    if len(body) > MAX_SNAPSHOT_BYTES:
        raise ValueError('Snapshot exceeds size limit')
    return json.loads(body)


def ui_config():
    default = {'title': 'NetMap', 'default_scope': 'network', 'platform_url': '/',
               'scopes': [{'id': 'network', 'name': 'Сеть',
                           'api': './api/sites/network', 'grouped': False, 'rack': False}]}
    value = read_json(DATA / 'ui-config.json', default)
    return validate_ui_config(value)


def validate_ui_config(value):
    scopes = value.get('scopes') if isinstance(value, dict) else None
    if not isinstance(scopes, list) or not 1 <= len(scopes) <= 512:
        raise ValueError('NetMap requires configured scopes')
    safe, seen = [], set()
    for scope in scopes:
        key = scope.get('id', '') if isinstance(scope, dict) else ''
        if not isinstance(key, str) or not SCOPE_ID.fullmatch(key) or key in seen:
            raise ValueError('Invalid or duplicate scope')
        seen.add(key)
        name = scope.get('name', '')
        if not isinstance(name, str) or not name.strip() or len(name) > 160:
            raise ValueError('Invalid scope name')
        api = scope.get('api', './api/sites/' + key)
        if api not in ('./api/topology', './api/wan', './api/sites/' + key):
            raise ValueError('Scope API must remain on the NetMap origin')
        safe.append({'id': key, 'name': name, 'api': api,
                     'grouped': scope.get('grouped', False) is True,
                     'rack': scope.get('rack', False) is True})
    title = value.get('title', 'NetMap')
    if not isinstance(title, str) or len(title) > 160:
        raise ValueError('Invalid title')
    platform = value.get('platform_url', '/')
    if not isinstance(platform, str) or not platform.startswith('/') or platform.startswith('//') or any(c in platform for c in '\r\n\\'):
        raise ValueError('Platform link must remain on the PL origin')
    selected = value.get('default_scope', safe[0]['id'])
    if selected not in seen:
        raise ValueError('Unknown default scope')
    return {'title': title, 'default_scope': selected, 'platform_url': platform, 'scopes': safe}


def snapshot_name(path, configuration=None):
    fixed = {'/api/topology': 'topology.json', '/api/health': 'health.json',
             '/api/wan': 'wan.json', '/api/wan/health': 'wan-health.json',
             '/api/sites/health': 'sites-health.json'}
    if path in fixed:
        return fixed[path]
    match = re.fullmatch(r'/api/sites/([a-z][a-z0-9-]{0,63})', path)
    if match and any(scope['id'] == match[1] for scope in (configuration or ui_config())['scopes']):
        return 'sites-' + match[1] + '.json'
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        LOG.debug(format, *args)

    def do_GET(self):
        self.serve(False)

    def do_HEAD(self):
        self.serve(True)

    def configuration(self):
        return ui_config()

    def snapshot(self, path, name):
        return read_json(DATA / name)

    def serve(self, head):
        path = urlsplit(self.path).path
        if '%' in path or '\\' in path or '//' in path:
            self.respond(404, b'Not found', 'text/plain', head)
            return
        try:
            if path == '/config.js':
                body = 'globalThis.NETMAP_CONFIG=' + json.dumps(self.configuration(), ensure_ascii=False).replace('<', '\\u003c') + ';\n'
                self.respond(200, body.encode(), 'application/javascript; charset=utf-8', head)
                return
            name = snapshot_name(path, self.configuration())
            if name:
                data = self.snapshot(path, name)
                if data is None:
                    self.respond(503, b'{"error":"Initial collection is not complete"}', 'application/json', head)
                    return
                if isinstance(data, dict) and 'nodes' in data:
                    enrich_graph_addresses(data)
                self.respond(200, json.dumps(data, ensure_ascii=False).encode(), 'application/json; charset=utf-8', head)
                return
            relative = 'index.html' if path == '/' else path.lstrip('/')
            if relative in ASSETS:
                self.respond(200, (ROOT / 'web' / relative).read_bytes(), mimetypes.guess_type(relative)[0] or 'application/octet-stream', head)
                return
        except (OSError, ValueError, TypeError, KeyError):
            LOG.warning('NetMap data/config unavailable')
            self.respond(503, b'{"error":"NetMap data unavailable"}', 'application/json', head)
            return
        self.respond(404, b'Not found', 'text/plain', head)

    def respond(self, status, body, mime, head=False):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)


def make_handler(snapshot_provider, config_provider=None):
    """Embed the same map in the owned service without another HTTP listener.

    The caller authenticates browser requests before delegating to this handler.
    snapshot_provider receives a finite validated map API path; it returns the
    actual graph/health or None until an initial successful collection exists.
    """
    class ProviderHandler(Handler):
        def configuration(self):
            return validate_ui_config(config_provider()) if config_provider else ui_config()

        def snapshot(self, path, name):
            return snapshot_provider(path)

    return ProviderHandler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serve-only', action='store_true', help='Compatibility flag; this server always serves without collection')
    parser.add_argument('--listen', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8093)
    args = parser.parse_args()
    if not ipaddress.ip_address(args.listen).is_loopback or not 1 <= args.port <= 65535:
        parser.error('NetMap must bind a loopback address and valid port behind the stack gateway')
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    with ThreadingHTTPServer((args.listen, args.port), Handler) as server:
        server.serve_forever()


if __name__ == '__main__':
    main()
