"""Projection from calibrated OpenSfM cameras onto the model's mesh coordinates."""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np


from felslager_processing.errors import ReconstructionError


def camera_records(scenes: list | dict) -> dict[str, dict]:
    # Multiple disconnected components cannot share one model coordinate system.
    if isinstance(scenes, list):
        if len(scenes) != 1:
            raise ReconstructionError("Expected one connected OpenSfM reconstruction")
        scenes = scenes[0]
    result = {}
    for name, shot in scenes.get("shots", {}).items():
        camera = scenes.get("cameras", {}).get(shot.get("camera"), {})
        if camera.get("projection_type") not in {"brown", "perspective"}:
            raise ReconstructionError(f"Unsupported camera projection for {name}")
        width, height = int(camera.get("width", 0)), int(camera.get("height", 0))
        fx = float(camera.get("focal_x", camera.get("focal", 0)))
        fy = float(camera.get("focal_y", camera.get("focal", 0)))
        if width < 1 or height < 1 or not np.isfinite([fx, fy]).all() or min(fx, fy) <= 0:
            raise ReconstructionError(f"Invalid camera calibration for {name}")
        rotation = np.asarray(shot["rotation"], dtype=float)
        translation = np.asarray(shot["translation"], dtype=float)
        if rotation.shape != (3,) or translation.shape != (3,) or not np.isfinite([rotation, translation]).all():
            raise ReconstructionError(f"Invalid camera pose for {name}")
        matrix, _ = cv2.Rodrigues(rotation)
        result[name] = {"camera": camera, "width": width, "height": height,
                        "R": matrix, "center": -matrix.T @ translation}
    if not result:
        raise ReconstructionError("Reconstruction contains no calibrated cameras")
    return result


def camera_ray(cam: dict, pixel: tuple[float, float], image_shape: tuple) -> np.ndarray:
    """Use OpenSfM's right/down/forward camera axes, including Brown intrinsics."""
    camera = cam["camera"]
    scale = max(cam["width"], cam["height"])
    fx = float(camera.get("focal_x", camera.get("focal", 0))) * scale
    fy = float(camera.get("focal_y", camera.get("focal", 0))) * scale
    cx = float(camera.get("c_x", 0)) * scale + cam["width"] / 2
    cy = float(camera.get("c_y", 0)) * scale + cam["height"] / 2
    intrinsic = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=float)
    distortion = np.array([camera.get(k, 0) for k in ("k1", "k2", "p1", "p2", "k3")], dtype=float)
    x, y = pixel
    pixels = np.array([[[x * cam["width"] / image_shape[1], y * cam["height"] / image_shape[0]]]], dtype=float)
    xy = cv2.undistortPoints(pixels, intrinsic, distortion)[0, 0]
    direction = cam["R"].T @ np.array([xy[0], xy[1], 1.0])
    return direction / np.linalg.norm(direction)


class MeshProjector:
    """Nearest forward ray/triangle hit, without a distance cutoff or rtree dependency."""

    def __init__(self, vertices: np.ndarray, faces: np.ndarray):
        vertices = np.asarray(vertices, dtype=float)
        faces = np.asarray(faces, dtype=int)
        if not len(vertices) or not len(faces) or not np.isfinite(vertices).all():
            raise ReconstructionError("Detection mesh contains no valid triangles")
        self.a = vertices[faces[:, 0]]
        self.e1 = vertices[faces[:, 1]] - self.a
        self.e2 = vertices[faces[:, 2]] - self.a

    def intersect(self, origin: np.ndarray, direction: np.ndarray):
        best_distance = np.inf
        best_normal = None
        # Bound temporary memory for dense meshes. Reject back-facing and
        # front-facing triangles alike only when parallel, never by winding.
        for start in range(0, len(self.a), 100_000):
            a, e1, e2 = (v[start:start + 100_000] for v in (self.a, self.e1, self.e2))
            h = np.cross(direction, e2)
            determinant = np.einsum("ij,ij->i", e1, h)
            valid = np.abs(determinant) > 1e-10
            inverse = np.zeros_like(determinant)
            inverse[valid] = 1 / determinant[valid]
            s = origin - a
            u = inverse * np.einsum("ij,ij->i", s, h)
            q = np.cross(s, e1)
            v = inverse * np.einsum("ij,j->i", q, direction)
            distance = inverse * np.einsum("ij,ij->i", e2, q)
            valid &= (u >= 0) & (v >= 0) & (u + v <= 1) & (distance > 1e-8)
            candidates = np.where(valid, distance, np.inf)
            index = int(np.argmin(candidates))
            if candidates[index] < best_distance:
                best_distance = float(candidates[index])
                normal = np.cross(e1[index], e2[index])
                best_normal = normal / np.linalg.norm(normal)
        if best_normal is None:
            return None
        return origin + best_distance * direction, best_distance, float(abs(best_normal @ direction))


def load_cameras(filename: Path) -> dict[str, dict]:
    """Read the common calibrated camera document from disk."""
    return camera_records(json.loads(filename.read_text()))
