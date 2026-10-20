"""Tests for felslager_processing.detection.inference.tiled_inference."""

import numpy as np
import pytest
from sahi.slicing import get_slice_bboxes

from felslager_processing.detection.inference.tiled_inference import (
    compute_tile_bboxes,
    extract_tiles,
    merge_detections_nms,
)
from felslager_processing.detection.inference import draw_detections
from felslager_processing.detection.domain.detection import Detection

# ---------------------------------------------------------------------------
# 1. Tile coordinate tests — must match SAHI exactly
# ---------------------------------------------------------------------------

TILE_TEST_CASES = [
    # (image_height, image_width, tile_size, overlap_ratio)
    (2160, 3840, 640, 0.2),   # 4K landscape
    (1080, 1920, 640, 0.2),   # 1080p landscape
    (4000, 6000, 640, 0.2),   # high-res photo
    (640, 640, 640, 0.2),     # exact single tile
    (700, 500, 640, 0.2),     # smaller than tile in one dimension
    (1280, 1280, 640, 0.2),   # exact 2x2 before overlap
    (641, 641, 640, 0.2),     # just over one tile
    (100, 100, 640, 0.2),     # much smaller than tile
    (3000, 4000, 512, 0.3),   # different tile size and overlap
    (2160, 3840, 640, 0.0),   # zero overlap
    (2160, 3840, 640, 0.5),   # large overlap
]


@pytest.mark.parametrize("image_height,image_width,tile_size,overlap_ratio", TILE_TEST_CASES)
def test_tile_bboxes_match_sahi(image_height, image_width, tile_size, overlap_ratio):
    """Our compute_tile_bboxes must produce identical output to SAHI's get_slice_bboxes."""
    ours = compute_tile_bboxes(
        image_height, image_width,
        tile_height=tile_size, tile_width=tile_size,
        overlap_height_ratio=overlap_ratio, overlap_width_ratio=overlap_ratio,
    )
    sahi = get_slice_bboxes(
        image_height, image_width,
        slice_height=tile_size, slice_width=tile_size,
        overlap_height_ratio=overlap_ratio, overlap_width_ratio=overlap_ratio,
    )
    assert ours == sahi


@pytest.mark.parametrize("image_height,image_width,tile_size,overlap_ratio", TILE_TEST_CASES)
def test_tiles_cover_full_image(image_height, image_width, tile_size, overlap_ratio):
    """Every pixel of the image must be covered by at least one tile."""
    tiles = compute_tile_bboxes(
        image_height, image_width,
        tile_height=tile_size, tile_width=tile_size,
        overlap_height_ratio=overlap_ratio, overlap_width_ratio=overlap_ratio,
    )
    coverage = np.zeros((image_height, image_width), dtype=bool)
    for x_min, y_min, x_max, y_max in tiles:
        coverage[y_min:y_max, x_min:x_max] = True
    assert coverage.all(), "Not all pixels are covered by tiles"


@pytest.mark.parametrize("image_height,image_width,tile_size,overlap_ratio", TILE_TEST_CASES)
def test_tiles_have_correct_dimensions(image_height, image_width, tile_size, overlap_ratio):
    """Every tile must have exactly tile_size x tile_size (clamped to image bounds)."""
    tiles = compute_tile_bboxes(
        image_height, image_width,
        tile_height=tile_size, tile_width=tile_size,
        overlap_height_ratio=overlap_ratio, overlap_width_ratio=overlap_ratio,
    )
    for x_min, y_min, x_max, y_max in tiles:
        w = x_max - x_min
        h = y_max - y_min
        assert w == min(tile_size, image_width), f"Tile width {w} != expected {min(tile_size, image_width)}"
        assert h == min(tile_size, image_height), f"Tile height {h} != expected {min(tile_size, image_height)}"


@pytest.mark.parametrize("image_height,image_width,tile_size,overlap_ratio", TILE_TEST_CASES)
def test_tiles_within_image_bounds(image_height, image_width, tile_size, overlap_ratio):
    """No tile should extend outside the image."""
    tiles = compute_tile_bboxes(
        image_height, image_width,
        tile_height=tile_size, tile_width=tile_size,
        overlap_height_ratio=overlap_ratio, overlap_width_ratio=overlap_ratio,
    )
    for x_min, y_min, x_max, y_max in tiles:
        assert x_min >= 0
        assert y_min >= 0
        assert x_max <= image_width
        assert y_max <= image_height


def test_extract_tiles_shapes():
    """extract_tiles should produce arrays with the correct shapes from tile bboxes."""
    image = np.random.randint(0, 255, (1080, 1920, 3), dtype=np.uint8)
    bboxes = compute_tile_bboxes(1080, 1920, 640, 640, 0.2, 0.2)
    tiles = extract_tiles(image, bboxes)
    assert len(tiles) == len(bboxes)
    for tile, (x_min, y_min, x_max, y_max) in zip(tiles, bboxes):
        assert tile.shape == (y_max - y_min, x_max - x_min, 3)


def test_extract_tiles_content():
    """extract_tiles should return the correct pixel data from the source image."""
    image = np.arange(100 * 100 * 3, dtype=np.uint8).reshape(100, 100, 3)
    bboxes = [[10, 20, 50, 60]]
    tiles = extract_tiles(image, bboxes)
    expected = image[20:60, 10:50]
    np.testing.assert_array_equal(tiles[0], expected)


# ---------------------------------------------------------------------------
# 2. NMS merge tests
# ---------------------------------------------------------------------------

