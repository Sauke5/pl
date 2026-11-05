#!/bin/sh
set -eu
exec valkey-server /run/secrets/cache.conf
