"""Batched tiled inference for YOLO models.

Replaces SAHI's get_sliced_prediction with GPU-batched inference,
processing multiple tiles in a single forward pass for significantly
higher throughput on high-resolution images and video frames.
"""

import numpy as np
import torch
from torchvision.ops import nms
from ultralytics import YOLO

from felslager_processing.detection.domain.detection import Detection, FrameResult


def compute_tile_bboxes(
    image_height: int,
    image_width: int,
    tile_height: int = 640,
    tile_width: int = 640,
    overlap_height_ratio: float = 0.2,
    overlap_width_ratio: float = 0.2,
) -> list[list[int]]:
    """Compute tile bounding boxes matching SAHI's get_slice_bboxes exactly.

    Returns list of [x_min, y_min, x_max, y_max] for each tile.
    """
    y_overlap = int(overlap_height_ratio * tile_height)
    x_overlap = int(overlap_width_ratio * tile_width)

    slice_bboxes = []
    y_max = y_min = 0

    while y_max < image_height:
        x_min = x_max = 0
        y_max = y_min + tile_height
        while x_max < image_width:
            x_max = x_min + tile_width
            if y_max > image_height or x_max > image_width:
                xmax = min(image_width, x_max)
                ymax = min(image_height, y_max)
                xmin = max(0, xmax - tile_width)
                ymin = max(0, ymax - tile_height)
                slice_bboxes.append([xmin, ymin, xmax, ymax])
            else:
                slice_bboxes.append([x_min, y_min, x_max, y_max])
            x_min = x_max - x_overlap
        y_min = y_max - y_overlap

    return slice_bboxes


def extract_tiles(
    image: np.ndarray, tile_bboxes: list[list[int]]
) -> list[np.ndarray]:
    """Extract tile crops from an image given bounding boxes."""
    return [image[y_min:y_max, x_min:x_max] for x_min, y_min, x_max, y_max in tile_bboxes]


def predict_tiles_batched(
    model: YOLO,
    tiles: list[np.ndarray],
    tile_bboxes: list[list[int]],
    conf_threshold: float = 0.3,
    batch_size: int = 32,
) -> list[Detection]:
    """Run batched YOLO inference on tiles and remap to full-image coordinates.

    Processes tiles in chunks of batch_size via model.predict(list_of_arrays),
    which internally stacks them into a single GPU tensor for one forward pass.
    """
    all_detections = []
    names = None

    for i in range(0, len(tiles), batch_size):
        chunk_tiles = tiles[i : i + batch_size]
        chunk_bboxes = tile_bboxes[i : i + batch_size]

        results = model.predict(
            source=chunk_tiles,
            conf=conf_threshold,
            save=False,
            verbose=False,
        )

        if names is None:
            names = results[0].names

        for result, (x_min, y_min, _x_max, _y_max) in zip(results, chunk_bboxes):
            boxes = result.boxes
            if len(boxes) == 0:
                continue

            xyxy = boxes.xyxy.cpu().numpy()
            confs = boxes.conf.cpu().numpy()
            cls_ids = boxes.cls.cpu().numpy().astype(int)

            # Remap to full-image coordinates
            xyxy[:, 0] += x_min
            xyxy[:, 1] += y_min
            xyxy[:, 2] += x_min
            xyxy[:, 3] += y_min

            for bbox, conf, cls_id in zip(xyxy, confs, cls_ids):
                all_detections.append(
                    Detection(
                        bbox_xyxy=bbox,
                        confidence=float(conf),
                        class_id=int(cls_id),
                        class_name=names[int(cls_id)],
                    )
                )

    return all_detections


def merge_detections_nms(
    detections: list[Detection], iou_threshold: float = 0.5
) -> list[Detection]:
    """Merge overlapping detections using class-aware NMS via torchvision."""
    if not detections:
        return []

    boxes = torch.tensor(
        np.array([d.bbox_xyxy for d in detections]), dtype=torch.float32
    )
    scores = torch.tensor(
        [d.confidence for d in detections], dtype=torch.float32
    )
    class_ids = torch.tensor(
        [d.class_id for d in detections], dtype=torch.int64
    )

    # Class-aware NMS: offset boxes by class_id so different classes don't suppress each other
    max_coordinate = boxes.max()
    offsets = class_ids.float() * (max_coordinate + 1)
    boxes_for_nms = boxes + offsets[:, None]

    keep_indices = nms(boxes_for_nms, scores, iou_threshold)
    return [detections[i] for i in keep_indices.tolist()]


def predict_tiled(
    model: YOLO,
    image: np.ndarray,
    tile_size: int = 640,
    overlap_ratio: float = 0.2,
    conf_threshold: float = 0.3,
    nms_iou_threshold: float = 0.5,
    batch_size: int = 32,
) -> FrameResult:
    """Run batched tiled inference on an image.

    Main entry point replacing sahi.predict.get_sliced_prediction.
    Chains: compute tiles -> extract -> batch predict -> NMS merge.
    """
    h, w = image.shape[:2]

    tile_bboxes = compute_tile_bboxes(
        image_height=h,
        image_width=w,
        tile_height=tile_size,
        tile_width=tile_size,
        overlap_height_ratio=overlap_ratio,
        overlap_width_ratio=overlap_ratio,
    )
    tiles = extract_tiles(image, tile_bboxes)

    raw_detections = predict_tiles_batched(
        model, tiles, tile_bboxes, conf_threshold=conf_threshold, batch_size=batch_size
    )
    merged = merge_detections_nms(raw_detections, iou_threshold=nms_iou_threshold)

    return FrameResult(detections=merged, image_width=w, image_height=h)
