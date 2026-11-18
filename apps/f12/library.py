"""Persistent F12 image catalogue and segment-specific iPXE recipes."""

import base64
import contextlib
import hashlib
import json
import logging
import sqlite3
import threading
import unicodedata
from pathlib import Path
from urllib.parse import unquote

from bootimus import DISK_RESERVE, BootError, prepare
from media import inspect_iso, menu_label
import strelec_media
from winpe_profile import GUEST_FILES, HIRENS_RECIPE, wim_reference

PROFILE_REVISION = 3
RECIPES = {
    "ubuntu-casper": "Ubuntu Live · Casper по HTTP",
    "tinycore-http": "TinyCore · ядро и initrd по HTTP",
    "systemrescue-http": "SystemRescue · среда для восстановления дисков",
    HIRENS_RECIPE: "Hiren’s BootCD PE · UEFI x64",
    strelec_media.RECIPE: "WinPE Sergei Strelec · BIOS и UEFI x64",
    "bios-iso": "Загрузочная запись Legacy BIOS · пробный запуск ISO",
    "library": "Поддерживаемый способ загрузки не найден",
}


def menu_firmware(recipe):
    if recipe == "bios-iso":
        return ("bios",)
    if recipe == HIRENS_RECIPE:
        return ("uefi-x64",)
    if recipe in (
        "ubuntu-casper",
        "systemrescue-http",
        "tinycore-http",
        strelec_media.RECIPE,
    ):
        return ("bios", "uefi-x64")
    return ()


def selected_segments(values, choices):
    if not isinstance(values, list) or any(
        not isinstance(x, str) or x not in choices for x in values
    ):
        raise BootError(400, "Выберите сеть публикации.")
    return sorted(set(values))


def assign_networks(db, ident, nets):
    db.execute("delete from visible where image=?", (ident,))
    db.executemany(
        "insert into visible(image,segment) values (?,?)", [(ident, n) for n in nets]
    )


def image_metadata(db, image):
    networks = db.execute(
        "SELECT segment FROM visible WHERE image=? ORDER BY segment", (image["id"],)
    )
    return {
        "id": image["id"],
        "name": image["name"],
        "size": image["size"],
        "recipe": image["recipe"],
        "compatibility": RECIPES[image["recipe"]],
        "filesystem": image["filesystem"],
        "segments": [row[0] for row in networks],
    }


def render_menu(images, address, port=8080):
    """Embed only a segment's assigned images and its own serving address."""
    images = [row for row in images if menu_firmware(row["recipe"])]
    lines = ["#!ipxe", ":pl-menu", "menu PL F12"]
    uefi_x64 = "iseq ${platform} efi && iseq ${buildarch} x86_64"
    for image in images:
        item = f"item i{image['id']} {menu_label(image['name'])}"
        if image["recipe"] == "bios-iso":
            item = "iseq ${platform} pcbios && " + item + " ||"
        elif image["recipe"] == HIRENS_RECIPE:
            item = uefi_x64 + " && " + item + " ||"
        lines.append(item)

    lines.extend(
        [
            "item local Local disk",
            "choose entry || exit",
            "goto ${entry}",
            ":local",
            "exit",
        ]
    )
    for image in images:
        base = f"http://{address}:{port}/media/{image['id']}"
        lines.append(":i" + image["id"])
        if image["recipe"] == strelec_media.RECIPE:
            lines.extend([f"chain {base}/strelec/menu.ipxe ||", "goto pl-menu"])
            continue
        if image["recipe"] == HIRENS_RECIPE:
            lines.extend(
                [
                    uefi_x64 + " || exit",
                    "imgfree",
                    f"kernel --name wimboot {base}/wimboot gui || exit",
                    *(
                        f"initrd --name {name} {base}/{name} {name} || exit"
                        for name in GUEST_FILES
                    ),
                    f"initrd --name boot.wim {base}/boot.wim boot.wim || exit",
                    "boot wimboot || exit",
                ]
            )
            continue
        if image["recipe"] == "bios-iso":
            lines.extend(
                [
                    "iseq ${platform} pcbios || exit",
                    f"sanboot --no-describe --drive 0x80 {base}/iso || exit",
                    "exit",
                ]
            )
            continue
        if image["recipe"] == "systemrescue-http":
            lines.extend(
                [
                    (
                        f"kernel {base}/kernel initrd=intel.img initrd=amd.img initrd=initrd "
                        f"archisobasedir=sysresccd archiso_http_srv={base}/ checksum ip=dhcp || exit"
                    ),
                    f"initrd --name intel.img {base}/sysresccd/boot/intel_ucode.img || exit",
                    f"initrd --name amd.img {base}/sysresccd/boot/amd_ucode.img || exit",
                    f"initrd --name initrd {base}/initrd || exit",
                    "boot || exit",
                ]
            )
            continue
        if image["recipe"] == "ubuntu-casper":
            # scripts/casper on Ubuntu 24.04.5 matches iso-url=*.iso literally.
            parameters = f"boot=casper ip=dhcp iso-url={base}/image.iso cloud-config-url=/dev/null"
        elif image["recipe"] == "tinycore-http":
            parameters = "quiet base"
        else:
            continue
        lines.extend(
            [
                f"kernel {base}/kernel initrd=initrd {parameters} || exit",
                f"initrd --name initrd {base}/initrd || exit",
                "boot || exit",
            ]
        )
    return ("\n".join(lines) + "\n").encode()


