"""Prepare the boot entries of an administrator's original Sergei Strelec UDF disc."""

import base64
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

RECIPE = "strelec-winpe"
EDITIONS = {
    "win11-x64": ("WinPE 11 x64", "strelec11x64.wim", "x64"),
    "win10-x64": ("WinPE 10 x64", "strelec10x64.wim", "x64"),
    "win10-x86": ("WinPE 10 x86", "strelec10.wim", "x86"),
    "win8-x86": ("WinPE 8 x86", "strelec8.wim", "x86"),
}
MANAGERS = {
    "bios": ("bootmgr", "/bootmgr"),
    "uefi-x64": ("bootx64.efi", "/EFI/boot/bootx64.efi"),
}
BOOTMGR = "{9dea862c-5cdd-4e70-acc1-f32b344d4795}"
RAMDISK = "{ae5534e0-a924-466c-b836-758539a3ee3a}"
GUEST = Path(__file__).with_name("strelec")
MAX_BCD = 512 * 1024
MAX_WIM = 2 * 1024**3
RESULT_LIMIT = 8 * 1024**2
GUID = re.compile(r"\{[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}\Z", re.I)
ASSETS = {
    "boot.ipxe",
    "BCD",
    "boot.sdi",
    "bootmgr",
    "bootx64.efi",
    "environment.wim",
    "pecmd.ini",
    "winpeshl.ini",
    "pl-strelec.exe",
    "pl-f12.url",
    "wimboot",
}


def candidate(layout):
    return (
        "UDF" in layout.get("filesystem", "")
        and "strelec" in layout.get("volume", "").lower()
    )


def route(kind):
    if kind == "strelec/menu.ipxe":
        return "", "", "menu.ipxe"
    parts = kind.split("/")
    if (
        len(parts) == 4
        and parts[0] == "strelec"
        and parts[1] in MANAGERS
        and parts[2] in EDITIONS
        and parts[3] in ASSETS
    ):
        return tuple(parts[1:])
    return None


def menu_script(base, profile):
    lines = [
        "#!ipxe",
        "iseq ${platform} pcbios && goto bios ||",
        "iseq ${platform} efi && iseq ${buildarch} x86_64 && goto uefi-x64 || exit",
    ]
    for mode, editions in profile["options"].items():
        lines.extend([f":{mode}", "menu WinPE Sergei Strelec"])
        for key in editions:
            lines.append(f"item {key} {EDITIONS[key][0]}")
        lines.extend(
            [
                "item back Back to PL F12",
                "choose edition || exit",
                "iseq ${edition} back && exit ||",
                "chain " + base + "/strelec/" + mode + "/${edition}/boot.ipxe || exit",
                "exit",
            ]
        )
    return ("\n".join(lines) + "\n").encode("ascii")


def boot_script(base, profile, firmware, edition):
    prefix = f"{base}/strelec/{firmware}/{edition}"
    manager = MANAGERS[firmware][0]
    archive_name = EDITIONS[edition][1]
    index = profile["files"][edition][2]
    lines = [
        "#!ipxe",
        "imgfree",
        f"kernel --name wimboot {prefix}/wimboot rawbcd gui index={index} || exit",
    ]
    for name in (
        manager,
        "BCD",
        "boot.sdi",
        "pecmd.ini",
        "pl-strelec.exe",
        "pl-f12.url",
    ):
        lines.append(f"initrd --name {name} {prefix}/{name} {name} || exit")
    lines += [
        f"initrd --name {archive_name} {prefix}/environment.wim {archive_name} || exit",
        "boot wimboot || exit",
    ]
    return ("\n".join(lines) + "\n").encode("ascii")


def inspect_profile(file, layout, stage):
    if not candidate(layout):
        return None
    # Parse optical and registry data off the HTTP worker under explicit resource limits.
    fd = file.fileno()
    cmd = [
        sys.executable,
        "-B",
        str(Path(__file__).resolve()),
        f"/dev/fd/{fd}",
        str(Path(stage).resolve()),
    ]
    try:
        result = subprocess.run(cmd, pass_fds=(fd,), capture_output=True, timeout=150)
    except subprocess.TimeoutExpired as err:
        raise TimeoutError(
            "Истекло время проверки загрузочных файлов Стрельца."
        ) from err
    if result.returncode or len(result.stdout) > RESULT_LIMIT:
        raise OSError("Не удалось проверить загрузочные файлы Стрельца.")
    return json.loads(result.stdout)


def contiguous_extent(disc, path, size, limit):
    record = disc.get_record(udf_path=path)
    if len(disc.udf_main_descs.partitions) != 1 or disc.logical_block_size != 2048:
        raise ValueError("Unsupported UDF geometry")
    length = record.get_data_length()
    if (
        record.is_dir()
        or not 0 < length <= limit
        or not 0 < len(record.alloc_descs) <= 128
    ):
        raise ValueError("Unexpected UDF file shape")
    partition = disc.udf_main_descs.partitions[0].part_start_location
    start = (partition + record.alloc_descs[0].log_block_num) * 2048
    position = start
    for ad in record.alloc_descs:
        if (
            ad.extent_type
            or getattr(ad, "offset", 0)
            or getattr(ad, "part_ref_num", 0)
            or position != (partition + ad.log_block_num) * 2048
            or ad.extent_length <= 0
        ):
            raise ValueError("Non-contiguous or unrecorded UDF file")
        position += ad.extent_length
    if (
        position < start + length
        or position > size
        or position - start - length >= 2048
    ):
        raise ValueError("UDF extent outside the original image")
    return start, length


