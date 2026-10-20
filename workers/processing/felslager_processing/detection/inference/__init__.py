"""Batched tiled inference for YOLO models."""

from felslager_processing.detection.inference.tiled_inference import (
    compute_tile_bboxes,
    extract_tiles,
    merge_detections_nms,
    predict_tiled,
    predict_tiles_batched,
)
from felslager_processing.detection.inference.util import auto_select_torch_device, draw_detections

__all__ = [
    "compute_tile_bboxes",
    "draw_detections",
    "extract_tiles",
    "merge_detections_nms",
    "predict_tiled",
    "predict_tiles_batched",
    "auto_select_torch_device",
]
