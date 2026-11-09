"""Subprocess control and materials shared by reconstruction engines."""
import os
from pathlib import Path
import signal
import subprocess
from typing import Callable

from ..errors import ReconstructionError

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}


def run_batch(command: list[str], log: Path, check_cancelled: Callable[[], None],
              poll: Callable[[], None] | None = None) -> None:
    """Terminate the entire Meshroom/AliceVision process group on cancellation."""
    check_cancelled()
    with log.open("wb") as stream:
        process = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            while True:
                try:
                    code = process.wait(timeout=2)
                    if poll:
                        poll()
                    break
                except subprocess.TimeoutExpired:
                    check_cancelled()
                    if poll:
                        poll()
            check_cancelled()
        finally:
            # Meshroom launches subprocesses; kill the group even if its leader
            # has already exited so no AliceVision children survive a failure.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    if code != 0:
        with log.open("rb") as stream:
            stream.seek(max(0, log.stat().st_size - 2000))
            tail = stream.read().decode(errors="replace")
        raise ReconstructionError(f"Meshroom exited with code {code}. Check CUDA/GPU availability and input overlap. {tail[-700:]}")


def photogrammetry_materials(tree: dict) -> None:
    """Display baked photograph colors without applying scene lighting again."""
    changed = False
    for material in tree.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {})
        if "baseColorTexture" not in pbr:
            continue
        pbr.update(baseColorFactor=[1., 1., 1., 1.], metallicFactor=0., roughnessFactor=1.)
        material.setdefault("extensions", {})["KHR_materials_unlit"] = {}
        changed = True
    if changed:
        used = tree.setdefault("extensionsUsed", [])
        if "KHR_materials_unlit" not in used:
            used.append("KHR_materials_unlit")
