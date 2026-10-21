import numpy as np
from pydantic import BaseModel, ConfigDict


class Detection(BaseModel):
    """A single detection in full-image coordinates."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    bbox_xyxy: np.ndarray  # [x1, y1, x2, y2]
    confidence: float
    class_id: int
    class_name: str


class FrameResult(BaseModel):
    """Detections for a single image/frame."""

    detections: list[Detection] = []
    image_width: int = 0
    image_height: int = 0
