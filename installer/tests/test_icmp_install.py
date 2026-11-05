import importlib.util
import json
import os
from pathlib import Path
import socket
import stat
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('icmp_install', Path(__file__).resolve().parents[1] / 'icmp-install.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pl-ih-', dir='/tmp')
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name).resolve()
        self.root, self.host, self.package = base / 'root', base / 'host', base / 'pkg'
        for path in (self.root, self.host, self.package, self.root / 'run', self.root / 'private', self.root / 'state', self.host / 'etc/systemd/system', self.host / 'usr/sbin'):
            path.mkdir(parents=True, exist_ok=True)
            path.chmod(0o755)
        (self.root / 'private').chmod(0o700)
        self.install_id = 'pl-0123456789ab'
        self.gid = os.getgid()
        if self.gid <= 0:
            self.skipTest('test requires a nonzero primary gid')
        (self.root / '.pl-installation.json').write_text(json.dumps({'product': 'PL', 'gid': self.gid}))
        (self.root / 'state/installation.json').write_text(json.dumps({'product': 'PL', 'install_id': self.install_id}))
        (self.package / 'icmp-probe.py').write_text('# fixed helper\n')
        binary = self.host / 'usr/sbin/hping3'
        binary.write_text('test executable')
        binary.chmod(0o755)
        self.commands = []
        health_patch = patch.object(helper, '_health', return_value=None)
        self.healthy = health_patch.start()
        self.addCleanup(health_patch.stop)

    def run_command(self, args, **kwargs):
        self.commands.append(args)
        return b''

    def prepare(self, cidrs=None):
        return helper.prepare(self.root, self.package, self.install_id, ['192.0.2.0/24'] if cidrs is None else cidrs,
                              self.gid, self.run_command, _host_prefix=self.host)

    def remove(self):
        return helper.remove(self.root, self.install_id, self.run_command, _host_prefix=self.host)

    def test_installs_bounded_socket_service_and_is_idempotent(self):
        result = self.prepare()
        self.assertEqual(result, str(self.root / 'run/icmp-probe/probe.sock'))
        service = (self.host / 'etc/systemd/system' / (self.install_id + '-icmp-probe.service')).read_text()
        unit = (self.host / 'etc/systemd/system' / (self.install_id + '-icmp-probe.socket')).read_text()
        self.assertIn('ExecStart=/usr/bin/python3 -B ', service)
        for line in ('DynamicUser=yes', 'NoNewPrivileges=yes', 'CapabilityBoundingSet=CAP_NET_RAW',
                     'AmbientCapabilities=CAP_NET_RAW', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_PACKET', 'ProtectSystem=strict'):
            self.assertIn(line, service)
        self.assertNotIn('Group=', service)
        self.assertIn(f'SocketGroup={self.gid}', unit)
        self.assertIn('SocketMode=0660', unit)
        self.assertIn('DirectoryMode=0755', unit)
        self.assertIn('RemoveOnStop=yes', unit)
        policy = self.host / 'etc/pl/icmp' / self.install_id / 'cidrs.json'
        self.assertEqual(json.loads(policy.read_text()), {'cidrs': ['192.0.2.0/24']})
        self.assertEqual(stat.S_IMODE(policy.stat().st_mode), 0o644)
        self.assertEqual(stat.S_IMODE((self.root / 'private/icmp-helper.json').stat().st_mode), 0o600)
        before = (self.root / 'private/icmp-helper.json').read_bytes()
        self.prepare()
        self.assertEqual(before, (self.root / 'private/icmp-helper.json').read_bytes())
        self.assertEqual(self.healthy.call_count, 2)
        self.assertIn(['systemctl', 'enable', '--now', self.install_id + '-icmp-probe.socket'], self.commands)

    def test_policy_is_explicit_and_changed_config_or_payload_needs_upgrade(self):
        self.prepare([])
        with self.assertRaisesRegex(ValueError, 'upgrade'):
            self.prepare(['192.0.2.0/24'])
        (self.package / 'icmp-probe.py').write_text('# different trusted payload\n')
        with self.assertRaisesRegex(ValueError, 'upgrade'):
            self.prepare([])
        for invalid in (['192.0.2.1/24'], ['::/0'], ['bad'], ['192.0.2.0/24'] * 2):
            with self.assertRaises(ValueError): self.prepare(invalid)

    def test_foreign_collision_and_unsafe_binary_are_rejected_before_writes(self):
        unit = self.host / 'etc/systemd/system' / (self.install_id + '-icmp-probe.service')
        unit.write_text('foreign')
        with self.assertRaisesRegex(ValueError, 'foreign'):
            self.prepare()
        self.assertEqual(unit.read_text(), 'foreign')
        self.assertEqual(self.commands, [])
        unit.unlink()
        (self.host / 'usr/sbin/hping3').chmod(0o777)
        with self.assertRaisesRegex(ValueError, 'unsafe file'):
            self.prepare()
        self.assertFalse((self.root / 'private/icmp-helper.json').exists())

    def test_private_system_parent_and_tampered_policy_are_rejected(self):
        parent = self.host / 'etc/pl/icmp'
        parent.mkdir(parents=True)
        parent.chmod(0o700)
        with self.assertRaisesRegex(ValueError, 'traversable'):
            self.prepare()
        self.assertFalse((self.root / 'private/icmp-helper.json').exists())
        parent.chmod(0o755)
        self.prepare()
        policy = parent / self.install_id / 'cidrs.json'
        policy.chmod(0o664)
        self.commands.clear()
        with self.assertRaisesRegex(ValueError, 'unsafe file|unexpected file mode'):
            self.remove()
        self.assertEqual(self.commands, [])

    def test_failed_rollback_preserves_owned_metadata_for_recovery(self):
        self.healthy.side_effect = ValueError('unhealthy')
        def fail_disable(args, **kwargs):
            self.commands.append(args)
            if args[:3] == ['systemctl', 'disable', '--now']:
                raise ValueError('stop failed')
            return b''
        with self.assertRaisesRegex(ValueError, 'retained for removal'):
            helper.prepare(self.root, self.package, self.install_id, [], self.gid, fail_disable, _host_prefix=self.host)
        self.assertTrue((self.root / 'private/icmp-helper.json').exists())
        self.remove()
        self.assertFalse((self.root / 'private/icmp-helper.json').exists())

    def test_remove_refuses_modified_files_and_unknown_runtime_content(self):
        self.prepare()
        service = self.host / 'etc/systemd/system' / (self.install_id + '-icmp-probe.service')
        original = service.read_bytes()
        service.write_text('foreign alteration')
        self.commands.clear()
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.remove()
        self.assertEqual(self.commands, [])
        service.write_bytes(original)
        stray = self.root / 'run/icmp-probe/foreign'
        stray.write_text('keep')
        with self.assertRaisesRegex(ValueError, 'foreign'):
            self.remove()
        self.assertEqual(stray.read_text(), 'keep')
        self.assertEqual(self.commands, [])

    def test_remove_owned_only_and_leaves_shared_parents(self):
        self.prepare()
        runtime = self.root / 'run/icmp-probe'
        identity = (runtime.stat().st_dev, runtime.stat().st_ino)
        path = self.root / 'run/icmp-probe/probe.sock'
        with socket.socket(socket.AF_UNIX) as sock:
            sock.bind(str(path))
            path.chmod(0o660)
            os.chown(path, -1, self.gid)
            self.remove()
        self.assertFalse(path.exists())
        self.assertFalse((self.root / 'private/icmp-helper.json').exists())
        self.assertTrue((self.root / 'private/icmp-runtime-owner.json').is_file())
        self.assertEqual((runtime.stat().st_dev, runtime.stat().st_ino), identity)
        self.assertFalse((self.host / 'etc/pl/icmp' / self.install_id).exists())
        self.assertTrue((self.host / 'etc/pl/icmp').is_dir())
        self.assertTrue((self.host / 'usr/sbin/hping3').exists())
        self.assertIn(['systemctl', 'disable', '--now', self.install_id + '-icmp-probe.socket'], self.commands)
        self.assertIn(['systemctl', 'stop', self.install_id + '-icmp-probe.service'], self.commands)
        self.prepare()
        self.assertEqual((runtime.stat().st_dev, runtime.stat().st_ino), identity)

    def test_reinstall_refuses_replaced_or_foreign_runtime_directory(self):
        self.prepare()
        self.remove()
        runtime = self.root / 'run/icmp-probe'
        moved = self.root / 'run/old-inode'
        runtime.rename(moved)
        runtime.mkdir(mode=0o755)
        self.commands.clear()
        with self.assertRaisesRegex(ValueError, 'ownership mismatch'):
            self.prepare()
        self.assertEqual(self.commands, [])
        runtime.rmdir()
        moved.rename(runtime)
        foreign = runtime / 'foreign'
        foreign.write_text('keep')
        with self.assertRaisesRegex(ValueError, 'foreign files'):
            self.prepare()
        self.assertEqual(foreign.read_text(), 'keep')
        self.assertEqual(self.commands, [])

    def test_failure_after_activation_rolls_back_owned_files(self):
        self.healthy.side_effect = ValueError('unhealthy')
        with self.assertRaisesRegex(ValueError, 'unhealthy'):
            self.prepare()
        self.assertFalse((self.root / 'private/icmp-helper.json').exists())
        self.assertFalse((self.root / 'run/icmp-probe').exists())
        self.assertFalse((self.host / 'usr/local/lib/pl/icmp' / self.install_id).exists())
        self.assertIn(['systemctl', 'disable', '--now', self.install_id + '-icmp-probe.socket'], self.commands)

    def test_identity_and_group_must_match(self):
        with self.assertRaises(ValueError):
            helper.prepare(self.root, self.package, 'pl-deadbeef1234', [], self.gid, self.run_command, _host_prefix=self.host)
        with self.assertRaises(ValueError):
            helper.prepare(self.root, self.package, self.install_id, [], self.gid + 1, self.run_command, _host_prefix=self.host)
        self.assertEqual(self.commands, [])

    def test_factory_and_legacy_product_identifiers(self):
        marker_path = self.root / '.pl-installation.json'
        state_path = self.root / 'state/installation.json'
        for marker_product in ('PL', 'Pl'):
            for state_product in ('PL', 'Pl'):
                with self.subTest(marker=marker_product, state=state_product):
                    marker_path.write_text(json.dumps({'product': marker_product, 'gid': self.gid}))
                    state_path.write_text(json.dumps({'product': state_product, 'install_id': self.install_id}))
                    self.prepare()
                    self.remove()
        marker_path.write_text(json.dumps({'product': 'foreign', 'gid': self.gid}))
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            self.prepare()

    def test_readiness_uses_bounded_unix_http_health(self):
        path = self.root / 'health.sock'
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(path))
            listener.listen(1)
            def serve():
                connection, _ = listener.accept()
                with connection:
                    request = connection.recv(1024)
                    self.assertTrue(request.startswith(b'GET /health HTTP/1.1\r\n'))
                    body = b'{"status":"ready"}'
                    connection.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 18\r\n\r\n' + body)
            thread = threading.Thread(target=serve)
            thread.start()
            helper._health_once(path)
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())


if __name__ == '__main__':
    unittest.main()
