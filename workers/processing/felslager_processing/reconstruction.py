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
        if not np.isfinite([float(camera.get(k, 0)) for k in
                            ("c_x", "c_y", "k1", "k2", "p1", "p2", "k3")]).all():
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
    """World ray from image-edge pixels (top-left pixel center is .5, .5).

    YOLO boxes use this convention. OpenSfM normalized coordinates therefore
    denormalize with width/2, height/2; OpenCV pixel-center coordinates would
    instead use (width-1)/2, (height-1)/2. Edge coordinates also resize directly.
    Camera axes are right/down/forward.
    """
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
    # The default five iterations can leave errors of tens of pixels near
    # distorted image edges. Iterate to a pixel-space convergence tolerance.
    xy = cv2.undistortPointsIter(
        pixels, intrinsic, distortion, None, None,
        (cv2.TERM_CRITERIA_COUNT | cv2.TERM_CRITERIA_EPS, 100, 1e-10))[0, 0]
    check = cv2.projectPoints(np.array([[xy[0], xy[1], 1.]]), np.zeros(3),
                              np.zeros(3), intrinsic, distortion)[0]
    if (not np.isfinite(xy).all() or not np.isfinite(check).all()
            or np.linalg.norm(check - pixels) > 1e-5):
        raise ReconstructionError("Camera distortion inversion did not converge")
    direction = cam["R"].T @ np.array([xy[0], xy[1], 1.0])
    return direction / np.linalg.norm(direction)


def project_pixels(cam: dict, points: np.ndarray) -> np.ndarray:
    """Project world points to original image-edge pixels, with distortion."""
    camera = cam["camera"]
    scale = max(cam["width"], cam["height"])
    fx = float(camera.get("focal_x", camera.get("focal", 0))) * scale
    fy = float(camera.get("focal_y", camera.get("focal", 0))) * scale
    intrinsic = np.array([[fx, 0, float(camera.get("c_x", 0)) * scale + cam["width"] / 2],
                          [0, fy, float(camera.get("c_y", 0)) * scale + cam["height"] / 2],
                          [0, 0, 1]], dtype=float)
    distortion = np.array([camera.get(k, 0) for k in ("k1", "k2", "p1", "p2", "k3")], dtype=float)
    rotation = cv2.Rodrigues(cam["R"])[0]
    return cv2.projectPoints(np.asarray(points, dtype=float).reshape(-1, 3), rotation,
                             -cam["R"] @ cam["center"], intrinsic, distortion)[0].reshape(-1, 2)


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
        # A determinant has units of area. Scale its parallelism tolerance
        # with triangle area, so changing reconstruction units preserves hits.
        self.area = np.linalg.norm(np.cross(self.e1, self.e2), axis=1)

    def intersect(self, origin: np.ndarray, direction: np.ndarray):
        best_distance = np.inf
        best_normal = None
        # Bound temporary memory for dense meshes. Reject back-facing and
        # front-facing triangles alike only when parallel, never by winding.
        for start in range(0, len(self.a), 100_000):
            a, e1, e2 = (v[start:start + 100_000] for v in (self.a, self.e1, self.e2))
            h = np.cross(direction, e2)
            determinant = np.einsum("ij,ij->i", e1, h)
            area = self.area[start:start + 100_000]
            valid = np.abs(determinant) > 32 * np.finfo(float).eps * area
            inverse = np.zeros_like(determinant)
            inverse[valid] = 1 / determinant[valid]
            s = origin - a
            u = inverse * np.einsum("ij,ij->i", s, h)
            q = np.cross(s, e1)
            v = inverse * np.einsum("ij,j->i", q, direction)
            distance = inverse * np.einsum("ij,ij->i", e2, q)
            valid &= (u >= 0) & (v >= 0) & (u + v <= 1) & (distance > 0)
            candidates = np.where(valid, distance, np.inf)
            index = int(np.argmin(candidates))
            if candidates[index] < best_distance:
                best_distance = float(candidates[index])
                normal = np.cross(e1[index], e2[index])
                best_normal = normal / np.linalg.norm(normal)
        if best_normal is None:
            return None
        return origin + best_distance * direction, best_distance, float(abs(best_normal @ direction))


class VertexProjector:
    """Legacy dashboard snapping in model units; cameras must share this space."""

    def __init__(self, vertices: np.ndarray, normals: np.ndarray):
        self.vertices = np.asarray(vertices, dtype=float)
        self.normals = np.asarray(normals, dtype=float)
        if (self.vertices.ndim != 2 or self.vertices.shape[1] != 3
                or not len(self.vertices) or self.normals.shape != self.vertices.shape
                or not np.isfinite(self.vertices).all() or not np.isfinite(self.normals).all()):
            raise ReconstructionError("Detection mesh contains no valid vertices or normals")
        self.normals = self.normals / np.maximum(np.linalg.norm(self.normals, axis=1, keepdims=True), 1e-8)
        self.grid = {}
        for index, vertex in enumerate(self.vertices):
            self.grid.setdefault(tuple((vertex / 0.5).astype(int)), []).append(index)

    def intersect(self, origin: np.ndarray, direction: np.ndarray):
        # Preserve the original dashboard's first successful probe, seven-cell
        # neighbourhood, 15 cm tolerance and 1–35 unit search window.
        neighbours = ((0, 0, 0), (1, 0, 0), (-1, 0, 0), (0, 1, 0),
                      (0, -1, 0), (0, 0, 1), (0, 0, -1))
        for distance in np.arange(1.0, 35.0, 0.5):
            cell = ((origin + direction * distance) / 0.5).astype(int)
            best, best_squared = None, 0.15 ** 2
            for offset in neighbours:
                for index in self.grid.get(tuple(cell + offset), ()):
                    delta = self.vertices[index] - origin
                    along = float(delta @ direction)
                    if along < 1.0:
                        continue
                    squared = float(delta @ delta - along ** 2)
                    if squared < best_squared:
                        best, best_squared = index, squared
            if best is not None:
                point = self.vertices[best]
                return point.copy(), float(np.linalg.norm(point - origin)), float(abs(self.normals[best] @ direction))
        return None


def load_cameras(filename: Path) -> dict[str, dict]:
    """Read the common calibrated camera document from disk."""
    return camera_records(json.loads(filename.read_text()))
