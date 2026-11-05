#!/bin/sh
set -eu
umask 077
stage=configuration
trap 'startup_status=$?; if [ "$startup_status" -ne 0 ]; then printf "Gitea startup failed at %s; inspect private bootstrap receipts\n" "$stage" >&2; fi' 0
mkdir -p /var/lib/gitea/custom/conf /var/lib/gitea/data /var/lib/gitea/pl-bootstrap
# Gitea persists INTERNAL_TOKEN and other native settings in this owned copy.
# The read-only installation seed must not replace it on later starts.
config=/var/lib/gitea/custom/conf/app.ini
if [ -L "$config" ] || { [ -e "$config" ] && [ ! -f "$config" ]; }; then
 exit 1
fi
if [ ! -f "$config" ]; then
 rm -f "$config.pending"
 cp /run/secrets/gitea.ini "$config.pending"
 chmod 0600 "$config.pending"
 mv "$config.pending" "$config"
fi
chmod 0600 "$config"
command_gitea() { /usr/local/bin/gitea --work-path /var/lib/gitea --config /var/lib/gitea/custom/conf/app.ini "$@"; }
stage=database-migration
# Drain all output without SIGPIPE or a file-size limit on the migration itself.
# Retain the last 64 KiB in a private receipt and preserve the native exit code.
migration_status=/var/lib/gitea/pl-bootstrap/migrate.status
migration_log=/var/lib/gitea/pl-bootstrap/migrate.log
if [ -L "$migration_log" ] || { [ -e "$migration_log" ] && [ ! -f "$migration_log" ]; }; then
 exit 1
fi
if [ -f "$migration_log" ]; then chmod 0600 "$migration_log"; fi
rm -f "$migration_status"
(
 migration_exit=0
 command_gitea migrate || migration_exit=$?
 printf '%s\n' "$migration_exit" > "$migration_status"
) 2>&1 | tail -c 65536 > "$migration_log"
IFS= read -r migration_exit < "$migration_status"
rm -f "$migration_status"
case "$migration_exit" in ''|*[!0-9]*) exit 1 ;; esac
if [ "$migration_exit" -ne 0 ]; then
 exit "$migration_exit"
fi
stage=administrator-bootstrap
if [ ! -f /var/lib/gitea/pl-bootstrap/admin ]; then
 if command_gitea admin user create --username pl-admin --email admin@localhost --admin --random-password --random-password-length 8 --must-change-password=false > /var/lib/gitea/pl-bootstrap/admin.pending 2>&1; then :; else
  exit "$?"
 fi
 chmod 0444 /var/lib/gitea/pl-bootstrap/admin.pending
 mv /var/lib/gitea/pl-bootstrap/admin.pending /var/lib/gitea/pl-bootstrap/admin
fi
stage=collector-bootstrap
if [ ! -f /var/lib/gitea/pl-bootstrap/collector ]; then
 if command_gitea admin user create --username pl-collector --email collector@localhost --user-type Bot --access-token --access-token-name pl-oxidized --access-token-scopes write:repository,write:user > /var/lib/gitea/pl-bootstrap/collector.pending 2>&1; then :; else
  exit "$?"
 fi
 chmod 0444 /var/lib/gitea/pl-bootstrap/collector.pending
 mv /var/lib/gitea/pl-bootstrap/collector.pending /var/lib/gitea/pl-bootstrap/collector
fi
chmod 0755 /var/lib/gitea/pl-bootstrap
stage=web
exec /usr/local/bin/gitea --work-path /var/lib/gitea --config /var/lib/gitea/custom/conf/app.ini web
