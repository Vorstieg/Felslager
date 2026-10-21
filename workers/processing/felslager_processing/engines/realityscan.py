"""RealityScan Linux CLI adapter using COLMAP cameras in mesh coordinates.

Export presets must retain original (distorted) calibration and image names,
and use local Z-up coordinates without a scene transform for both exports.
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import cv2
import numpy as np

from .common import IMAGE_EXTENSIONS, run_batch, photogrammetry_materials
from felslager_processing.reconstruction import ReconstructionError, camera_records
from felslager_processing.artifacts import ReconstructionOutput


def wine_path(path: Path) -> str:
    return 'Z:' + str(path.resolve()).replace('/', '\\')


def convert_cameras(folder: Path, names: dict[str, str]) -> dict:
    """Convert COLMAP text exports (original images) to OpenSfM cameras."""
    try:
        cameras = {}
        for line in (folder / 'cameras.txt').read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            cid, model, width, height, *values = line.split()
            width, height = int(width), int(height)
            p = list(map(float, values))
            counts = {'SIMPLE_PINHOLE': 3, 'PINHOLE': 4, 'SIMPLE_RADIAL': 4,
                      'RADIAL': 5, 'OPENCV': 8, 'FULL_OPENCV': 12}
            if model not in counts or len(p) != counts[model]:
                raise ReconstructionError(f'Unsupported RealityScan COLMAP camera: {model}')
            if not np.isfinite(p).all() or min(width, height) < 1:
                raise ValueError('Invalid camera intrinsics')
            if model in {'SIMPLE_PINHOLE', 'SIMPLE_RADIAL', 'RADIAL'}:
                fx, cx, cy, *distortion = p
                fy = fx
                k1, k2, p1, p2, k3 = (distortion + [0.] * 5)[:5]
            else:
                fx, fy, cx, cy, *distortion = p
                k1, k2, p1, p2, k3 = (distortion + [0.] * 5)[:5]
                if model == 'FULL_OPENCV' and any(abs(v) > 1e-12 for v in distortion[5:]):
                    raise ReconstructionError('RealityScan rational distortion is unsupported; use Brown3 alignment')
            scale = max(width, height)
            cameras[cid] = dict(projection_type='brown', width=width, height=height,
                                focal_x=fx / scale, focal_y=fy / scale,
                                c_x=(cx - width / 2) / scale, c_y=(cy - height / 2) / scale,
                                k1=k1, k2=k2, k3=k3, p1=p1, p2=p2)
        shots = {}
        lines = iter((folder / 'images.txt').read_text().splitlines())
        allowed = set(names.values())
        for line in lines:
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            _, qw, qx, qy, qz, tx, ty, tz, cid, name = line.split(maxsplit=9)
            # The next line contains 2D observations, and can be empty.
            next(lines)
            if name not in allowed or name in shots or cid not in cameras:
                raise ReconstructionError('RealityScan must export original image names and calibration')
            q = np.array([qw, qx, qy, qz], dtype=float)
            t = np.array([tx, ty, tz], dtype=float)
            if not np.isfinite(q).all() or not np.isfinite(t).all() or not np.isclose(np.linalg.norm(q), 1, atol=1e-5):
                raise ValueError('Invalid camera pose')
            w, x, y, z = q / np.linalg.norm(q)
            rotation = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                                 [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                                 [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])
            shots[name] = dict(camera=cid, rotation=cv2.Rodrigues(rotation)[0].ravel().tolist(),
                               translation=t.tolist())
        result = dict(cameras=cameras, shots=shots)
        camera_records(result)
        return result
    except (OSError, ValueError, KeyError, StopIteration, TypeError) as error:
        raise ReconstructionError('RealityScan returned invalid COLMAP text camera data') from error


def reconstruct(images: Path, out: Path, check_cancelled, progress):
    import trimesh

    executable = os.environ.get('REALITYSCAN_CLI', '/opt/realityscan/bin/realityscan-cli')
    if not shutil.which(executable):
        raise ReconstructionError('RealityScan CLI not found. Set REALITYSCAN_CLI on the worker.')
    presets = []
    for key in ('REALITYSCAN_MODEL_PARAMS', 'REALITYSCAN_REGISTRATION_PARAMS'):
        value = os.environ.get(key)
        if not value or not Path(value).expanduser().is_file():
            raise ReconstructionError(f'Set {key} to a RealityScan export settings XML file. See the worker README.')
        presets.append(Path(value).expanduser().resolve())
    files = sorted(p for p in images.rglob('*') if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS)
    if len(files) < 2:
        raise ReconstructionError('At least two supported images are required')
    out.mkdir(parents=True, exist_ok=True)
    staged = out / 'images'
    staged.mkdir()
    names = {}
    for index, source in enumerate(files):
        check_cancelled()
        name = f'image_{index:06d}{source.suffix.lower()}'
        names[source.relative_to(images).as_posix()] = name
        # Copy: RealityScan can write sidecars beside inputs.
        shutil.copy2(source, staged / name)
    registration = out / 'registration'
    registration.mkdir()
    crash_reports = out / 'crash-reports'
    crash_reports.mkdir()
    mesh = out / 'model.obj'
    progress('reconstructing', 5)
    # Suppress interactive warnings in unattended containers, retaining crash
    # reports in the private job directory for administrator diagnostics.
    command = [executable, '-silent', wine_path(crash_reports),
               '-headless', '-set', 'appQuitOnError=true', '-newScene',
               '-addFolder', wine_path(staged), '-align', '-selectMaximalComponent',
               '-save', wine_path(out / 'project.rsproj'),
               '-setReconstructionRegionAuto', '-calculateNormalModel', '-calculateTexture',
               '-save', wine_path(out / 'project.rsproj'),
               '-exportSelectedModel', wine_path(mesh), wine_path(presets[0]),
               '-exportRegistration', wine_path(registration / 'registration.txt'), wine_path(presets[1]),
               '-save', wine_path(out / 'project.rsproj'), '-quit']
    try:
        run_batch(command, out / 'realityscan.log', check_cancelled)
    except ReconstructionError as error:
        raise ReconstructionError(str(error).replace('Meshroom', 'RealityScan')) from error
    check_cancelled()
    # RealityScan supports both flat and COLMAP-standard directory layouts.
    candidates = list(registration.rglob('cameras.txt'))
    if len(candidates) != 1:
        raise ReconstructionError('RealityScan must export one COLMAP text registration. Check its export preset.')
    normalized = out / 'reconstruction.json'
    normalized.write_text(json.dumps(convert_cameras(candidates[0].parent, names)))
    if not mesh.is_file():
        raise ReconstructionError('RealityScan did not export model.obj. Check its model export preset.')
    geometry = trimesh.load(mesh, force='scene', process=False)
    if not geometry.geometry or not any(len(g.faces) for g in geometry.geometry.values()):
        raise ReconstructionError('RealityScan returned an empty mesh')
    progress('reconstructing', 75)
    glb = out / 'model.glb'
    glb.write_bytes(geometry.export(file_type='glb', tree_postprocessor=photogrammetry_materials))
    check_cancelled()
    return ReconstructionOutput(glb, normalized, names, glb, "Z_UP")