def read_bytes(file, extent, limit):
    offset, length = extent[:2]
    file.seek(offset)
    return file.read(min(length, limit))


def boot_index(file, extent):
    header = read_bytes(file, extent, 208)
    if (
        len(header) != 208
        or header[:8] != b"MSWIM\0\0\0"
        or header[40:44] != b"\x01\0\x01\0"
    ):
        return 0
    index = struct.unpack_from("<I", header, 120)[0]
    count = struct.unpack_from("<I", header, 44)[0]
    return index if 1 <= index <= count <= 32 else 0


def network_startup(original):
    if not original:
        return None
    lines = original.splitlines(keepends=True)
    positions = {}
    for index, line in enumerate(lines):
        command = re.fullmatch(
            rb"exec\s+([=!*@]+)%windir%\\system32\\([^\\\s]+)(?:\s+(.*))?",
            line.strip().lower(),
        )
        if not command:
            continue
        flags, program, args = command.groups()
        if program == b"network_start.cmd":
            positions.setdefault("network", []).append(index)
        elif b"=" in flags:
            if program == b"driverindexer.exe" and (args or b"").startswith(
                b"install "
            ):
                positions.setdefault("drivers", []).append(index)
            elif (
                program in (b"letterswap.exe", b"letterswap_x64.exe")
                and args == b"/auto"
            ):
                positions.setdefault("letters", []).append(index)
            elif program == b"setting.bat":
                positions.setdefault("settings", []).append(index)
    network = positions.get("network", [])
    drivers = positions.get("drivers", [])
    letters = positions.get("letters", [])
    settings = positions.get("settings", [])
    if not (
        len(network) == len(letters) == len(settings) == 1
        and drivers
        and network[0] < drivers[0] <= drivers[-1] < letters[0] < settings[0]
    ):
        return None
    after = letters[0] + 1
    newline = b"\r\n" if lines[after - 1].endswith(b"\r\n") else b"\n"
    # Wait for the original NIC drivers and drive-letter assignment before exposing SSTR.
    lines[after:after] = [
        rb"EXEC !=%WinDir%\System32\wpeutil.exe InitializeNetwork" + newline,
        rb"EXEC !=%WinDir%\System32\pl-strelec.exe" + newline,
    ]
    return b"".join(lines)


def edition_startup(file, extent, index, arch, stage):
    from winpe_profile import wim_member

    offset, length = extent
    if shutil.disk_usage(stage).free < length + 128 * 1024**2:
        raise OSError("Недостаточно места для проверки среды Стрельца.")
    file.seek(offset)
    with tempfile.NamedTemporaryFile(
        dir=stage, prefix="inspect-winpe-", suffix=".wim"
    ) as wim:
        remaining = length
        while remaining:
            block = file.read(min(2 * 1024**2, remaining))
            if not block:
                raise ValueError("Short optical file")
            wim.write(block)
            remaining -= len(block)
        wim.flush()
        ini = wim_member(wim.name, index, "/Windows/System32/winpeshl.ini", 4096)
        if not ini:
            return None
        commands = [line.strip().lower() for line in ini.splitlines() if line.strip()]
        if commands not in (
            [b"[launchapps]", b"wpeinit.exe"],
            [b"[launchapps]", rb"%systemroot%\system32\wpeinit.exe"],
        ):
            return None
        startup = network_startup(
            wim_member(wim.name, index, "/Windows/System32/Pecmd.ini", 128 * 1024)
        )
        if not startup:
            return None
        processor = "amd64" if arch == "x64" else "i386"
        required = (
            "winhttp.dll",
            "wpeinit.exe",
            "wpeutil.exe",
            "Pecmd.exe",
            "imdisk/imdisk.inf",
            f"imdisk/cli/{processor}/imdisk.exe",
            f"imdisk/sys/{processor}/imdisk.sys",
        )
        for name in required:
            cmd = [
                "wimdir",
                wim.name,
                str(index),
                "--one-file-only",
                "--path=/Windows/System32/" + name,
            ]
            if subprocess.run(
                cmd,
                env={**os.environ, "WIMLIB_IMAGEX_IGNORE_CASE": "1"},
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=12,
            ).returncode:
                return None
    return base64.b64encode(startup).decode("ascii")


def element(hive, objects, object_id, code):
    node = objects
    for child in (object_id, "Elements", code):
        node = hive.node_get_child(node, child)
        if not node:
            raise ValueError("Missing BCD element")
    value = hive.node_get_value(node, "Element")
    if not value:
        raise ValueError("Missing BCD value")
    kind, data = hive.value_value(value)
    return node, kind, data


