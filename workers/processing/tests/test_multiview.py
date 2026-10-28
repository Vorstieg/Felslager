"""Known-camera fixtures verify geometry, conservative matching and fallbacks."""
from copy import deepcopy

import numpy as np
import pytest

from felslager_processing.detection.multiview import estimate, refine_hits
from felslager_processing.reconstruction import camera_ray, project_pixels


def fixture(point=None, scale=1., count=5):
    point = np.array([.1, .15, 10.] if point is None else point) * scale
    hits, observations = [], []
    for i, x in enumerate(np.linspace(-1, 1, count)):
        camera = {"projection_type": "brown", "focal_x": 1., "focal_y": .95,
                  "width": 1000, "height": 800, "c_x": .01, "c_y": -.02,
                  "k1": .03, "k2": -.01, "p1": .001, "p2": -.002}
        cam = {"camera": camera, "width": 1000, "height": 800, "R": np.eye(3),
               "center": np.array([x, (i % 2) * .15, 0.]) * scale}
        pixel = project_pixels(cam, [point])[0]
        ray = camera_ray(cam, tuple(pixel), (800, 1000))
        surface = cam["center"] + ray * ((10.2 * scale) / ray[2])
        distance = np.linalg.norm(surface - cam["center"])
        observations.append(dict(cam=cam, pixel=pixel, ray=ray, surface=surface,
                                 distance=distance, confidence=.9))
        hits.append(dict(pos=surface.tolist(), cam_dist=distance, img=f"{i}.jpg", **{"class": "bolt"},
                         positioning={"method": "triangle", "fallbackReason": "insufficient_views",
                                      "surfacePosition": surface.tolist()}))
    return point, hits, observations


@pytest.mark.parametrize("scale", [.01, 1, 100])
def test_multiview_recovers_point_off_mesh_and_preserves_observations(scale):
    point, hits, observations = fixture(scale=scale)
    originals = deepcopy(hits)
    tracks = refine_hits(hits, observations)
    assert len(tracks) == 1 and tracks[0]["hitIndices"] == list(range(5))
    assert tracks[0]["reprojectionRmsPx"] < 1e-6
    for hit, original in zip(hits, originals):
        np.testing.assert_allclose(hit["pos"], point, atol=1e-7)
        assert hit["positioning"]["surfacePosition"] == original["pos"]
        assert hit["positioning"]["method"] == "multiview"
        assert hit["positioning"]["surfaceOffset"] > 0


def test_consensus_rejects_a_bad_detection():
    point, _, observations = fixture()
    observations[-1]["pixel"] = observations[-1]["pixel"] + [0, 35]
    observations[-1]["ray"] = camera_ray(observations[-1]["cam"], tuple(observations[-1]["pixel"]), (800, 1000))
    result = estimate(observations)
    assert result is not None
    fitted, mask, _, _ = result
    np.testing.assert_allclose(fitted, point, atol=1e-6)
    assert mask.tolist() == [True, True, True, True, False]


def test_refinement_improves_noisy_detections():
    point, _, observations = fixture(count=7)
    for o, noise in zip(observations, [[.3, -.4], [-.2, .3], [.5, .1], [-.3, -.2], [.2, .4], [-.4, .2], [.1, -.3]]):
        o["pixel"] += noise
        o["ray"] = camera_ray(o["cam"], tuple(o["pixel"]), (800, 1000))
    fitted, mask, residuals, _ = estimate(observations)
    assert mask.all() and residuals.max() < 1
    assert np.linalg.norm(fitted - point) < .03


@pytest.mark.parametrize("kind", ["single", "two", "parallel", "same_image", "different_classes", "far_from_mesh"])
def test_insufficient_or_inconsistent_evidence_keeps_triangle_positions(kind):
    _, hits, observations = fixture()
    if kind in {"single", "two"}:
        n = 1 if kind == "single" else 2
        hits, observations = hits[:n], observations[:n]
    elif kind == "parallel":
        for o in observations:
            o["ray"] = observations[0]["ray"].copy()
    elif kind == "same_image":
        for h in hits:
            h["img"] = "same.jpg"
    elif kind == "different_classes":
        for i, h in enumerate(hits):
            h["class"] = str(i)
    elif kind == "far_from_mesh":
        for o in observations:
            o["surface"] += [0, 0, 10]
    originals = [h["pos"][:] for h in hits]
    assert refine_hits(hits, observations) == []
    assert [h["pos"] for h in hits] == originals


def test_duplicate_detections_in_each_image_are_ambiguous():
    _, hits, observations = fixture(count=3)
    originals = deepcopy(hits)
    hits.extend(deepcopy(hits))
    observations.extend(deepcopy(observations))
    assert refine_hits(hits, observations) == []
    assert all(h["positioning"]["fallbackReason"] == "ambiguous_match" for h in hits)
    assert [h["pos"] for h in hits] == [h["pos"] for h in originals] * 2