def iso_name(value):
    if not isinstance(value, str):
        raise BootError(400, "Выберите файл ISO.")
    name = unicodedata.normalize("NFC", value)
    if (
        not name.lower().endswith(".iso")
        or len(name) < 5
        or "/" in name
        or "\\" in name
        or any(unicodedata.category(c).startswith("C") for c in name)
        or len(name.encode("utf-8")) > 240
    ):
        raise BootError(400, "Выберите файл ISO с допустимым именем.")
    return name


class Library:
    def __init__(self, path, prepare_image=prepare):
        self.path = Path(path)
        self.prepare_image = prepare_image
        self.import_lock = threading.Lock()

    @contextlib.contextmanager
    def connect(self, read_only=False):
        db = sqlite3.connect(
            self.path.resolve().as_uri() + ("?mode=ro" if read_only else "?mode=rwc"),
            uri=True,
            timeout=15,
        )
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA foreign_keys=ON")
            with db:
                yield db
        finally:
            db.close()

    def initialize(self):
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS image (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL,
                    iso TEXT NOT NULL, kernel TEXT NOT NULL, initrd TEXT NOT NULL,
                    recipe TEXT NOT NULL, filesystem TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS visible (
                    image TEXT NOT NULL REFERENCES image(id), segment TEXT NOT NULL,
                    PRIMARY KEY(image, segment)
                );
                CREATE INDEX IF NOT EXISTS by_segment ON visible(segment, image);
                CREATE TABLE IF NOT EXISTS winpe_media (
                    image TEXT PRIMARY KEY REFERENCES image(id), wim TEXT NOT NULL
                );
                CREATE VIEW IF NOT EXISTS boot_image AS
                    SELECT i.id,i.name,i.size,i.iso,i.kernel,coalesce(w.wim,i.initrd) AS initrd,
                        CASE WHEN w.image IS NULL THEN i.recipe ELSE 'hirens-winpe-x64' END AS recipe,
                        i.filesystem
                    FROM image i LEFT JOIN winpe_media w ON w.image=i.id;
                CREATE TABLE IF NOT EXISTS strelec_media (
                    image TEXT PRIMARY KEY REFERENCES image(id), profile TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS strelec_bcd (
                    image TEXT NOT NULL REFERENCES strelec_media(image), entry TEXT NOT NULL, bcd BLOB NOT NULL,
                    PRIMARY KEY(image,entry)
                );
                CREATE TABLE IF NOT EXISTS optical_profile_check (
                    image TEXT PRIMARY KEY REFERENCES image(id), revision INTEGER NOT NULL
                );
                CREATE VIEW IF NOT EXISTS current_boot_image AS
                    SELECT b.id,b.name,b.size,b.iso,b.kernel,b.initrd,
                        CASE WHEN s.image IS NULL THEN b.recipe ELSE 'strelec-winpe' END AS recipe,b.filesystem
                    FROM boot_image b LEFT JOIN strelec_media s ON s.image=b.id;
            """)

    def images(self):
        with self.connect(True) as db:
            return [
                image_metadata(db, row)
                for row in db.execute(
                    "SELECT * FROM current_boot_image ORDER BY name,id"
                )
            ]

    @staticmethod
    def save_strelec(db, ident, profile):
        db.execute(
            """INSERT INTO strelec_media(image,profile) VALUES (?,?)
            ON CONFLICT(image) DO UPDATE SET profile=excluded.profile""",
            (
                ident,
                json.dumps(
                    {key: profile[key] for key in ("files", "options", "startup")}
                ),
            ),
        )
        db.execute("DELETE FROM strelec_bcd WHERE image=?", (ident,))
        db.executemany(
            "INSERT INTO strelec_bcd(image,entry,bcd) VALUES (?,?,?)",
            [
                (ident, key, base64.b64decode(value, validate=True))
                for key, value in profile["bcd"].items()
            ],
        )

    def strelec_assets(self, ident, segment, entry):
        with self.connect(True) as db:
            row = db.execute(
                """SELECT s.profile,b.bcd FROM strelec_media s
                JOIN visible v ON v.image=s.image LEFT JOIN strelec_bcd b ON b.image=s.image AND b.entry=?
                WHERE s.image=? AND v.segment=?""",
                (entry, ident, segment),
            ).fetchone()
            if not row:
                raise BootError(404, "Образ недоступен.")
            return json.loads(row["profile"]), row["bcd"]

    def refresh_local_profiles(self, stage):
        """Check each legacy import, including images added during a rollback."""
        with self.connect(True) as db:
            rows = db.execute(
                """SELECT i.id,i.iso,i.size,i.recipe FROM current_boot_image i
                LEFT JOIN optical_profile_check c ON c.image=i.id
                WHERE i.recipe IN ('bios-iso','library','strelec-winpe')
                AND coalesce(c.revision,0) < ?""",
                (PROFILE_REVISION,),
            ).fetchall()
        for row in rows:
            try:
                with self.import_lock:
                    name = unquote(row["iso"].removeprefix("/isos/"))
                    if not row["iso"].startswith("/isos/") or iso_name(name) != name:
                        raise ValueError("Invalid saved ISO path")
                    path = self.path.parent / "isos" / name
                    if path.is_symlink() or path.stat().st_size != row["size"]:
                        raise OSError("Saved ISO changed")
                    with path.open("rb") as file:
                        layout = inspect_iso(file, row["size"])
                        candidate = layout.get("hirens")
                        if (
                            candidate
                            or strelec_media.candidate(layout)
                            or row["recipe"] == strelec_media.RECIPE
                        ):
                            file.seek(0)
                            if (
                                hashlib.file_digest(file, "sha256").hexdigest()
                                != row["id"]
                            ):
                                raise ValueError("Saved ISO digest changed")
                        ref = wim_reference(file, candidate, stage, DISK_RESERVE)
                        strelec = strelec_media.inspect_profile(file, layout, stage)
                    with self.connect() as db:
                        if ref:
                            db.execute(
                                "INSERT OR IGNORE INTO winpe_media(image,wim) VALUES (?,?)",
                                (row["id"], ref),
                            )
                        elif strelec:
                            self.save_strelec(db, row["id"], strelec)
                        if row["recipe"] == strelec_media.RECIPE and not strelec:
                            db.execute(
                                "DELETE FROM strelec_bcd WHERE image=?", (row["id"],)
                            )
                            db.execute(
                                "DELETE FROM strelec_media WHERE image=?", (row["id"],)
                            )
                        db.execute(
                            "INSERT OR REPLACE INTO optical_profile_check VALUES (?,?)",
                            (row["id"], PROFILE_REVISION),
                        )
            except (OSError, ValueError, BootError, sqlite3.Error) as err:
                logging.getLogger(__name__).warning(
                    "F12 could not recheck ISO %.12s (%s)",
                    row["id"],
                    type(err).__name__,
                )

    def menu(self, segment):
        with self.connect(True) as db:
            return [
                dict(r)
                for r in db.execute(
                    """SELECT i.id,i.name,i.recipe FROM current_boot_image i
                JOIN visible v ON i.id=v.image WHERE v.segment=? ORDER BY i.name,i.id""",
                    (segment,),
                )
            ]

    def visible_image(self, ident, segment):
        with self.connect(True) as db:
            return db.execute(
                """SELECT i.* FROM current_boot_image i JOIN visible v ON i.id=v.image
                WHERE i.id=? AND v.segment=?""",
                (ident, segment),
            ).fetchone()

    def publish(self, ident, segments):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            image = db.execute(
                "SELECT * FROM current_boot_image WHERE id=?", (ident,)
            ).fetchone()
            if not image:
                raise BootError(404, "Образ не найден.")
            if segments and image["recipe"] == "library":
                raise BootError(
                    422, "У образа пока нет поддерживаемого способа загрузки."
                )
            assign_networks(db, ident, segments)
            return image_metadata(db, image)

    def import_file(self, file, size, ident, name, segments, record=None):
        with self.import_lock:
            with self.connect(True) as db:
                existing = db.execute(
                    "SELECT id FROM image WHERE id=?", (ident,)
                ).fetchone()
            if not existing:
                try:
                    layout = inspect_iso(file, size)
                except ValueError as err:
                    raise BootError(422, str(err)) from None
                strelec = strelec_media.inspect_profile(
                    file, layout, self.path.parent / "staging"
                )
                iso, kernel, initrd, recipe = self.prepare_image(
                    file, size, ident, name, layout
                )
            with self.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                if not existing:
                    # The base row stays readable by earlier module versions.
                    wim = ""
                    if recipe == HIRENS_RECIPE:
                        wim, initrd = initrd, ""
                        recipe = "bios-iso" if layout["bios"] else "library"
                    db.execute(
                        """INSERT INTO image (id,name,size,iso,kernel,initrd,recipe,filesystem)
                        VALUES (?,?,?,?,?,?,?,?)""",
                        (
                            ident,
                            name,
                            size,
                            iso,
                            kernel,
                            initrd,
                            recipe,
                            layout["filesystem"],
                        ),
                    )
                    if wim:
                        db.execute(
                            "INSERT INTO winpe_media(image,wim) VALUES (?,?)",
                            (ident, wim),
                        )
                    if strelec:
                        self.save_strelec(db, ident, strelec)
                    db.execute(
                        "INSERT INTO optical_profile_check VALUES (?,?)",
                        (ident, PROFILE_REVISION),
                    )
                row = db.execute(
                    "SELECT * FROM current_boot_image WHERE id=?", (ident,)
                ).fetchone()
                if row["recipe"] != "library":
                    db.executemany(
                        "INSERT OR IGNORE INTO visible (image,segment) VALUES (?,?)",
                        [(ident, s) for s in segments],
                    )
                result = image_metadata(db, row)
                result["existing"] = bool(existing)
                if record:
                    record(db, result)
                return result