def set_element(hive, node, kind, data):
    hive.node_set_value(node, {"key": "Element", "t": kind, "value": data})


def edition_bcd(source, target, filename):
    import hivex

    hive = hivex.Hivex(str(source), write=True)
    objects = hive.node_get_child(hive.root(), "Objects")
    order, order_type, data = element(hive, objects, BOOTMGR, "24000001")
    if order_type != 7 or len(data) > 8192:
        raise ValueError("Unexpected boot manager display order")
    candidates = data.decode("utf-16le").rstrip("\0").split("\0")
    old = ("\\SSTR\\" + filename + "\0").encode("utf-16le")
    new = ("\\Boot\\" + filename + "\0").encode("utf-16le")
    for guid in candidates:
        if not GUID.fullmatch(guid):
            continue
        try:
            refs = [
                element(hive, objects, guid, code) for code in ("11000001", "21000001")
            ]
        except ValueError:
            continue
        if all(kind == 3 and raw.count(old) == 1 for _, kind, raw in refs):
            break
    else:
        return None
    for node, kind, raw in refs:
        set_element(hive, node, kind, raw.replace(old, new))
    ramdisk, kind, data = element(hive, objects, RAMDISK, "32000004")
    if kind != 1 or data.decode("utf-16le").rstrip("\0").lower() != r"\sstr\boot.sdi":
        raise ValueError("Unexpected BCD ramdisk")
    set_element(hive, ramdisk, 1, "\\Boot\\boot.sdi\0".encode("utf-16le"))
    default, kind, _ = element(hive, objects, BOOTMGR, "23000003")
    timeout, timeout_type, clock = element(hive, objects, BOOTMGR, "25000004")
    if kind != 1 or timeout_type != 3 or len(clock) != 8:
        raise ValueError("Unexpected BCD default entry")
    set_element(hive, default, kind, (guid + "\0").encode("utf-16le"))
    set_element(hive, order, order_type, (guid + "\0\0").encode("utf-16le"))
    set_element(hive, timeout, timeout_type, bytes(8))
    hive.commit(str(target))
    if not 0 < target.stat().st_size <= MAX_BCD:
        raise ValueError("Generated BCD is too large")
    return base64.b64encode(target.read_bytes()).decode("ascii")


def optical_profile(iso, stage):
    import pycdlib
    from pycdlib.pycdlibexception import PyCdlibInvalidInput, PyCdlibInvalidISO

    size = iso.stat().st_size
    disc = pycdlib.PyCdlib()
    try:
        with iso.open("rb") as file:
            disc.open_fp(file)

            def extent(path, maximum):
                return contiguous_extent(disc, path, size, maximum)

            info = read_bytes(file, extent("/SSTR/VERSION INFO", 4096), 4096)
            if (
                b"sergei strelec" not in info.lower()
                or b"sergeistrelec.name" not in info.lower()
            ):
                return None
            if (
                read_bytes(file, extent("/SSTR/MInst/MInst.exe", 128 * 1024**2), 2)
                != b"MZ"
            ):
                return None
            files = {"boot.sdi": extent("/SSTR/boot.sdi", 16 * 1024**2)}
            if read_bytes(file, files["boot.sdi"], 8) != b"$SDI0001":
                return None
            startup = {}
            for name, (_, wim, arch) in EDITIONS.items():
                try:
                    part = extent("/SSTR/" + wim, MAX_WIM)
                except PyCdlibInvalidInput:
                    continue
                index = boot_index(file, part)
                prepared = (
                    edition_startup(file, part, index, arch, stage) if index else None
                )
                if prepared:
                    files[name] = [*part, index]
                    startup[name] = prepared
            configs = {}
            options = {}
            with tempfile.TemporaryDirectory() as temporary:
                source = Path(temporary) / "source.bcd"
                target = Path(temporary) / "boot.bcd"
                for mode, (manager, path) in MANAGERS.items():
                    files[manager] = extent(path, 8 * 1024**2)
                    bcd = extent(
                        "/SSTR/BCD" if mode == "bios" else "/EFI/microsoft/boot/BCD",
                        MAX_BCD,
                    )
                    source.write_bytes(read_bytes(file, bcd, MAX_BCD))
                    editions = []
                    for name, (_, wim, arch) in EDITIONS.items():
                        if name not in files or (mode == "uefi-x64" and arch != "x64"):
                            continue
                        target.unlink(missing_ok=True)
                        data = edition_bcd(source, target, wim)
                        if data:
                            editions.append(name)
                            configs[mode + "/" + name] = data
                    if not editions:
                        return None
                    options[mode] = editions
            return {
                "files": files,
                "options": options,
                "startup": startup,
                "bcd": configs,
            }
    except (PyCdlibInvalidInput, PyCdlibInvalidISO, ValueError):
        return None
    finally:
        disc.close()


if __name__ == "__main__":
    import resource

    resource.setrlimit(resource.RLIMIT_AS, (384 * 1024**2, 384 * 1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (75, 80))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_WIM, MAX_WIM))
    print(json.dumps(optical_profile(Path(sys.argv[1]), Path(sys.argv[2]))))
