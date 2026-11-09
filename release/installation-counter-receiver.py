#!/usr/bin/env python3
"""Receive PL v2 installation reports behind the HTTPS reverse proxy."""
import argparse
from contextlib import closing
import http.server
from ipaddress import ip_address
import json
import os
from pathlib import Path
import re
import sqlite3
from time import time


REPORT_PATH = '/v2/installs'
REPORT_LIMIT = 16_384
INSTALLATION_ID = re.compile(r'pl-[0-9a-f]{12}')
PL_VERSION = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}')
COMPONENT_VERSION = re.compile(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,63}')
OS_ID = re.compile(r'[a-z0-9][a-z0-9._-]{0,31}')
MODULE_ID = re.compile(r'[a-z0-9][a-z0-9_-]{0,63}')


def initialize(database):
    with closing(sqlite3.connect(database)) as connection, connection:
        connection.execute('BEGIN IMMEDIATE')
        connection.execute('''CREATE TABLE IF NOT EXISTS installations (
            installation_id TEXT PRIMARY KEY NOT NULL,
            version TEXT NOT NULL,
            last_seen INTEGER,
            last_ip TEXT
        )''')
        columns = {column[1] for column in connection.execute('PRAGMA table_info(installations)')}
        if 'last_seen' not in columns:
            connection.execute('ALTER TABLE installations ADD COLUMN last_seen INTEGER')
        if 'last_ip' not in columns:
            connection.execute('ALTER TABLE installations ADD COLUMN last_ip TEXT')
        connection.execute('''CREATE TABLE IF NOT EXISTS installation_profiles (
            installation_id TEXT PRIMARY KEY NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
            first_seen_v2 INTEGER NOT NULL,
            os_id TEXT,
            os_version TEXT,
            arch TEXT,
            modules_json TEXT
        )''')
        connection.execute('''CREATE TABLE IF NOT EXISTS installation_versions (
            event_id INTEGER PRIMARY KEY,
            installation_id TEXT NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
            version TEXT NOT NULL,
            observed_at INTEGER NOT NULL
        )''')
        connection.execute('''
            CREATE INDEX IF NOT EXISTS installation_versions_by_installation
            ON installation_versions (installation_id, event_id)
        ''')


def unique_object(pairs):
    fields = dict(pairs)
    if len(fields) != len(pairs):
        raise ValueError('Duplicate report fields')
    return fields


def matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def optional_version(value):
    return value is None or matches(COMPONENT_VERSION, value)


def parse_report(body):
    report = json.loads(body.decode('utf-8'), object_pairs_hook=unique_object)
    if not isinstance(report, dict) or set(report) != {'installation_id', 'version', 'os', 'arch', 'modules'}:
        raise ValueError('Invalid report fields')
    if not matches(INSTALLATION_ID, report['installation_id']) or not matches(PL_VERSION, report['version']):
        raise ValueError('Invalid installation ID or PL version')
    operating_system = report['os']
    if operating_system is not None and (
        not isinstance(operating_system, dict) or set(operating_system) != {'id', 'version'}
        or not matches(OS_ID, operating_system['id']) or not optional_version(operating_system['version'])
    ):
        raise ValueError('Invalid operating system')
    if report['arch'] not in ('amd64', 'arm64', None):
        raise ValueError('Invalid architecture')
    modules = report['modules']
    if modules is not None:
        if not isinstance(modules, list) or len(modules) > 64:
            raise ValueError('Invalid module list')
        seen = set()
        for module in modules:
            if (not isinstance(module, dict) or set(module) != {'id', 'version'}
                    or not matches(MODULE_ID, module['id']) or not optional_version(module['version'])
                    or module['id'] in seen):
                raise ValueError('Invalid or duplicate module')
            seen.add(module['id'])
        modules.sort(key=lambda module: module['id'])
    return report


def save_report(database, report, received_at, source_ip):
    installation, version = report['installation_id'], report['version']
    operating_system = report['os'] or {}
    modules = report['modules']
    modules_json = json.dumps(modules, separators=(',', ':')) if modules is not None else None
    with closing(sqlite3.connect(database, timeout=2)) as connection, connection:
        connection.execute('PRAGMA foreign_keys = ON')
        connection.execute('BEGIN IMMEDIATE')
        previous = connection.execute('''
            SELECT version FROM installation_versions WHERE installation_id = ? ORDER BY event_id DESC LIMIT 1
        ''', (installation,)).fetchone()
        connection.execute('''
            INSERT INTO installations (installation_id, version, last_seen, last_ip) VALUES (?, ?, ?, ?)
            ON CONFLICT(installation_id) DO UPDATE
            SET version = excluded.version, last_seen = excluded.last_seen, last_ip = excluded.last_ip
        ''', (installation, version, received_at, source_ip))
        connection.execute('''
            INSERT INTO installation_profiles (installation_id, first_seen_v2, os_id, os_version, arch, modules_json)
            VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id) DO UPDATE SET
            os_id = excluded.os_id, os_version = excluded.os_version, arch = excluded.arch, modules_json = excluded.modules_json
        ''', (installation, received_at, operating_system.get('id'), operating_system.get('version'),
              report['arch'], modules_json))
        if previous is None or previous[0] != version:
            connection.execute('''
                INSERT INTO installation_versions (installation_id, version, observed_at) VALUES (?, ?, ?)
            ''', (installation, version, received_at))


class Handler(http.server.BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def log_message(self, *args):
        pass

    def reply(self, status):
        self.send_response(status)
        if status != 204:
            self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        if self.path != REPORT_PATH:
            self.reply(404)
            return
        try:
            lengths = self.headers.get_all('Content-Length', [])
            if (len(lengths) != 1 or not re.fullmatch(r'[1-9][0-9]{0,4}', lengths[0])
                    or int(lengths[0]) > REPORT_LIMIT or self.headers.get('Transfer-Encoding')
                    or self.headers.get_content_type() != 'application/json'):
                raise ValueError('Invalid report framing')
            size = int(lengths[0])
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError('Incomplete report')
            report = parse_report(body)
        except (OSError, ValueError, RecursionError):
            self.reply(400)
            return

        received_at = int(time())
        # This loopback handler gets the peer address from Caddy's upstream header.
        source_ip = self.headers.get('X-PL-Source-IP')
        try:
            source_ip = str(ip_address(source_ip)) if source_ip else None
        except ValueError:
            source_ip = None
        try:
            save_report(self.server.database, report, received_at, source_ip)
        except sqlite3.Error:
            self.reply(503)
            return
        self.reply(204)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--count', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    if args.count:
        with closing(sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True)) as connection:
            print(connection.execute('SELECT COUNT(*) FROM installations').fetchone()[0])
        return
    initialize(args.database)
    with http.server.HTTPServer(('127.0.0.1', args.port), Handler) as server:
        server.database = args.database
        server.serve_forever()


if __name__ == '__main__':
    main()
