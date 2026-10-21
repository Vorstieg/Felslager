"""Meshroom 2025.1 reconstruction and AliceVision-to-OBJ camera conversion.

AliceVision serializes rotations in Eigen column-major order. Its OBJ exporter
flips world Y and Z; camera poses must receive that same change of basis.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from felslager_processing.reconstruction import ReconstructionError, camera_records
from felslager_processing.artifacts import ReconstructionOutput
from .common import IMAGE_EXTENSIONS, run_batch, photogrammetry_materials

OBJ_BASIS = np.diag([1., -1., -1.])


def convert_cameras(scene: dict) -> dict:
    """Normalize supported AliceVision pinhole cameras to our OpenSfM format."""
    try:
        version = tuple(int(v) for v in scene["version"])
        if not (1, 2, 8) <= version <= (1, 2, 12):
            raise ReconstructionError(f"Unsupported AliceVision camera format {version}; use Meshroom 2025.1")
        intrinsics = {str(c["intrinsicId"]): c for c in scene.get("intrinsics", [])}
        poses = {str(p["poseId"]): p["pose"]["transform"] for p in scene.get("poses", [])}
        cameras, shots = {}, {}
        for view in scene.get("views", []):
            pose = poses.get(str(view.get("poseId")))
            if pose is None:  # Images that SfM could not register have no pose.
                continue
            if str(view.get("isPoseIndependant", True)).lower() not in {"true", "1"}:
                raise ReconstructionError("Meshroom camera rigs are not supported")
            intrinsic_id = str(view["intrinsicId"])
            c = intrinsics[intrinsic_id]
            distortion_type = c.get("distortionType", "none")
            if c["type"] != "pinhole" or c.get("undistortionType", "none") != "none":
                raise ReconstructionError("Meshroom requires pinhole cameras without custom undistortion")
            counts = {"none": 0, "radialk1": 1, "radialk3": 3, "brown": 5}
            if distortion_type not in counts:
                raise ReconstructionError(f"Unsupported Meshroom distortion: {distortion_type}")
            params = [float(v) for v in (c.get("distortionParams") or [])]
            if len(params) != counts[distortion_type] or not np.isfinite(params).all():
                raise ReconstructionError("Invalid Meshroom distortion parameters")
            width, height = int(c["width"]), int(c["height"])
            sensor, focal, ratio = float(c["sensorWidth"]), float(c["focalLength"]), float(c.get("pixelRatio", 1))
            if min(width, height, sensor, focal, ratio) <= 0 or not np.isfinite([sensor, focal, ratio]).all():
                raise ReconstructionError("Invalid Meshroom camera calibration")
            # SfM 1.2.12 uses the larger image dimension, including portrait.
            focal_scale = max(width, height) if version >= (1, 2, 12) else width
            fx = focal * focal_scale / sensor
            fy = fx * ratio
            if version >= (1, 2, 11):
                fx, fy = fx / ratio, fx
            principal = np.asarray(c["principalPoint"], dtype=float)
            if principal.shape != (2,) or not np.isfinite(principal).all():
                raise ReconstructionError("Invalid Meshroom principal point")
            scale = max(width, height)
            camera = {"projection_type": "brown", "width": width, "height": height,
                      "focal_x": fx / scale, "focal_y": fy / scale,
                      "c_x": float(principal[0]) / scale, "c_y": float(principal[1]) / scale}
            for key, value in zip(("k1", "k2", "k3", "p1", "p2"), params):
                camera[key] = value
            rotation = np.asarray(pose["rotation"], dtype=float).reshape((3, 3), order="F")
            center = np.asarray(pose["center"], dtype=float)
            if center.shape != (3,) or not np.isfinite(rotation).all() or not np.isfinite(center).all():
                raise ReconstructionError("Invalid Meshroom camera pose")
            if not np.allclose(rotation @ rotation.T, np.eye(3), atol=1e-5) or not np.isclose(np.linalg.det(rotation), 1, atol=1e-5):
                raise ReconstructionError("Invalid Meshroom camera rotation")
            # R maps world to camera. Keep camera axes right/down/forward and
            # transform only world coordinates into AliceVision's exported OBJ.
            exported_rotation = rotation @ OBJ_BASIS
            exported_center = OBJ_BASIS @ center
            name = Path(view["path"]).name
            if not name or name in shots:
                raise ReconstructionError("Meshroom returned duplicate image names")
            cameras[intrinsic_id] = camera
            shots[name] = {"camera": intrinsic_id,
                           "rotation": cv2.Rodrigues(exported_rotation)[0].ravel().tolist(),
                           "translation": (-exported_rotation @ exported_center).tolist()}
        result = {"cameras": cameras, "shots": shots}
        camera_records(result)  # Reject empty or invalid calibrated reconstructions.
        return result
    except (KeyError, TypeError, ValueError, OverflowError) as error:
        raise ReconstructionError("Meshroom returned invalid camera calibration data") from error


def make_pipeline(installation: Path, destination: Path) -> None:
    """Export cameras from the exact Meshing scene used by Texturing."""
    template = installation / "aliceVision/share/meshroom/photogrammetry.mg"
    if not template.is_file():
        raise ReconstructionError(f"Meshroom photogrammetry template not found: {template}")
    graph = json.loads(template.read_text())
    graph["header"]["nodesVersions"]["ConvertSfMFormat"] = "2.0"
    graph["graph"]["ConvertSfMFormat_1"] = {
        "nodeType": "ConvertSfMFormat", "position": [2200, 200],
        "inputs": {"input": "{Meshing_1.output}", "fileExt": "sfm",
                   "structure": False, "observations": False, "surveys": False}}
    graph["graph"]["Publish_1"]["inputs"]["inputFiles"].append("{ConvertSfMFormat_1.output}")
    graph["graph"]["Texturing_1"]["inputs"].update(
        outputMeshFileType="obj", colorMapping={"enable": True, "colorMappingFileType": "png"})
    destination.write_text(json.dumps(graph, indent=2))


def reconstruct(images: Path, out: Path, check_cancelled: Callable[[], None],
                progress: Callable[[str, int], None], installation: Path | None = None) -> ReconstructionOutput:
    import shutil
    import trimesh

    installation = (installation or Path(os.environ.get("MESHROOM_HOME", "/opt/Meshroom-2025.1.0"))).expanduser().resolve()
    executable = installation / "meshroom_batch"
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise ReconstructionError(f"Meshroom executable not found: {executable}. Set MESHROOM_HOME on the worker.")
    files = sorted(p for p in images.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS)
    if len(files) < 2:
        raise ReconstructionError("At least two supported images are required")
    out.mkdir(parents=True, exist_ok=True)
    staged = out / "images"
    staged.mkdir()
    names = {}
    for index, source in enumerate(files):
        check_cancelled()
        name = f"image_{index:06d}{source.suffix.lower()}"
        names[source.relative_to(images).as_posix()] = name
        # Preserve bytes and EXIF, while avoiding duplicate basenames and nested
        # folders. Hard links avoid copying originals on a shared filesystem.
        try:
            os.link(source, staged / name)
        except OSError:
            shutil.copy2(source, staged / name)
    pipeline = out / "pipeline.mg"
    make_pipeline(installation, pipeline)
    published = out / "published"
    progress("reconstructing", 5)
    run_batch([str(executable), "--pipeline", str(pipeline), "--input", str(staged),
               "--output", str(published), "--cache", str(out / "cache"),
               "--save", str(out / "project.mg")], out / "meshroom.log", check_cancelled)
    check_cancelled()
    mesh, sfm = published / "texturedMesh.obj", published / "sfm.sfm"
    if not mesh.is_file() or not sfm.is_file():
        raise ReconstructionError("Meshroom did not publish texturedMesh.obj and sfm.sfm")
    normalized = out / "reconstruction.json"
    normalized.write_text(json.dumps(convert_cameras(json.loads(sfm.read_text()))))
    progress("reconstructing", 75)
    geometry = trimesh.load(mesh, force="scene", process=False)
    if not geometry.geometry or not any(len(g.faces) for g in geometry.geometry.values()):
        raise ReconstructionError("Meshroom returned an empty mesh")
    glb = out / "model.glb"
    glb.write_bytes(geometry.export(file_type="glb", tree_postprocessor=photogrammetry_materials))
    check_cancelled()
    # Detection reads this exact GLB, so materials/scene transforms cannot make
    # its mesh differ from the model opened by Felsstudio.
    return ReconstructionOutput(glb, normalized, names, glb, "Y_UP")
