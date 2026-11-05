"""Finite host diagnostics expose measurements only, never command execution."""
import io
from pathlib import Path
import types
import unittest
from unittest.mock import patch

import test_module_controller as baseline

pl = baseline.pl

class HostStatusTests(unittest.TestCase):
    def test_reads_host_memory_uptime_and_owned_root_storage(self):
        controller = object.__new__(pl.Controller)
        controller.root = Path('/fixture/pl')
        controller.installation = 'pl-0123456789ab'
        def opened(name, **kwargs):
            if name == '/proc/meminfo':
                return io.StringIO('MemTotal: 32768 kB\nMemAvailable: 16384 kB\n')
            if name == '/proc/uptime':
                return io.StringIO('12345.50 20000.00\n')
            raise AssertionError('Unexpected diagnostic file')
        with patch('builtins.open', side_effect=opened), patch.object(pl.os, 'uname', return_value=types.SimpleNamespace(nodename='lab', release='kernel-fixture')), patch.object(pl.os, 'cpu_count', return_value=6), patch.object(pl.os, 'getloadavg', return_value=(0.1, 0.2, 0.3)), patch.object(pl.shutil, 'disk_usage', return_value=types.SimpleNamespace(total=1000, used=250, free=750)) as storage:
            status = controller.host_status({})
        self.assertEqual(status['memory'], {'total_bytes': 32768 * 1024, 'available_bytes': 16384 * 1024})
        self.assertEqual(status['uptime_seconds'], 12345.5)
        self.assertEqual(status['cpus'], 6)
        self.assertEqual(status['storage']['free_bytes'], 750)
        self.assertEqual(status['hostname'], 'lab')
        storage.assert_called_once_with(controller.root)

    def test_rejects_arguments_before_accessing_host(self):
        controller = object.__new__(pl.Controller)
        with patch('builtins.open', side_effect=AssertionError('Unexpected file access')):
            for body in ({'path': '/etc/shadow'}, {'command': 'reboot'}, [], None):
                with self.subTest(body=body), self.assertRaises(ValueError):
                    controller.host_status(body)
