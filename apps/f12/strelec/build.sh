#!/bin/sh
set -eu

out=${1:?output directory required}
src=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$out"
build() {
  "$1" -std=c11 -Os -Wall -Wextra -Werror -municode -mwindows -static-libgcc \
    -DUNICODE -D_UNICODE -D_WIN32_WINNT=0x0601 -D__USE_MINGW_ANSI_STDIO=1 \
    -Wl,--no-insert-timestamp,--nxcompat,--dynamicbase -s \
    "$src/media.c" "$src/iso_http.c" -o "$out/pl-strelec-$2.exe" -lwinhttp -ladvapi32
}
build "${CC32:-i686-w64-mingw32-gcc}" x86
build "${CC64:-x86_64-w64-mingw32-gcc}" x64