def _det(bbox, conf, cls_id=0, cls_name="bolt"):
    return Detection(bbox_xyxy=np.array(bbox, dtype=np.float32), confidence=conf, class_id=cls_id, class_name=cls_name)


def test_nms_empty_input():
    assert merge_detections_nms([]) == []


def test_nms_single_detection():
    dets = [_det([10, 10, 50, 50], 0.9)]
    merged = merge_detections_nms(dets)
    assert len(merged) == 1
    np.testing.assert_array_equal(merged[0].bbox_xyxy, dets[0].bbox_xyxy)


def test_nms_suppresses_high_iou_same_class():
    """Two nearly identical boxes of the same class: only the higher-confidence one survives."""
    dets = [
        _det([10, 10, 50, 50], 0.9, 0, "bolt"),
        _det([12, 12, 52, 52], 0.8, 0, "bolt"),
    ]
    merged = merge_detections_nms(dets, iou_threshold=0.5)
    assert len(merged) == 1
    assert merged[0].confidence == 0.9


def test_nms_keeps_low_iou_same_class():
    """Two distant boxes of the same class: both survive."""
    dets = [
        _det([10, 10, 50, 50], 0.9, 0, "bolt"),
        _det([200, 200, 240, 240], 0.8, 0, "bolt"),
    ]
    merged = merge_detections_nms(dets, iou_threshold=0.5)
    assert len(merged) == 2


def test_nms_class_aware():
    """Identical boxes of different classes must both survive (class-aware NMS)."""
    dets = [
        _det([10, 10, 50, 50], 0.9, 0, "bolt"),
        _det([10, 10, 50, 50], 0.6, 1, "anchor"),
    ]
    merged = merge_detections_nms(dets, iou_threshold=0.5)
    assert len(merged) == 2
    class_names = {d.class_name for d in merged}
    assert class_names == {"bolt", "anchor"}


def test_nms_mixed_scenario():
    """Combination: overlapping same-class + separate + different-class overlap."""
    dets = [
        _det([10, 10, 50, 50], 0.9, 0, "bolt"),      # kept
        _det([12, 12, 52, 52], 0.8, 0, "bolt"),      # suppressed by above
        _det([200, 200, 240, 240], 0.7, 0, "bolt"),  # kept (separate)
        _det([10, 10, 50, 50], 0.6, 1, "anchor"),    # kept (different class)
    ]
    merged = merge_detections_nms(dets, iou_threshold=0.5)
    assert len(merged) == 3
    confs = sorted([d.confidence for d in merged], reverse=True)
    assert confs == [0.9, 0.7, 0.6]


def test_nms_respects_iou_threshold():
    """Partially overlapping boxes: suppressed at low threshold, kept at high threshold."""
    # Two boxes: intersection=[20,20,60,60]=40*40=1600, union=3600+3600-1600=5600, IoU≈0.286
    dets = [
        _det([0, 0, 60, 60], 0.9, 0, "bolt"),
        _det([20, 20, 80, 80], 0.8, 0, "bolt"),
    ]
    # Threshold below IoU → suppresses
    merged_strict = merge_detections_nms(dets, iou_threshold=0.2)
    assert len(merged_strict) == 1

    # Threshold above IoU → keeps both
    merged_lenient = merge_detections_nms(dets, iou_threshold=0.8)
    assert len(merged_lenient) == 2


def test_nms_preserves_detection_data():
    """NMS should return the original Detection objects (by identity), not copies."""
    dets = [
        _det([10, 10, 50, 50], 0.9, 0, "bolt"),
        _det([200, 200, 240, 240], 0.7, 1, "anchor"),
    ]
    original_ids = {id(d) for d in dets}
    merged = merge_detections_nms(dets, iou_threshold=0.5)
    assert len(merged) == 2
    for d in merged:
        assert id(d) in original_ids


# ---------------------------------------------------------------------------
# 3. draw_detections tests
# ---------------------------------------------------------------------------

def test_draw_detections_returns_copy():
    """draw_detections must not modify the original image."""
    img = np.zeros((200, 200, 3), dtype=np.uint8)
    original = img.copy()
    dets = [_det([10, 20, 80, 90], 0.85, 0, "bolt")]
    annotated = draw_detections(img, dets)
    np.testing.assert_array_equal(img, original)
    assert annotated is not img


def test_draw_detections_modifies_pixels():
    """draw_detections must actually draw something on the returned image."""
    img = np.zeros((200, 200, 3), dtype=np.uint8)
    dets = [_det([10, 20, 80, 90], 0.85, 0, "bolt")]
    annotated = draw_detections(img, dets)
    assert not np.array_equal(annotated, img)


def test_draw_detections_filters_by_conf_threshold():
    """Only detections above conf_threshold should be drawn."""
    img = np.zeros((200, 200, 3), dtype=np.uint8)
    dets = [
        _det([10, 20, 80, 90], 0.3, 0, "bolt"),
        _det([100, 100, 180, 180], 0.8, 0, "bolt"),
    ]
    # High threshold: only the 0.8 detection drawn
    annotated_high = draw_detections(img, dets, conf_threshold=0.5)
    # Low threshold: both drawn
    annotated_low = draw_detections(img, dets, conf_threshold=0.1)
    # Very high threshold: nothing drawn
    annotated_none = draw_detections(img, dets, conf_threshold=0.9)

    assert not np.array_equal(annotated_high, img), "Should draw the 0.8 detection"
    assert not np.array_equal(annotated_low, annotated_high), "More detections at lower threshold"
    np.testing.assert_array_equal(annotated_none, img, err_msg="Nothing should be drawn above 0.9")
