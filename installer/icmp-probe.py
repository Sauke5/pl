"""Socket-activated, fixed-argument IPv4 ICMP probe for Pl."""
import argparse
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import selectors
import socket
import socketserver
import stat
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler

COUNT = 2000
INTERVAL_US = 2000
OUTPUT_LIMIT = 1024 * 1024
DEADLINE = 25
BINARY = '/usr/sbin/hping3'
POLICY = '/etc/pl-icmp-probe/cidrs.json'
POLICY_OWNER = 0
ACTIVE = threading.Lock()
STATS = re.compile(r'(\d+) packets transmitted, (\d+) packets received, [-\d.]+% packet loss')
RTT = re.compile(r'round-trip min/avg/max = ([\d.]+)/([\d.]+)/([\d.]+) ms')


def allowed(target, path=None):
    ip = ipaddress.IPv4Address(target)
    if (ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved
            or str(ip) in ('100.100.100.200', '168.63.129.16')):
        return False
    fd = os.open(path or POLICY, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != POLICY_OWNER or info.st_mode & 0o022:
            raise ValueError('unsafe policy ownership or permissions')
        data = os.read(fd, 32769)
    finally:
        os.close(fd)
    if len(data) > 32768:
        raise ValueError('oversized policy')
    policy = json.loads(data)
    if not isinstance(policy, dict) or set(policy) != {'cidrs'} or not isinstance(policy['cidrs'], list) or len(policy['cidrs']) > 128:
        raise ValueError('invalid policy')
    networks = [ipaddress.ip_network(v, strict=True) for v in policy['cidrs']]
    if any(n.version != 4 for n in networks):
        raise ValueError('policy must contain IPv4 networks')
    return any(ip in n and (n.prefixlen >= 31 or ip not in (n.network_address, n.broadcast_address))
               for n in networks if n.version == 4)


def summary(output):
    stats = STATS.search(output)
    if stats is None:
        raise ValueError('statistics missing')
    sent, received = map(int, stats.groups())
    if sent != COUNT or received > sent:
        raise ValueError('incomplete transmission')
    result = {'transmitted': sent, 'received': received,
              'loss_percent': max(0, 100 * (sent - received) / sent),
              'rtt_min_ms': None, 'rtt_avg_ms': None, 'rtt_max_ms': None}
    match = RTT.search(output)
    if received:
        if match is None:
            raise ValueError('RTT missing')
        times = [float(v) for v in match.groups()]
        if not all(math.isfinite(v) and v >= 0 for v in times):
            raise ValueError('invalid RTT')
        result.update(zip(('rtt_min_ms', 'rtt_avg_ms', 'rtt_max_ms'), times))
    return result


def run_probe(target, binary=None):
    command = [binary or BINARY, '-1', '-n', '-i', f'u{INTERVAL_US}', '-c', str(COUNT), target]
    started = time.monotonic()
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, env={'PATH': '/usr/sbin:/usr/bin:/bin', 'LC_ALL': 'C'})
    output = bytearray()
    error = None
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                if time.monotonic() - started >= DEADLINE:
                    error = 'timeout'
                    break
                for key, _ in selector.select(0.1):
                    chunk = os.read(key.fileobj.fileno(), 16384)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    if len(output) + len(chunk) > OUTPUT_LIMIT:
                        error = 'output_limit'
                        break
                    output.extend(chunk)
                if error:
                    break
        if error:
            process.kill()
        try:
            code = process.wait(timeout=max(0.01, DEADLINE - (time.monotonic() - started)))
        except subprocess.TimeoutExpired:
            error = 'timeout'
            process.kill()
            code = process.wait()
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
    raw = output.decode('utf-8', errors='replace')
    if len(raw.encode('utf-8')) > OUTPUT_LIMIT:
        raw = raw.encode('utf-8')[:OUTPUT_LIMIT].decode('utf-8', errors='ignore')
        error = 'output_limit'
    result = {'kind': 'icmp', 'engine': 'hping3', 'source': 'platform_host', 'count': COUNT,
              'interval_us': INTERVAL_US, 'scanned_address': target,
              'raw_output': raw,
              'duration_ms': round((time.monotonic() - started) * 1000), 'exit_code': code}
    if error:
        return 502, {**result, 'error': error}
    try:
        if code not in (0, 1):
            raise ValueError('runner failed')
        result.update(summary(result['raw_output']))
    except ValueError:
        return 502, {**result, 'error': 'incomplete'}
    return 200, result


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def respond(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_GET(self):
        self.respond(200 if self.path == '/health' else 404, {'status': 'ready'} if self.path == '/health' else {'error': 'not_found'})

    def do_POST(self):
        if self.path != '/v1/icmp':
            return self.respond(404, {'error': 'not_found'})
        try:
            lengths = self.headers.get_all('Content-Length') or []
            if len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,3}', lengths[0]):
                raise ValueError('invalid length')
            size = int(lengths[0])
            if not 0 < size <= 256 or self.headers.get('Transfer-Encoding') or self.headers.get('Content-Encoding'):
                raise ValueError('invalid length')
            def object_pairs(pairs):
                value = {}
                for key, item in pairs:
                    if key in value: raise ValueError('duplicate field')
                    value[key] = item
                return value
            payload = json.loads(self.rfile.read(size), object_pairs_hook=object_pairs)
            if not isinstance(payload, dict) or set(payload) != {'target'} or not isinstance(payload['target'], str):
                raise ValueError('only target is accepted')
            target = str(ipaddress.IPv4Address(payload['target']))
            if not allowed(target):
                return self.respond(403, {'error': 'policy_denied'})
        except (ValueError, TypeError, KeyError, OSError):
            return self.respond(400, {'error': 'invalid_target_or_policy'})
        if not ACTIVE.acquire(blocking=False):
            return self.respond(429, {'error': 'busy'})
        try:
            try:
                status, result = run_probe(target)
            except (OSError, subprocess.SubprocessError):
                status, result = 503, {'error': 'runner_unavailable'}
            self.respond(status, result)
        finally:
            ACTIVE.release()

    def log_message(self, fmt, *args):
        pass


def main():
    global POLICY, BINARY
    parser = argparse.ArgumentParser()
    parser.add_argument('--policy', required=True)
    parser.add_argument('--binary', default=BINARY)
    options = parser.parse_args()
    if not Path(options.policy).is_absolute() or not Path(options.binary).is_absolute():
        raise SystemExit('absolute policy and binary paths required')
    POLICY, BINARY = options.policy, options.binary
    if int(os.environ.get('LISTEN_PID', '0')) != os.getpid() or os.environ.get('LISTEN_FDS') != '1':
        raise SystemExit('systemd socket activation is required')
    server = Server('/run/pl-icmp-probe/probe.sock', Handler, bind_and_activate=False)
    server.socket.close()
    server.socket = socket.socket(fileno=3)
    server.serve_forever()


if __name__ == '__main__':
    main()
