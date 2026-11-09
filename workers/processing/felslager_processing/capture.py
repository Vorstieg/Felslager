"""Prepare photos, video frames and telemetry from an original capture."""
import hashlib
import json
from pathlib import Path

from . import api as client
from .artifacts import artifact_path
from .errors import ReconstructionError
from .engines.common import IMAGE_EXTENSIONS, run_batch

VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}


def prepare_capture(job: dict, source: Path, work: Path) -> Path:
    """Prepare supported media from the files currently in the capture directory."""
    options = job["options"]["preparing"]
    excluded = set(options.get("excludedPaths", []))
    prepared = work / "prepared"
    prepared.mkdir()
    images, videos, subtitles = [], [], []
    for original in sorted(source.rglob("*")):
        if not original.is_file():
            continue
        client.check_cancelled(job["id"])
        name = original.relative_to(source).as_posix()
        if name in excluded:
            continue
        original = artifact_path(source, name)
        suffix = original.suffix.lower()
        if suffix in IMAGE_EXTENSIONS:
            # Captures are mounted read-only at the same path on every worker.
            target = prepared / "photos" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(original.resolve())
            images.append(name)
        elif suffix in VIDEO_EXTENSIONS:
            videos.append((name, original))
        elif suffix == ".srt":
            subtitles.append((name, original))
    frame_count = 0
    for name, original in videos:
        client.check_cancelled(job["id"])
        client.report_progress(job["id"], "preparing", 0)
        key = hashlib.sha256(name.encode()).hexdigest()[:16]
        directory = prepared / "videos" / key
        directory.mkdir(parents=True)
        # Bound extraction regardless of the user-selected sampling interval.
        start = options.get("videoStartSeconds", 0)
        end = options.get("videoEndSeconds")
        interval = options.get("videoFrameIntervalSeconds", 1)
        trim = ["-ss", str(start)] if start else []
        duration = ["-t", str(end - start)] if end is not None else []
        try:
            run_batch(["ffmpeg", "-nostdin", "-v", "error", *trim, "-i", str(original), *duration,
                       "-vf", f"fps={1 / interval:g}", "-frames:v", "10001", "-q:v", "2", str(directory / "%06d.jpg")],
                      work / f"video-{key}.log", lambda: client.check_cancelled(job["id"]))
        except ReconstructionError as error:
            raise ReconstructionError(f"Could not extract frames from {name}. Check FFmpeg codec support and the video file.") from error
        extracted = sorted(directory.glob("*.jpg"))
        if not extracted:
            raise ReconstructionError(f"Video contains no usable frames: {name}")
        if len(extracted) + len(images) + frame_count > 10000:
            raise ReconstructionError("Capture exceeds the 10,000 prepared image limit")
        frame_count += len(extracted)
    if len(images) + frame_count < 2:
        raise ReconstructionError("At least two images or video frames are required")
    # Preserve telemetry verbatim; formats vary across cameras.
    telemetry = work / "telemetry"
    telemetry.mkdir()
    for name, original in subtitles:
        target = telemetry / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(original.resolve())
    # Commit only after all preparation succeeds, allowing engine-only retries.
    checkpoint = work / "prepared.json.tmp"
    checkpoint.write_text(json.dumps({"version": 1, "images": "prepared"}))
    checkpoint.replace(work / "prepared.json")
    return prepared

