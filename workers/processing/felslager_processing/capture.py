"""Prepare photos, video frames and telemetry from an original capture."""
import hashlib
from pathlib import Path
import shutil

from . import api as client
from .artifacts import artifact_path
from .errors import ReconstructionError
from .engines.common import IMAGE_EXTENSIONS, run_batch

VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}


def prepare_capture(job: dict, source: Path, work: Path) -> Path:
    """Prepare supported media from the files currently in the capture directory."""
    prepared = work / "prepared"
    prepared.mkdir()
    images, videos, subtitles = [], [], []
    for original in sorted(source.rglob("*")):
        if not original.is_file():
            continue
        client.check_cancelled(job["id"])
        name = original.relative_to(source).as_posix()
        original = artifact_path(source, name)
        suffix = original.suffix.lower()
        if suffix in IMAGE_EXTENSIONS:
            # Keep originals read-only; engines can modify their own input copies.
            target = prepared / "photos" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, target)
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
        # One frame per second, bounded to avoid unbounded extraction from long videos.
        try:
            run_batch(["ffmpeg", "-nostdin", "-v", "error", "-i", str(original),
                       "-vf", "fps=1", "-frames:v", "10001", "-q:v", "2", str(directory / "%06d.jpg")],
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
        shutil.copy2(original, target)
    return prepared

