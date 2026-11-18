"""Bounded inspection of 2048-byte optical media. No mounting or execution."""

import struct

SECTOR = 2048


def little_u16(data, offset):
    return struct.unpack_from("<H", data, offset)[0]


def little_u32(data, offset):
    return struct.unpack_from("<I", data, offset)[0]


def both_endian(data, pos, size):
    little = int.from_bytes(data[pos : pos + size], "little")
    return (
        little
        if little == int.from_bytes(data[pos + size : pos + 2 * size], "big")
        else -1
    )


def inspect_iso(file, size):
    quantity = size // SECTOR
    if quantity < 18:
        raise ValueError("Файл слишком мал для полного ISO.")

    def read_sector(index):
        if not 0 <= index < quantity:
            return b""
        file.seek(index * SECTOR)
        return file.read(SECTOR)

    pvd = None
    catalog = 0
    udf_tag = False
    end = False
    for index in range(16, min(quantity, 272)):
        block = read_sector(index)
        if len(block) != SECTOR:
            break
        if block[1:6] in (b"NSR02", b"NSR03"):
            udf_tag = True
        if block[1:6] != b"CD001" or block[6] != 1:
            continue
        if block[0] == 1 and pvd is None:
            pvd = block
        elif (
            block[0] == 0 and block[7:39].rstrip(b" \x00") == b"EL TORITO SPECIFICATION"
        ):
            catalog = little_u32(block, 71)
        elif block[0] == 255:
            end = True
    udf = False
    if udf_tag:
        for index in (256, quantity - 257, quantity - 1):
            anchor = read_sector(index)
            if (
                len(anchor) != SECTOR
                or little_u16(anchor, 0) != 2
                or little_u32(anchor, 12) != index
            ):
                continue
            if anchor[4] != sum(anchor[:4] + anchor[5:16]) % 256:
                continue
            length = little_u32(anchor, 16) & 0x3FFFFFFF
            lba = little_u32(anchor, 20)
            if length and lba and lba * SECTOR + length <= size:
                udf = True
                break
    if pvd:
        blocks = both_endian(pvd, 80, 4)
        block_size = both_endian(pvd, 128, 2)
        if not end or block_size != SECTOR or blocks < 18 or blocks * SECTOR > size:
            raise ValueError("Файл обрезан или геометрия ISO9660 повреждена.")
        if pvd[156] < 34 or not pvd[181] & 2:
            raise ValueError("В ISO9660 отсутствует корневой каталог.")
        root = both_endian(pvd, 158, 4)
        root_length = both_endian(pvd, 166, 4)
        if (
            root < 1
            or root_length < 34
            or root * SECTOR + root_length > blocks * SECTOR
        ):
            raise ValueError("Корневой каталог выходит за границы ISO.")
        first = read_sector(root)
        if len(first) != SECTOR or first[0] < 34 or first[32:34] != b"\x01\x00":
            raise ValueError("Корневой каталог ISO9660 повреждён.")
        label = pvd[40:72].decode("ascii", "replace").rstrip(" \x00")
    elif udf:
        blocks = quantity
        label = ""
    else:
        raise ValueError("Файл не содержит целого образа ISO9660 или UDF.")
    bios = False
    if 0 < catalog < blocks:
        block = read_sector(catalog)
        if (
            len(block) == SECTOR
            and block[0] == 1
            and block[30:32] == b"\x55\xaa"
            and sum(struct.unpack("<16H", block[:32])) % 65536 == 0
        ):

            def bios_boot_entry(pos):
                if pos + 32 > len(block) or block[pos] != 0x88 or block[pos + 1] > 4:
                    return False
                lba = little_u32(block, pos + 8)
                count = little_u16(block, pos + 6)
                return (
                    lba > 0
                    and count > 0
                    and lba * SECTOR + count * 512 <= blocks * SECTOR
                )

            bios = block[1] == 0 and bios_boot_entry(32)
            pos = 64
            while not bios and pos + 32 <= SECTOR and block[pos] in (0x90, 0x91):
                platform = block[pos + 1]
                entries = little_u16(block, pos + 2)
                pos += 32
                if entries < 1 or pos + entries * 32 > SECTOR:
                    break
                if platform == 0:
                    bios = any(bios_boot_entry(pos + i * 32) for i in range(entries))
                pos += entries * 32
    root_entries = iso_directory(file, blocks, root, root_length) if pvd else {}
    return {
        "filesystem": "ISO9660/UDF" if pvd and udf else "ISO9660" if pvd else "UDF",
        "volume": label,
        "bios": bios,
        "casper": casper_assets(file, blocks, root_entries)
        if pvd and "ubuntu" in label.lower()
        else {},
        "hirens": hirens_media(file, blocks, root_entries),
    }


