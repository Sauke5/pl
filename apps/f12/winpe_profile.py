"""Inspect the boot image before attaching the original Hiren's medium in WinPE."""

import errno
import os
import select
import shutil
import subprocess
import tempfile
import time

HIRENS_RECIPE = "hirens-winpe-x64"
GUEST_FILES = ("winpeshl.ini", "pl-f12.cmd", "F12Media.cs", "pl-f12.url")
WIM_ENV = {**os.environ, "WIMLIB_IMAGEX_IGNORE_CASE": "1"}
WIM_TOOLS = (
    "/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
    "/Windows/System32/drivers/imdisk.sys",
    "/Windows/System32/imdisk.exe",
    "/Windows/System32/winpeshl.exe",
    "/Windows/System32/wpeinit.exe",
    "/Windows/System32/wpeutil.exe",
    "/Windows/System32/Pecmd.exe",
    "/Windows/explorer.exe",
)


def wim_member(wim, index, name, limit):
    # Read only small startup files. Stop the decompressor on oversized output.
    args = ["wimextract", wim, str(index), name, "--to-stdout", "--no-globs"]
    with subprocess.Popen(
        args,
        env=WIM_ENV,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    ) as proc:
        deadline = time.monotonic() + 30
        result = bytearray()
        try:
            while len(result) <= limit:
                remaining = deadline - time.monotonic()
                if (
                    remaining <= 0
                    or not select.select([proc.stdout], [], [], remaining)[0]
                ):
                    raise TimeoutError("WIM startup inspection timed out")
                part = os.read(proc.stdout.fileno(), min(8192, limit + 1 - len(result)))
                if not part:
                    status = proc.wait(timeout=max(0.1, deadline - time.monotonic()))
                    return bytes(result) if status == 0 else None
                result.extend(part)
            return None
        finally:
            if proc.poll() is None:
                proc.kill()


def compatible_wim(wim, index):
    launcher = wim_member(wim, index, "/Windows/System32/winpeshl.ini", 4096)
    if not launcher or [
        line.strip().lower() for line in launcher.splitlines() if line.strip()
    ] != [b"[launchapps]", b"wpeinit.exe"]:
        return False
    startup = wim_member(wim, index, "/Windows/System32/pecmd.ini", 128 * 1024)
    if not startup:
        return False
    commands = [line.strip().lower() for line in startup.splitlines() if line.strip()]
    launchers = {
        rb"exec @!%windir%\system32\winpeshl.exe",
        rb"exec !=%windir%\system32\winpeshl.exe",
    }
    mounts_original = any(
        line.startswith(rb"exec =@!%windir%\system32\letterswap.exe ")
        and rb" /setletter y:\hbcd_pe.ini " in line + b" "
        for line in commands
    )
    if (
        launchers.isdisjoint(commands)
        or rb"shel %windir%\explorer.exe" not in commands
        or not mounts_original
    ):
        return False
    for tool in WIM_TOOLS:
        check = subprocess.run(
            ["wimdir", wim, str(index), "--one-file-only", "--path=" + tool],
            env=WIM_ENV,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
            check=False,
        )
        if check.returncode:
            return False
    return True


def wim_reference(file, candidate, stage, reserve):
    if not candidate:
        return ""
    offset, length, index = candidate
    if shutil.disk_usage(stage).free < length + reserve:
        raise OSError(
            errno.ENOSPC, "Недостаточно места для проверки загрузочной среды Windows."
        )
    # wimlib resolves a real pathname before reading. The scratch copy exists only
    # during inspection. Boot clients later read the original ISO extent.
    with tempfile.NamedTemporaryFile(
        dir=stage, prefix="inspect-winpe-", suffix=".wim"
    ) as wim:
        file.seek(offset)
        remaining = length
        while remaining:
            chunk = file.read(min(1024 * 1024, remaining))
            if not chunk:
                raise ValueError("Файл загрузочной среды Windows обрезан.")
            wim.write(chunk)
            remaining -= len(chunk)
        wim.flush()
        try:
            compatible = compatible_wim(wim.name, index)
        except subprocess.TimeoutExpired as err:
            raise TimeoutError("WIM inspection timed out") from err
    return f"extent:{offset}:{length}" if compatible else ""
