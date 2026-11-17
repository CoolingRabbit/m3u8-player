from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import re

ROOT = Path(__file__).resolve().parent
version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    raise ValueError(f"Invalid semantic version: {version}")

files = {
    "design.html": "index.html",
    "app.js": "app.js",
    "VERSION": "VERSION",
    "vendor/hls.min.js": "vendor/hls.min.js",
    "vendor/hls.LICENSE.txt": "vendor/hls.LICENSE.txt",
}
archive_name = f"m3u8-player-v{version}.zip"
archive_path = ROOT / "dist" / archive_name
archive_path.parent.mkdir(exist_ok=True)

with ZipFile(archive_path, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
    for source, target in files.items():
        source_path = ROOT / source
        if not source_path.is_file():
            raise FileNotFoundError(source_path)
        archive.write(source_path, f"m3u8-player-v{version}/{target}")

with ZipFile(archive_path) as archive:
    bad_file = archive.testzip()
    if bad_file:
        raise RuntimeError(f"Archive integrity check failed: {bad_file}")

print(archive_path)