def test_nearby_bolts_in_same_images_stay_separate():
    _, hits_a, obs_a = fixture(point=[-.3, .1, 10])
    _, hits_b, obs_b = fixture(point=[.3, .1, 10])
    tracks = refine_hits(hits_a + hits_b, obs_a + obs_b)
    assert len(tracks) == 2
    assert tracks[0]["hitIndices"] == list(range(5))
    assert tracks[1]["hitIndices"] == list(range(5, 10))


def test_close_bolts_with_overlapping_candidate_regions_never_merge():
    _, hits_a, obs_a = fixture(point=[0, .1, 10])
    _, hits_b, obs_b = fixture(point=[.08, .1, 10])
    hits = hits_a + hits_b
    tracks = refine_hits(hits, obs_a + obs_b)
    # Either conservative fallback or correct disambiguation is acceptable;
    # a track containing observations of both physical bolts is not.
    for track in tracks:
        members = set(track["hitIndices"])
        assert members <= set(range(5)) or members <= set(range(5, 10))
        expected = [0, .1, 10] if min(members) < 5 else [.08, .1, 10]
        np.testing.assert_allclose(track["position"], expected, atol=1e-6)


def test_triangulation_rejects_points_behind_cameras():
    _, _, observations = fixture(point=[.1, .1, -10])
    assert estimate(observations) is None


def test_empty_and_cancellation():
    assert refine_hits([], []) == []
    _, hits, observations = fixture()
    def cancelled():
        raise RuntimeError("cancelled")
    with pytest.raises(RuntimeError, match="cancelled"):
        refine_hits(hits, observations, cancelled)


def test_projection_round_trip_with_rotated_camera_and_resized_image():
    import cv2
    _, _, observations = fixture()
    cam = observations[0]["cam"]
    cam["R"] = cv2.Rodrigues(np.array([.1, -.2, .3]))[0]
    point = cam["center"] + cam["R"].T @ np.array([.5, .4, 8.])
    pixel = project_pixels(cam, [point])[0]
    expected = point - cam["center"]; expected /= np.linalg.norm(expected)
    np.testing.assert_allclose(camera_ray(cam, tuple(pixel * .5), (400, 500)), expected, atol=1e-8)


def test_detection_pipeline_exports_refined_tracks_and_source_evidence(monkeypatch, tmp_path):
    import json
    import sys
    from types import SimpleNamespace
    from unittest.mock import Mock
    import cv2
    from felslager_processing import api
    from felslager_processing.detection import runner

    point, _, observations = fixture()
    images, out = tmp_path / "images", tmp_path / "out"
    images.mkdir(); out.mkdir()
    cameras, shots, predictions = {}, {}, []
    for i, o in enumerate(observations):
        name = f"{i}.jpg"
        cv2.imwrite(str(images / name), np.zeros((800, 1000, 3), dtype=np.uint8))
        cameras[name] = o["cam"]["camera"]
        shots[name] = dict(camera=name, rotation=[0, 0, 0], translation=(-o["cam"]["center"]).tolist())
        x, y = o["pixel"]
        predictions.append(SimpleNamespace(detections=[SimpleNamespace(
            bbox_xyxy=[x - 5, y - 5, x + 5, y + 5], confidence=.9, class_name="bolt")]))
    reconstruction = tmp_path / "cameras.json"
    reconstruction.write_text(json.dumps(dict(cameras=cameras, shots=shots)))
    geometry = SimpleNamespace(vertices=np.array([[-100, -100, 10.2], [100, -100, 10.2], [0, 100, 10.2]]),
                               faces=np.array([[0, 1, 2]]))
    monkeypatch.setitem(sys.modules, "trimesh", SimpleNamespace(load=Mock(return_value=geometry)))
    monkeypatch.setitem(sys.modules, "felslager_processing.detection.inference",
                        SimpleNamespace(predict_tiled=Mock(side_effect=predictions)))
    monkeypatch.setattr(runner, "get_detection_model", Mock())
    monkeypatch.setattr(api, "check_cancelled", Mock())
    monkeypatch.setattr(api, "report_progress", Mock())
    runner.run_detection("job", images, tmp_path / "weights", tmp_path / "model.glb",
                         reconstruction, out, "Wall", {}, placement_method="multiview")
    project = json.loads((out / "project.json").read_text())
    assert project["positioning"]["refinedObservations"] == 5
    assert len(project["positioning"]["tracks"]) == 1
    assert project["mapping"] == dict(detections=5, mapped=5, unmapped=0, truncated=False)
    for hit in project["hits"]:
        np.testing.assert_allclose(hit["pos"], point, atol=1e-6)
        assert hit["positioning"]["trackId"] == "track_00000"
        assert hit["positioning"]["surfacePosition"][2] == pytest.approx(10.2)
        assert (out / hit["crop"]).is_file()
    detections = json.loads((out / "detections.json").read_text())
    assert len(detections["calibration"]) == 5
    assert [f["detections"][0]["hitIndex"] for f in detections["frames"]] == list(range(5))
