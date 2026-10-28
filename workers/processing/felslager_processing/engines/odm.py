"""NodeODM reconstruction adapter."""
import json
import logging
import os
from pathlib import Path
import tempfile
import time
import zipfile

import requests

from ..artifacts import ReconstructionOutput
from ..errors import ReconstructionError, JobCancelled
from ..reconstruction import load_cameras

LOG = logging.getLogger("felslager-worker")
ODM = os.environ.get("NODEODM_URL", "http://127.0.0.1:3000").rstrip("/")


def cancel_task(task_id: str) -> None:
    try:
        response = requests.post(ODM + "/task/cancel", json={"uuid": task_id}, timeout=30)
        response.raise_for_status()
    except Exception:
        LOG.warning("Could not cancel NodeODM task %s", task_id, exc_info=True)


def reconstruct(images: Path, out: Path, check_cancelled, progress) -> ReconstructionOutput:
    """Upload originals in bounded batches, then return the GLB and OpenSfM cameras."""
    check_cancelled()
    out.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in images.rglob("*") if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"})
    if len(files) < 2:
        raise RuntimeError("At least two supported images are required")
    names = {p.relative_to(images).as_posix(): f"image_{i:06d}{p.suffix.lower()}" for i, p in enumerate(files)}
    options = json.dumps([
        {"name": "gltf", "value": True},
        {"name": "fast-orthophoto", "value": False},
        {"name": "mesh-size", "value": "2000000"},
        {"name": "mesh-octree-depth", "value": "12"},
    ])
    outputs = json.dumps([
        "odm_texturing/odm_textured_model_geo.glb",
        "odm_texturing/odm_textured_model_geo.obj",
        "opensfm/reconstruction.json",
    ])
    response = requests.post(
        ODM + "/task/new/init",
        files={
            "name": (None, "Felslager bolt reconstruction"),
            "options": (None, options),
            "outputs": (None, outputs),
        },
        timeout=60,
    )
    task_id = nodeodm_result(response)["uuid"]
    try:
        LOG.info("NodeODM task %s created; uploading %d images", task_id, len(files))
        total_batches = (len(files) + 31) // 32
        for batch_index, start in enumerate(range(0, len(files), 32), start=1):
            check_cancelled()
            handles = []
            try:
                parts = []
                for source in files[start:start + 32]:
                    handle = source.open("rb")
                    handles.append(handle)
                    relative = source.relative_to(images).as_posix()
                    parts.append(("images", (names[relative], handle, "application/octet-stream")))
                upload = requests.post(f"{ODM}/task/new/upload/{task_id}", files=parts, timeout=1800)
                nodeodm_result(upload)
            finally:
                for handle in handles:
                    handle.close()
            LOG.info("Uploaded %d/%d images to NodeODM", min(start + 32, len(files)), len(files))
            progress("uploading_to_odm", 1 + round(4 * batch_index / total_batches), min(start + 32, len(files)), len(files))
        commit = requests.post(f"{ODM}/task/new/commit/{task_id}", timeout=60)
        nodeodm_result(commit)
        while True:
            check_cancelled()
            info = requests.get(f"{ODM}/task/{task_id}/info", timeout=60)
            payload = nodeodm_result(info)
            state = payload.get("status", {})
            code = int(state.get("code", -1))
            odm_progress = max(0, min(100, int(payload.get("progress", 0))))
            LOG.info("NodeODM %s: status %s (%s%%)", task_id, code, odm_progress)
            progress("reconstructing", 5 + round(70 * odm_progress / 100))
            if code == 40:
                break
            if code in (30, 50, 60):
                raise RuntimeError(f"NodeODM reconstruction failed: {state}")
            time.sleep(10)
        progress("downloading", 76)
        glb, reconstruction, mesh = download_reconstruction(task_id, out)
        return ReconstructionOutput(glb, reconstruction, names, mesh, "Z_UP")
    except (JobCancelled, KeyboardInterrupt):
        cancel_task(task_id)
        raise


def nodeodm_result(response):
    response.raise_for_status()
    payload = response.json()
    if payload.get("error"):
        raise ReconstructionError(f"NodeODM: {payload['error']}")
    return payload


def download_reconstruction(task_id: str, out: Path) -> tuple[Path, Path, Path]:
    required = ["odm_texturing/odm_textured_model_geo.glb",
                "opensfm/reconstruction.json",
                "odm_texturing/odm_textured_model_geo.obj"]
    out.mkdir(parents=True, exist_ok=True)
    with requests.get(f"{ODM}/task/{task_id}/download/all.zip", timeout=1800, stream=True) as response:
        response.raise_for_status()
        with tempfile.TemporaryFile() as archive:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                archive.write(chunk)
            archive.seek(0)
            try:
                with zipfile.ZipFile(archive) as zf:
                    missing = [name for name in required if name not in zf.namelist()]
                    if missing:
                        raise ReconstructionError("NodeODM output is missing required files: " + ", ".join(missing))
                    for member in zf.infolist():
                        target = (out / member.filename).resolve()
                        if not target.is_relative_to(out.resolve()):
                            raise ReconstructionError("NodeODM archive contains an invalid output path")
                    zf.extractall(out)
            except zipfile.BadZipFile as error:
                raise ReconstructionError("NodeODM did not return a valid output ZIP") from error
    glb, reconstruction, mesh = (out / name for name in required)
    load_cameras(reconstruction)  # Validate cameras before running expensive detection.
    return glb, reconstruction, mesh

