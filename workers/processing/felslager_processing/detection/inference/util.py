import cv2
import numpy as np
import torch

from felslager_processing.detection.domain import Detection


def auto_select_torch_device(device: str = "auto") -> str:
    if not device or device == "auto":
        if torch.cuda.is_available():
            device = "cuda"
        elif torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    return device


_CLASS_COLORS = [
    (0, 255, 0),    # green
    (0, 128, 255),  # orange
    (255, 0, 128),  # magenta
    (255, 255, 0),  # cyan
    (128, 0, 255),  # purple
    (0, 255, 255),  # yellow
]


def draw_detections(
    image: np.ndarray, detections: list[Detection], conf_threshold: float = 0.0
) -> np.ndarray:
    """Draw bounding boxes and labels on an image (returns a copy).

    Only detections with confidence >= conf_threshold are drawn.
    Each class gets a distinct color, cycling through a fixed palette.
    """
    annotated = image.copy()
    for det in detections:
        if det.confidence < conf_threshold:
            continue
        color = _CLASS_COLORS[(det.class_id - 1) % len(_CLASS_COLORS)]
        x1, y1, x2, y2 = det.bbox_xyxy.astype(int)
        cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)
        label = f"{det.class_name}: {det.confidence:.2f}"
        cv2.putText(
            annotated, label, (x1, y1 - 10),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2,
        )
    return annotated
