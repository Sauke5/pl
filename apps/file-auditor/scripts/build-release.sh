#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ( "$1" != primary && "$1" != secondary ) ]]; then
  printf 'Usage: %s primary|secondary\n' "$0" >&2
  exit 2
fi

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
target="$1"
case "$target" in
  primary) base='/audit/' ;;
  secondary) base='/audit-arch/' ;;
esac

dotnet_bin="${DOTNET_BIN:-dotnet}"
npm_bin="${NPM_BIN:-npm}"
web_dir="$project_root/src/Auditor.Web"
api_dir="$project_root/src/Auditor.Api"
output_dir="$project_root/artifacts/release/$target"

(
  cd "$web_dir"
  "$npm_bin" ci
  "$npm_bin" run lint
  AUDITOR_APP_BASE="$base" "$npm_bin" run build
)

rm -rf "$api_dir/wwwroot"
mkdir -p "$api_dir/wwwroot"
cp -R "$web_dir/dist/." "$api_dir/wwwroot/"

if [[ ! -f "$api_dir/wwwroot/index.html" ]] || ! grep -Fq "${base}assets/" "$api_dir/wwwroot/index.html"; then
  printf 'Frontend base or index.html is incorrect for %s\n' "$target" >&2
  exit 1
fi

rm -rf "$output_dir"
"$dotnet_bin" publish "$api_dir/Auditor.Api.csproj" \
  -c Release -r win-x64 --self-contained true -o "$output_dir" \
  -p:DebugType=None -p:DebugSymbols=false

mkdir -p "$output_dir/scripts"
cp "$project_root/scripts/Uninstall-Auditor.ps1" "$output_dir/scripts/"
cp "$project_root/docs/uninstall.md" "$output_dir/UNINSTALL.md"

python3 - "$output_dir" "$target" <<'PY'
from pathlib import Path
import json
import sys

root = Path(sys.argv[1])
target = sys.argv[2]
expected_base = '/audit/' if target == 'primary' else '/audit-arch/'
assert (root / 'Auditor.Api.exe').is_file()
index = (root / 'wwwroot/index.html').read_text()
assert expected_base + 'assets/' in index
runtime = json.loads((root / 'Auditor.Api.runtimeconfig.json').read_text())['runtimeOptions']
assert runtime['tfm'] == 'net10.0'
assert any(item['name'] == 'Microsoft.AspNetCore.App' and item['version'].startswith('10.') for item in runtime['includedFrameworks'])
assert not list(root.glob('appsettings*.json')), 'Production settings belong to the target server'
assert (root / 'scripts/Uninstall-Auditor.ps1').is_file()
assert (root / 'UNINSTALL.md').is_file()
print(f'{target}: {root} ({len(list(root.rglob("*")))} entries, self-contained .NET 10)')
PY
