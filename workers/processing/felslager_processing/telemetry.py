"""Read DJI subtitle positions and add GPS EXIF without recompressing JPEGs."""
from bisect import bisect_right
from dataclasses import dataclass
import logging
import math
from pathlib import Path
import re

from PIL import Image
from PIL.TiffImagePlugin import IFDRational

LOG = logging.getLogger("felslager-worker")
NUMBER = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)"
TIME = r"\d{2,}:\d{2}:\d{2}[,.]\d{3}"
CUE = re.compile(rf"^\s*({TIME})\s*-->\s*({TIME})[^\n]*\n(.*)", re.S)
FIELDS = re.compile(rf"\b(latitude|longitude|abs_alt)\s*:\s*({NUMBER})(?=\s|\]|<|$)", re.I)
GPS = re.compile(rf"\bGPS\s*\(\s*({NUMBER})\s*,\s*({NUMBER})\s*,\s*({NUMBER})\s*[mM]?\s*\)", re.I)


@dataclass(frozen=True)
class Position:
    start: float
    end: float
    latitude: float
    longitude: float
    altitude: float | None


def seconds(value: str) -> float:
    hours, minutes, seconds = value.replace(",", ".").split(":")
    if int(minutes) >= 60 or float(seconds) >= 60:
        raise ValueError("Invalid subtitle time")
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def read_positions(path: Path) -> list[Position]:
    positions = []
    content = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    for block in re.split(r"\n\s*\n", content.strip()):
        # A numeric cue index is optional; timestamps must be relative SRT times.
        block = re.sub(r"^\s*\d+\s*\n", "", block, count=1)
        match = CUE.match(block)
        if not match:
            continue
        try:
            start, end = seconds(match[1]), seconds(match[2])
            fields = {key.lower(): float(value) for key, value in FIELDS.findall(match[3])}
            if "latitude" in fields and "longitude" in fields:
                lat, lon, alt = fields["latitude"], fields["longitude"], fields.get("abs_alt")
            else:
                legacy = GPS.search(match[3])
                if not legacy:
                    continue
                lat, lon, alt = map(float, legacy.groups())
            if (end <= start or not -90 <= lat <= 90 or not -180 <= lon <= 180
                    or (lat == 0 and lon == 0) or (alt is not None and not math.isfinite(alt))):
                continue
            positions.append(Position(start, end, lat, lon, alt))
        except ValueError:
            continue
    return sorted(positions, key=lambda position: position.start)


def _degrees(value: float) -> tuple[IFDRational, IFDRational, IFDRational]:
    value = abs(value)
    degrees = int(value)
    minutes = int((value - degrees) * 60)
    seconds = (value - degrees - minutes / 60) * 3600
    return IFDRational(degrees), IFDRational(minutes), IFDRational(round(seconds * 1000000), 1000000)


def write_gps(path: Path, position: Position) -> None:
    with Image.open(path) as image:
        exif = image.getexif()
    gps = {0: b"\x02\x03\x00\x00", 1: "N" if position.latitude >= 0 else "S",
           2: _degrees(position.latitude), 3: "E" if position.longitude >= 0 else "W",
           4: _degrees(position.longitude), 18: "WGS-84"}
    if position.altitude is not None:
        gps.update({5: b"\x00" if position.altitude >= 0 else b"\x01",
                    6: IFDRational(round(abs(position.altitude) * 1000), 1000)})
    exif[34853] = gps
    metadata = exif.tobytes()
    segment = b"\xff\xe1" + (len(metadata) + 2).to_bytes(2, "big") + metadata
    data = path.read_bytes()
    # Replace only EXIF APP1 segments. Keep the compressed scan and all other
    # metadata byte-for-byte rather than decoding and re-encoding the image.
    offset = 2
    parts = [data[:2], segment]
    while offset < len(data):
        begin = offset
        if data[offset] != 0xff:
            raise ValueError(f"Invalid JPEG marker in {path}")
        while data[offset] == 0xff:
            offset += 1
        marker = data[offset]
        offset += 1
        if marker in (0xda, 0xd9):
            parts.append(data[begin:])
            break
        length = int.from_bytes(data[offset:offset + 2], "big")
        if length < 2 or offset + length > len(data):
            raise ValueError(f"Invalid JPEG segment in {path}")
        if marker != 0xe1 or data[offset + 2:offset + 8] != b"Exif\x00\x00":
            parts.append(data[begin:offset + length])
        offset += length
    path.write_bytes(b"".join(parts))


def geotag_frames(frames: list[Path], subtitle: Path, start: float, interval: float,
                  check_cancelled) -> int:
    positions = read_positions(subtitle)
    starts = [position.start for position in positions]
    tagged = 0
    for index, frame in enumerate(frames):
        check_cancelled()
        # SRT times have millisecond precision; avoid float drift selecting the
        # previous cue at an exact sampling boundary (e.g. 3 * 0.3 seconds).
        timestamp = round(start + index * interval, 9)
        at = bisect_right(starts, timestamp) - 1
        # Do not extrapolate across gaps or beyond the recorded telemetry.
        if at >= 0 and timestamp < positions[at].end:
            write_gps(frame, positions[at])
            tagged += 1
    LOG.info("Geotagged %d/%d video frames from %s", tagged, len(frames), subtitle.name)
    if tagged < len(frames):
        LOG.warning("%d frames have no valid SRT GPS position in %s", len(frames) - tagged, subtitle.name)
    return tagged
