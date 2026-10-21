"""Bolt inference and calibrated projection onto the reconstruction mesh."""
import json
import os
from pathlib import Path
import pathlib
import sys

import cv2

from .. import api as client
from ..errors import ReconstructionError
from ..reconstruction import MeshProjector, camera_ray, load_cameras

MODEL = Path(os.environ.get("BOLT_MODEL_PATH", str(Path(__file__).resolve().parents[2] / "models/bolt_detector_v3_yolo26s.pt")))
DETECTION_MODEL = None


def run_detection(job_id: str, images: Path, model_path: Path, model_glb: Path, reconstruction: Path, out: Path, job_name: str, image_names: dict[str, str], coordinate_system: str = "Z_UP"):
    import trimesh
    from felslager_processing.detection.inference import predict_tiled

    model = get_detection_model(model_path)
    geometry = trimesh.load(model_glb, force="mesh", process=False, skip_materials=True)
    projector = MeshProjector(geometry.vertices, geometry.faces)
    cameras = load_cameras(reconstruction)
    hits = []
    frame_results = []
    exported_cameras = {}
    supported_detections = 0
    image_paths = sorted(p for p in images.rglob("*") if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"})
    total_images = len(image_paths)
    if not total_images:
        raise RuntimeError("No supported source images were found for bolt detection")
    # Cameras belong to reconstructed images even when YOLO finds no bolts.
    for image_path in image_paths:
        relative = image_path.relative_to(images).as_posix()
        cam = cameras.get(image_names.get(relative, image_path.name))
        if cam:
            exported_cameras[relative] = cam["center"].tolist()
    if not exported_cameras:
        raise ReconstructionError("Reconstructed cameras do not match any uploaded images")
    client.report_progress(job_id, "detecting", 78, 0, total_images)
    for image_index, image_path in enumerate(image_paths, start=1):
        client.check_cancelled(job_id)
        relative = image_path.relative_to(images).as_posix()
        camera_name = image_names.get(relative, image_path.name)
        cam = cameras.get(camera_name)
        if not cam:
            if image_index % 10 == 0 or image_index == total_images:
                client.report_progress(job_id, "detecting", 78 + round(20 * image_index / total_images), image_index, total_images)
            continue
        image = cv2.imread(str(image_path))
        if image is None:
            raise ReconstructionError(f"Could not read reconstructed source image: {relative}")
        result = predict_tiled(model, image, tile_size=640, overlap_ratio=0.2, conf_threshold=0.25, nms_iou_threshold=0.5, batch_size=32)
        detections = []
        for det in result.detections:
            bbox = [float(x) for x in det.bbox_xyxy]
            detections.append({"bbox_xyxy": bbox, "confidence": float(det.confidence), "class_name": det.class_name})
            if det.class_name.lower() not in {"bolt", "anchor", "belay"}:
                continue
            x = (bbox[0] + bbox[2]) / 2
            y = (bbox[1] + bbox[3]) / 2
            supported_detections += 1
            direction = camera_ray(cam, (x, y), image.shape)
            intersection = projector.intersect(cam["center"], direction)
            if intersection is None:
                continue
            point, camera_distance, normal_dot = intersection
            x1, y1 = max(0, int(x) - 160), max(0, int(y) - 160)
            x2, y2 = min(image.shape[1], int(x) + 160), min(image.shape[0], int(y) + 160)
            crop_name = f"hit_{len(hits):05d}.jpg"
            crop = image[y1:y2, x1:x2].copy()
            cv2.circle(crop, (int(x) - x1, int(y) - y1), 18, (0, 255, 255), 2)
            if not cv2.imwrite(str(out / crop_name), crop):
                raise ReconstructionError("Could not write a detection crop")
            hits.append({"pos": point.tolist(), "cam_pos": cam["center"].tolist(), "conf": float(det.confidence), "class": det.class_name, "img": relative, "crop": crop_name, "uv": [x, y], "cam_dist": camera_distance, "normal_dot": normal_dot, "edge_dist": 0})
            if len(hits) >= 1500:
                break
        frame_results.append({"image": relative, "detections": detections})
        if image_index % 10 == 0 or image_index == total_images:
            client.report_progress(job_id, "detecting", 78 + round(20 * image_index / total_images), image_index, total_images)
        if len(hits) >= 1500:
            break
    (out / "detections.json").write_text(json.dumps({"frames": frame_results}, indent=2))
    project = {"name": job_name, "hits": hits, "gps": [], "cameras": exported_cameras, "coordinateSystem": coordinate_system,
               "mapping": {"detections": supported_detections, "mapped": len(hits)}}
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

