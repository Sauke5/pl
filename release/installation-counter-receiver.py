#!/usr/bin/env python3
"""Receive installation counts behind the PL counter's HTTPS reverse proxy."""
import argparse
from contextlib import closing
import http.server
import json
import os
from pathlib import Path
import re
import sqlite3


def initialize(database):
    with closing(sqlite3.connect(database)) as connection, connection:
        connection.execute('''CREATE TABLE IF NOT EXISTS installations (
            installation_id TEXT PRIMARY KEY NOT NULL,
            version TEXT NOT NULL
        )''')


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
        if self.path != '/v1/installs':
            self.reply(404)
            return
        try:
            lengths = self.headers.get_all('Content-Length', [])
            if (len(lengths) != 1 or not re.fullmatch(r'[1-9][0-9]{0,2}', lengths[0])
                    or int(lengths[0]) > 256 or self.headers.get('Transfer-Encoding')
                    or self.headers.get_content_type() != 'application/json'):
                raise ValueError('Invalid report framing')
            size = int(lengths[0])
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError('Incomplete report')
            report = json.loads(body)
            if not isinstance(report, dict) or set(report) != {'installation_id', 'version'}:
                raise ValueError('Invalid report fields')
            installation, version = report['installation_id'], report['version']
            if (not isinstance(installation, str) or not re.fullmatch(r'pl-[0-9a-f]{12}', installation)
                    or not isinstance(version, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', version)):
                raise ValueError('Invalid installation identity or version')
        except (OSError, ValueError, RecursionError):
            self.reply(400)
            return

        try:
            with closing(sqlite3.connect(self.server.database, timeout=2)) as connection, connection:
                connection.execute('''INSERT INTO installations (installation_id, version) VALUES (?, ?)
                    ON CONFLICT(installation_id) DO UPDATE SET version = excluded.version
                    WHERE installations.version <> excluded.version''', (installation, version))
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
