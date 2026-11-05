#!/bin/sh
# Reproduce upstream scripts/compress_assets.sh for verified official UI assets.
set -eu
cd /src/web/ui
cp embed.go.tmpl embed.go
find static -type f -name '*.gz' -delete
find static -type f | LC_ALL=C sort | while IFS= read -r asset; do
    gzip -n -c "$asset" > "$asset.gz"
done
find static -type f -name '*.gz' | LC_ALL=C sort | while IFS= read -r asset; do
    printf '//go:embed %s\n' "$asset"
done >> embed.go
printf '\nvar EmbedFS embed.FS\n' >> embed.go
