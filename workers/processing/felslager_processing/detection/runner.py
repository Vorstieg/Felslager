"""Bolt inference and calibrated projection onto the reconstruction mesh."""
import json
import os
from pathlib import Path
import pathlib
import sys

import cv2
import numpy as np

from .. import api as client
from ..errors import ReconstructionError
from ..reconstruction import MeshProjector, VertexProjector, camera_ray, load_cameras

MODEL = Path(os.environ.get("BOLT_MODEL_PATH", str(Path(__file__).resolve().parents[2] / "models/bolt_detector_v3_yolo26s.pt")))
DETECTION_MODEL = None


def run_detection(job_id: str, images: Path, model_path: Path, model_glb: Path, reconstruction: Path, out: Path, job_name: str, image_names: dict[str, str], coordinate_system: str = "Z_UP", placement_method: str = "triangle", cached_detections: Path | None = None):
    if placement_method not in {"triangle", "vertex", "multiview"}:
        raise ReconstructionError(f"Unsupported bolt placement method: {placement_method}")
    import trimesh
    if cached_detections is None:
        from felslager_processing.detection.inference import predict_tiled
        model = get_detection_model(model_path)
        cached = None
    else:
        cached = {frame['image']: frame['detections'] for frame in json.loads(cached_detections.read_text())['frames']}
    stage = 'positioning' if cached is not None else 'detecting'
    geometry = trimesh.load(model_glb, force="mesh", process=False, skip_materials=True)
    projector = (VertexProjector(geometry.vertices, geometry.vertex_normals) if placement_method == "vertex"
                 else MeshProjector(geometry.vertices, geometry.faces))
    cameras = load_cameras(reconstruction)
    hits = []
    observations = []
    frame_results = []
    exported_cameras = {}
    calibrated = {}
    supported_detections = 0
    image_paths = sorted(p for p in images.rglob("*") if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"})
    if cached is not None:
        available = {p.relative_to(images).as_posix() for p in image_paths}
        if not set(cached).issubset(available):
            raise ReconstructionError('Original detection images are missing')
        image_paths = [p for p in image_paths if p.relative_to(images).as_posix() in cached]
    total_images = len(image_paths)
    if not total_images:
        raise RuntimeError("No supported source images were found for bolt detection")
    # Cameras belong to reconstructed images even when YOLO finds no bolts.
    for image_path in image_paths:
        relative = image_path.relative_to(images).as_posix()
        cam = cameras.get(image_names.get(relative, image_path.name))
        if cam:
            exported_cameras[relative] = cam["center"].tolist()
            calibrated[relative] = {"camera": cam["camera"], "rotation": cam["R"].tolist(),
                                    "center": cam["center"].tolist()}
    if not exported_cameras:
        raise ReconstructionError("Reconstructed cameras do not match any uploaded images")
    client.report_progress(job_id, stage, 78, 0, total_images)
    for image_index, image_path in enumerate(image_paths, start=1):
        client.check_cancelled(job_id)
        relative = image_path.relative_to(images).as_posix()
        camera_name = image_names.get(relative, image_path.name)
        cam = cameras.get(camera_name)
        if not cam:
            if image_index % 10 == 0 or image_index == total_images:
                client.report_progress(job_id, stage, 78 + round(20 * image_index / total_images), image_index, total_images)
            continue
        image = cv2.imread(str(image_path))
        if image is None:
            raise ReconstructionError(f"Could not read reconstructed source image: {relative}")
        if cached is None:
            result = predict_tiled(model, image, tile_size=640, overlap_ratio=0.2, conf_threshold=0.25, nms_iou_threshold=0.5, batch_size=32)
            records = [{"bbox_xyxy": [float(x) for x in det.bbox_xyxy], "confidence": float(det.confidence), "class_name": det.class_name} for det in result.detections]
        else:
            records = cached[relative]
        detections = []
        for original in records:
            bbox = original['bbox_xyxy']
            confidence = original['confidence']
            class_name = original['class_name']
            record = {"bbox_xyxy": bbox, "confidence": confidence, "class_name": class_name}
            detections.append(record)
            if class_name.lower() not in {"bolt", "anchor", "belay"}:
                continue
            x = (bbox[0] + bbox[2]) / 2
            y = (bbox[1] + bbox[3]) / 2
            supported_detections += 1
            direction = camera_ray(cam, (x, y), image.shape)
            intersection = projector.intersect(cam["center"], direction)
            if intersection is None:
                record["mapping"] = "no_surface_hit"
                continue
            point, camera_distance, normal_dot = intersection
            record.update(mapping="mapped", hitIndex=len(hits))
            x1, y1 = max(0, int(x) - 160), max(0, int(y) - 160)
            x2, y2 = min(image.shape[1], int(x) + 160), min(image.shape[0], int(y) + 160)
            crop_name = f"hit_{len(hits):05d}.jpg"
            crop = image[y1:y2, x1:x2].copy()
            cv2.circle(crop, (int(x) - x1, int(y) - y1), 18, (0, 255, 255), 2)
            if not cv2.imwrite(str(out / crop_name), crop):
                raise ReconstructionError("Could not write a detection crop")
            pixel = np.array([x * cam["width"] / image.shape[1], y * cam["height"] / image.shape[0]])
            edge_dist = float(np.linalg.norm((pixel - [cam["width"] / 2, cam["height"] / 2]) / [cam["width"], cam["height"]]))
            hits.append({"pos": point.tolist(), "cam_pos": cam["center"].tolist(), "conf": confidence, "class": class_name, "img": relative, "crop": crop_name, "uv": [x, y], "cam_dist": camera_distance, "normal_dot": normal_dot, "edge_dist": edge_dist,
                         "positioning": {"method": "vertex" if placement_method == "vertex" else "triangle",
                                         "surfacePosition": point.tolist(), "ray": direction.tolist(),
                                         "calibrationPixel": pixel.tolist(),
                                         "incidenceAngleDeg": float(np.degrees(np.arccos(np.clip(normal_dot, 0, 1)))),
                                         "fallbackReason": "insufficient_views" if placement_method == "multiview" else None}})
            observations.append({"cam": cam, "ray": direction, "pixel": pixel,
                                 "surface": point, "distance": camera_distance, "confidence": confidence})
            if len(hits) >= 1500:
                break
        frame_results.append({"image": relative, "detections": detections})
        if image_index % 10 == 0 or image_index == total_images:
            client.report_progress(job_id, stage, 78 + round(20 * image_index / total_images), image_index, total_images)
        if len(hits) >= 1500:
            break
    tracks = []
    if placement_method == "multiview":
        from .multiview import refine_hits
        tracks = refine_hits(hits, observations, lambda: client.check_cancelled(job_id))
    (out / "detections.json").write_text(json.dumps({"frames": frame_results, "calibration": calibrated}, indent=2))
    project = {"name": job_name, "hits": hits, "gps": [], "cameras": exported_cameras, "coordinateSystem": coordinate_system,
               "mapping": {"detections": supported_detections, "mapped": len(hits),
                           "unmapped": supported_detections - len(hits),
                           "truncated": len(hits) >= 1500},
               "positioning": {"requestedMethod": placement_method, "tracks": tracks,
                               "refinedObservations": sum(h["positioning"]["method"] == "multiview" for h in hits)}}
    (out / "project.json").write_text(json.dumps(project, indent=2))
    if supported_detections and not hits:
        raise ReconstructionError("Detections were found, but none intersected the model. Check camera calibration and mesh alignment.")


def get_detection_model(model_path: Path):
    global DETECTION_MODEL
    if DETECTION_MODEL is None:
        if sys.platform == "win32":
            pathlib.PosixPath = pathlib.WindowsPath
        from ultralytics import YOLO
        DETECTION_MODEL = YOLO(str(model_path))
    return DETECTION_MODEL

