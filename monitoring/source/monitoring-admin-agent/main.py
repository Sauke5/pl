#!/usr/bin/env python3
from __future__ import annotations

import logging
import os
import socket
import sys

from agent.docker import DockerClient
from agent.http import AgentHTTPServer


SD_LISTEN_FDS_START = 3


def inherited_systemd_socket() -> socket.socket:
    if os.environ.get("LISTEN_PID") != str(os.getpid()):
        raise RuntimeError("agent must be started by systemd socket activation")
    if os.environ.get("LISTEN_FDS") != "1":
        raise RuntimeError("exactly one systemd socket is required")
    inherited = socket.fromfd(SD_LISTEN_FDS_START, socket.AF_UNIX, socket.SOCK_STREAM)
    inherited.set_inheritable(False)
    return inherited


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stdout,
    )
    server = AgentHTTPServer(inherited_systemd_socket(), DockerClient())
    logging.getLogger("monitoring-admin-agent").info("agent started transport=unix")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
