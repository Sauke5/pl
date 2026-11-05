"""Worker waits for complete migrations without becoming a second migrator.

Run in CI. Loading the embedded worker boundary never starts native processes.
"""
from contextlib import redirect_stderr
import io
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'apps/netmap-stack/netbox-start.sh'
SOURCE = SCRIPT.read_text().split("<<'PL_NETBOX_WORKER'\n", 1)[1].split('\nPL_NETBOX_WORKER', 1)[0]


class WorkerStarted(Exception):
    pass


class NetBoxWorkerStartupTests(unittest.TestCase):
    def setUp(self):
        self.worker = types.ModuleType('pl_netbox_worker_test')
        exec(compile(SOURCE, str(SCRIPT), 'exec'), self.worker.__dict__)

    def run_until_start(self, checks):
        with patch.object(self.worker.subprocess, 'run', side_effect=checks) as probe, \
             patch.object(self.worker.time, 'monotonic', return_value=0), \
             patch.object(self.worker.time, 'sleep') as sleep, \
             patch.object(self.worker.os, 'execv', side_effect=WorkerStarted) as start:
            with self.assertRaises(WorkerStarted):
                self.worker.main()
        start.assert_called_once_with(sys.executable, [sys.executable, 'manage.py', 'rqworker'])
        for call in probe.call_args_list:
            self.assertEqual(call.args[0], [sys.executable, 'manage.py', 'migrate', '--check'])
            self.assertEqual(call.kwargs['timeout'], 30)
            self.assertEqual(call.kwargs['stdout'], subprocess.DEVNULL)
            self.assertEqual(call.kwargs['stderr'], subprocess.DEVNULL)
        return probe, sleep

    def test_pending_migrations_prevent_early_system_job_scheduling(self):
        probe, sleep = self.run_until_start([types.SimpleNamespace(returncode=1), types.SimpleNamespace(returncode=0)])
        self.assertEqual(probe.call_count, 2)
        sleep.assert_called_once_with(2)

    def test_already_current_schema_starts_worker_without_migration_or_delay(self):
        probe, sleep = self.run_until_start([types.SimpleNamespace(returncode=0)])
        self.assertEqual(probe.call_count, 1)
        sleep.assert_not_called()

    def test_slow_database_probe_is_bounded_and_retried_before_start(self):
        probe, sleep = self.run_until_start([subprocess.TimeoutExpired('private-native-config', 30), types.SimpleNamespace(returncode=0)])
        self.assertEqual(probe.call_count, 2)
        sleep.assert_called_once_with(2)

    def test_thirteen_second_django_startup_can_complete_before_rqworker(self):
        clock = types.SimpleNamespace(now=0)

        def check(command, **kwargs):
            self.assertEqual(command, [sys.executable, 'manage.py', 'migrate', '--check'])
            timeout = kwargs['timeout']
            self.assertLessEqual(timeout, min(30, 1200 - clock.now))
            clock.now += min(13, timeout)
            if timeout < 13:
                raise subprocess.TimeoutExpired(command, timeout)
            return types.SimpleNamespace(returncode=0)

        def sleep(duration):
            clock.now += duration

        with patch.object(self.worker.subprocess, 'run', side_effect=check) as probe, \
             patch.object(self.worker.time, 'monotonic', side_effect=lambda: clock.now), \
             patch.object(self.worker.time, 'sleep', side_effect=sleep), \
             patch.object(self.worker.os, 'execv', side_effect=WorkerStarted) as start:
            with self.assertRaises(WorkerStarted):
                self.worker.main()
        self.assertEqual(clock.now, 13)
        probe.assert_called_once()
        start.assert_called_once_with(sys.executable, [sys.executable, 'manage.py', 'rqworker'])

    def test_fully_stalled_probes_still_fail_at_overall_deadline(self):
        clock = types.SimpleNamespace(now=0)
        timeouts = []
        stderr = io.StringIO()

        def check(command, **kwargs):
            self.assertEqual(command, [sys.executable, 'manage.py', 'migrate', '--check'])
            remaining = 1200 - clock.now
            timeout = kwargs['timeout']
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, 30)
            self.assertLessEqual(timeout, remaining)
            timeouts.append(timeout)
            clock.now += timeout
            raise subprocess.TimeoutExpired('private-native-config', timeout)

        def sleep(duration):
            self.assertLessEqual(duration, min(2, 1200 - clock.now))
            clock.now += duration

        with patch.object(self.worker.subprocess, 'run', side_effect=check), \
             patch.object(self.worker.time, 'monotonic', side_effect=lambda: clock.now), \
             patch.object(self.worker.time, 'sleep', side_effect=sleep), \
             patch.object(self.worker.os, 'execv') as start, redirect_stderr(stderr):
            self.assertEqual(self.worker.main(), 1)
        self.assertEqual(clock.now, 1200)
        self.assertEqual(timeouts, [30] * 37 + [16])
        start.assert_not_called()
        self.assertEqual(stderr.getvalue(), 'NetBox worker did not start: schema readiness timed out\n')

    def test_incomplete_schema_deadline_fails_closed_without_worker_or_secret_output(self):
        stderr = io.StringIO()
        with patch.object(self.worker.subprocess, 'run', return_value=types.SimpleNamespace(returncode=1)) as probe, \
             patch.object(self.worker.time, 'monotonic', side_effect=[0, 0, 1201]), \
             patch.object(self.worker.time, 'sleep') as sleep, \
             patch.object(self.worker.os, 'execv') as start, redirect_stderr(stderr):
            self.assertEqual(self.worker.main(), 1)
        probe.assert_called_once()
        start.assert_not_called()
        sleep.assert_not_called()
        self.assertEqual(stderr.getvalue(), 'NetBox worker did not start: schema readiness timed out\n')

    def test_unavailable_schema_probe_fails_without_spinning_or_native_error_details(self):
        stderr = io.StringIO()
        with patch.object(self.worker.subprocess, 'run', side_effect=OSError('private-value')) as probe, \
             patch.object(self.worker.time, 'monotonic', return_value=0), \
             patch.object(self.worker.os, 'execv') as start, redirect_stderr(stderr):
            self.assertEqual(self.worker.main(), 1)
        probe.assert_called_once()
        start.assert_not_called()
        self.assertEqual(stderr.getvalue(), 'NetBox worker did not start: schema check unavailable\n')

    def test_cold_schema_can_take_eleven_minutes_without_restarting_worker(self):
        clock = types.SimpleNamespace(now=0)

        def check(command, **kwargs):
            self.assertEqual(command, [sys.executable, 'manage.py', 'migrate', '--check'])
            self.assertEqual(kwargs['timeout'], 30)
            ready = clock.now >= 660
            clock.now += 13
            return types.SimpleNamespace(returncode=0 if ready else 1)

        def sleep(duration):
            clock.now += duration

        with patch.object(self.worker.subprocess, 'run', side_effect=check) as probe, \
             patch.object(self.worker.time, 'monotonic', side_effect=lambda: clock.now), \
             patch.object(self.worker.time, 'sleep', side_effect=sleep), \
             patch.object(self.worker.os, 'execv', side_effect=WorkerStarted) as start:
            with self.assertRaises(WorkerStarted):
                self.worker.main()
        self.assertEqual(clock.now, 673)
        self.assertEqual(probe.call_count, 45)
        start.assert_called_once_with(sys.executable, [sys.executable, 'manage.py', 'rqworker'])


if __name__ == '__main__':
    unittest.main()