def iso_directory(file, blocks, lba, length):
    if length > 2 * 1024**2 or lba < 1 or lba * SECTOR + length > blocks * SECTOR:
        return {}
    file.seek(lba * SECTOR)
    data = file.read(length)
    position = 0
    found = {}
    multipart = set()
    while position < len(data):
        record_length = data[position]
        if not record_length:
            position = (position // SECTOR + 1) * SECTOR
            continue
        record = data[position : position + record_length]
        position += record_length
        if (
            len(record) < 34
            or len(record) != record_length
            or record[32] + 33 > len(record)
        ):
            return {}
        name_length = record[32]
        iso_name = record[33 : 33 + name_length]
        name = iso_name.decode("ascii", "replace").split(";")[0].rstrip(".").lower()
        field = 33 + name_length + (name_length % 2 == 0)
        rock_ridge_name = []
        while field + 4 <= len(record):
            field_length = record[field + 2]
            if field_length < 4 or field + field_length > len(record):
                break
            if record[field : field + 2] == b"NM" and field_length >= 5:
                rock_ridge_name.append(record[field + 5 : field + field_length])
            field += field_length
        if rock_ridge_name:
            name = b"".join(rock_ridge_name).decode("utf-8", "replace").lower()
        if record[25] & 0x80:
            multipart.add(name)
            found.pop(name, None)
        extent = both_endian(record, 2, 4)
        size = both_endian(record, 10, 4)
        if (
            extent > 0
            and size > 0
            and extent * SECTOR + size <= blocks * SECTOR
            and record[1] == 0
            and record[26:28] == b"\0\0"
            and name not in multipart
        ):
            found[name] = (extent, size, bool(record[25] & 2))
    return found


def hirens_media(file, blocks, root):
    """Find the WIM of a Hiren's PE medium independently of its ISO filename."""
    config = root.get("hbcd_pe.ini")
    programs = root.get("programs")
    if not config or config[2] or not programs or not programs[2]:
        return None

    def contents(entries, name):
        folder = entries.get(name)
        if folder and folder[2]:
            return iso_directory(file, blocks, *folder[:2])
        return {}

    wim = contents(root, "sources").get("boot.wim")
    loader = contents(contents(root, "efi"), "boot").get("bootx64.efi")
    if not wim or wim[2] or wim[1] < 208 or not loader or loader[2] or loader[1] < 64:
        return None
    file.seek(loader[0] * SECTOR)
    dos = file.read(64)
    pe_offset = little_u32(dos, 60)
    if dos[:2] != b"MZ" or not 64 <= pe_offset <= loader[1] - 6:
        return None
    file.seek(loader[0] * SECTOR + pe_offset)
    if file.read(6) != b"PE\0\0\x64\x86":
        return None
    offset = wim[0] * SECTOR
    file.seek(offset)
    header = file.read(208)
    if header[:8] != b"MSWIM\0\0\0" or header[40:44] != b"\x01\0\x01\0":
        return None
    boot_index = little_u32(header, 120)
    if not 1 <= boot_index <= little_u32(header, 44):
        return None
    return offset, wim[1], boot_index


def casper_assets(file, blocks, root_entries):
    folder = root_entries.get("casper")
    if not folder or not folder[2]:
        return {}
    entries = iso_directory(file, blocks, *folder[:2])
    kernel = entries.get("vmlinuz") or entries.get("vmlinuz.efi")
    initrd = (
        entries.get("initrd") or entries.get("initrd.lz") or entries.get("initrd.gz")
    )
    if not kernel or not initrd or kernel[2] or initrd[2]:
        return {}
    if kernel[1] < 0x206 or initrd[1] < 8:
        return {}
    file.seek(kernel[0] * SECTOR + 0x202)
    if file.read(4) != b"HdrS":
        return {}
    file.seek(initrd[0] * SECTOR)
    magic = file.read(8)
    if not any(
        magic.startswith(sig)
        for sig in (
            b"070701",
            b"070702",
            b"\x1f\x8b",
            b"\xfd7zXZ",
            b"\x04\x22\x4d\x18",
            b"\x28\xb5\x2f\xfd",
            b"\x02\x21\x4c\x18",
        )
    ):
        return {}
    for key, (lba, size, isdir) in entries.items():
        if key.endswith(".squashfs") and not isdir and size >= 96:
            file.seek(lba * SECTOR)
            if file.read(4) == b"hsqs":
                return {
                    "kernel": (kernel[0] * SECTOR, kernel[1]),
                    "initrd": (initrd[0] * SECTOR, initrd[1]),
                }
    return {}


def menu_label(text):
    return (
        "".join(c if c.isalnum() or c in " ._-()+" else " " for c in text).strip()
        or "ISO"
    )
