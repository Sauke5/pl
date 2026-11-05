#!/bin/sh
set -eu
cd /opt/netbox/netbox
if [ "${1:-}" = "--worker" ] && [ "$#" -eq 1 ]; then
    # Only the web process owns migrations and native account bootstrap.
    # rqworker schedules system jobs immediately, so it must not see a partial
    # schema while that process is still applying migrations.
    exec /opt/netbox/venv/bin/python - <<'PL_NETBOX_WORKER'
import os
import subprocess
import sys
import time

# Match the full stack's bounded first-bootstrap window. A fresh NetBox schema
# can take more than ten minutes; restarting rqworker while it is incomplete
# only repeats Django initialization without making the schema ready sooner.
SCHEMA_WAIT_SECONDS = 1200
# manage.py first initializes Django; a valid check can exceed 13 seconds on
# the bounded one-CPU container before it even queries migration readiness.
SCHEMA_PROBE_SECONDS = 30


def main():
    deadline = time.monotonic() + SCHEMA_WAIT_SECONDS
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            print('NetBox worker did not start: schema readiness timed out', file=sys.stderr)
            return 1
        try:
            result = subprocess.run(
                [sys.executable, 'manage.py', 'migrate', '--check'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=min(SCHEMA_PROBE_SECONDS, remaining), check=False,
            )
        except subprocess.TimeoutExpired:
            result = None
        except OSError:
            print('NetBox worker did not start: schema check unavailable', file=sys.stderr)
            return 1
        if result is not None and result.returncode == 0:
            if time.monotonic() >= deadline:
                print('NetBox worker did not start: schema readiness timed out', file=sys.stderr)
                return 1
            try:
                os.execv(sys.executable, [sys.executable, 'manage.py', 'rqworker'])
            except OSError:
                print('NetBox worker did not start: worker command unavailable', file=sys.stderr)
                return 1
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            print('NetBox worker did not start: schema readiness timed out', file=sys.stderr)
            return 1
        time.sleep(min(2, remaining))


if __name__ == '__main__':
    raise SystemExit(main())
PL_NETBOX_WORKER
fi
if [ "$#" -ne 0 ]; then
    echo 'Unsupported NetBox startup mode' >&2
    exit 64
fi
/opt/netbox/docker-entrypoint.sh /bin/true
/opt/netbox/venv/bin/python manage.py shell --no-startup --no-imports --interface python < /opt/pl/netbox-bootstrap.py
exec /opt/netbox/launch-netbox.sh
