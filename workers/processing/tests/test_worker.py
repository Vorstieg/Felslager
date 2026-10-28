"""Regressions for missing camera exports and incorrect/limited 3D projection."""
import io
import json
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest
import cv2

import requests
from felslager_processing import api as client, artifacts, capture, results, __main__ as cli
from felslager_processing.detection import runner as detection_runtime
from felslager_processing.engines import odm
from felslager_processing.reconstruction import ReconstructionError, MeshProjector, VertexProjector, camera_records, camera_ray


def scene():
    return [{"cameras": {"c": {"projection_type": "brown", "width": 100, "height": 100,
                              "focal_x": 0.5, "focal_y": 1.0}},
             "shots": {"image_000000.jpg": {"camera": "c", "rotation": [0, 0, 0], "translation": [0, 0, 0]}}}]


@pytest.fixture
def worker(monkeypatch, prefect_backend):
    from felslager_processing import worker as module
    monkeypatch.setattr(client, "API", "http://example.invalid")
    monkeypatch.setattr(client, "TOKEN", "test-token")
    monkeypatch.setattr(odm, "ODM", "http://example.invalid")
    monkeypatch.setattr(client, "ACTIVE_RUN_ID", None)
    monkeypatch.setattr(detection_runtime, "DETECTION_MODEL", None)
    monkeypatch.setattr(client, "check_cancelled", Mock())
    monkeypatch.setattr(client, "report_progress", Mock())
    return module


def test_brown_intrinsics_and_image_y_axis():
    cam = camera_records(scene())["image_000000.jpg"]
    ray = camera_ray(cam, (75, 75), (100, 100, 3))
    np.testing.assert_allclose(ray, np.array([0.5, 0.25, 1]) / np.linalg.norm([0.5, 0.25, 1]))
    # Resizing source images must preserve the ray, not their pixel coordinates.
    np.testing.assert_allclose(camera_ray(cam, (150, 150), (200, 200, 3)), ray)


def test_distorted_rotated_camera_round_trip():
    s = scene(); c = s[0]["cameras"]["c"]
    c.update(c_x=.03, c_y=-.02, k1=.08, k2=-.03, p1=.002, p2=-.001, k3=.001)
    shot = s[0]["shots"]["image_000000.jpg"]
    shot.update(rotation=[.1, -.2, .3], translation=[1, 2, -3])
    cam = camera_records(s)["image_000000.jpg"]
    world = cam["center"] + cam["R"].T @ np.array([2., 3., 10.])
    K = np.array([[50., 0, 53.], [0, 100., 48.], [0, 0, 1.]])
    pixel = cv2.projectPoints(world.reshape(1, 3), np.array(shot["rotation"]), np.array(shot["translation"], dtype=float), K, np.array([.08, -.03, .002, -.001, .001]))[0][0, 0]
    expected = world - cam["center"]; expected /= np.linalg.norm(expected)
    np.testing.assert_allclose(camera_ray(cam, tuple(pixel), (100, 100, 3)), expected, atol=1e-7)


def test_perspective_and_camera_validation():
    s = scene(); s[0]["cameras"]["c"] = {"projection_type": "perspective", "width": 100, "height": 100, "focal": .5}
    cam = camera_records(s)["image_000000.jpg"]
    np.testing.assert_allclose(camera_ray(cam, (50, 50), (100, 100)), [0, 0, 1])
    with pytest.raises(ReconstructionError, match="no calibrated cameras"):
        camera_records([{"shots": {}}])
    with pytest.raises(ReconstructionError, match="one connected"):
        camera_records(s + s)
    s[0]["cameras"]["c"]["projection_type"] = "fisheye"
    with pytest.raises(ReconstructionError, match="Unsupported camera"):
        camera_records(s)


def mesh(z=150):
    return SimpleNamespace(vertices=np.array([[-100, -100, z], [100, -100, z], [0, 100, z]], dtype=float), faces=np.array([[0, 1, 2]]))


def test_triangle_interior_beyond_80m_and_nearest_forward_hit():
    # No vertex is near the ray: nearest-vertex sampling used to miss the face.
    vertices = np.concatenate([mesh(200).vertices, mesh(150).vertices, mesh(-10).vertices])
    faces = np.array([[0, 1, 2], [3, 5, 4], [6, 7, 8]])  # Both windings supported.
    projector = MeshProjector(vertices, faces)
    point, distance, normal_dot = projector.intersect(np.zeros(3), np.array([0., 0., 1.]))
    np.testing.assert_allclose(point, [0, 0, 150])
    assert distance == 150 and normal_dot == 1
    assert projector.intersect(np.array([1000., 0, 0]), np.array([0., 0., 1.])) is None
    assert projector.intersect(np.zeros(3), np.array([1., 0., 0.])) is None


def archive_response(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    response = Mock()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    response.iter_content.return_value = [buffer.getvalue()]
    return response


def test_vertex_snapping_tolerance_forward_window_and_surface_weight():
    vertices = np.array([[.1, 0, 5], [.02, 0, 5], [0, 0, -2], [0, 0, .5], [0, 0, 50.]])
    projector = VertexProjector(vertices, np.tile([0., 0, 1], (5, 1)))
    point, distance, weight = projector.intersect(np.zeros(3), np.array([0., 0, 1]))
    np.testing.assert_allclose(point, [.02, 0, 5])
    assert distance == pytest.approx(np.linalg.norm(point)) and weight == 1
    assert projector.intersect(np.array([1., 0, 0]), np.array([0., 0, 1])) is None
    far = VertexProjector(vertices[2:], np.tile([0., 0, 1], (3, 1)))
    assert far.intersect(np.zeros(3), np.array([0., 0, 1])) is None
    # Exact triangles map sparse surfaces that legacy vertex snapping misses.
    sparse = mesh(5)
    assert MeshProjector(sparse.vertices, sparse.faces).intersect(np.zeros(3), np.array([0., 0, 1])) is not None
    assert VertexProjector(sparse.vertices, np.tile([0., 0, 1], (3, 1))).intersect(np.zeros(3), np.array([0., 0, 1])) is None


def test_unknown_placement_fails_before_loading_detector(tmp_path):
    with pytest.raises(ReconstructionError, match="Unsupported bolt placement"):
        detection_runtime.run_detection("job", tmp_path, tmp_path, tmp_path, tmp_path,
                                        tmp_path, "Wall", {}, placement_method="unknown")


def archive_files():
    return {"odm_texturing/odm_textured_model_geo.glb": b"model", "odm_texturing/odm_textured_model_geo.obj": b"mesh", "opensfm/reconstruction.json": json.dumps(scene())}


def test_download_checks_exact_camera_path_and_streams(worker, monkeypatch, tmp_path):
    response = archive_response(archive_files())
    get = Mock(return_value=response); monkeypatch.setattr(requests, "get", get)
    glb, cameras, obj = odm.download_reconstruction("task", tmp_path)
    assert glb.read_bytes() == b"model" and obj.read_bytes() == b"mesh"
    assert json.loads(cameras.read_text()) == scene()
    assert get.call_args.kwargs["stream"] is True


@pytest.mark.parametrize("missing", ["opensfm/reconstruction.json", "odm_texturing/odm_textured_model_geo.obj", "odm_texturing/odm_textured_model_geo.glb"])
def test_missing_archive_output_is_actionable(worker, monkeypatch, tmp_path, missing):
    files = archive_files(); del files[missing]
    files["opensfm/reports/reconstruction.json"] = "{}"  # Not a usable substitute.
    monkeypatch.setattr(requests, "get", Mock(return_value=archive_response(files)))
    with pytest.raises(ReconstructionError, match=missing):
        odm.download_reconstruction("task", tmp_path)


def test_rejects_archive_traversal(worker, monkeypatch, tmp_path):
    files = archive_files(); files["../escaped"] = "bad"
    monkeypatch.setattr(requests, "get", Mock(return_value=archive_response(files)))
    with pytest.raises(ReconstructionError, match="invalid output path"):
        odm.download_reconstruction("task", tmp_path)
    assert not (tmp_path.parent / "escaped").exists()


def test_nodeodm_http_200_errors_are_not_success(worker):
    response = Mock(); response.json.return_value = {"error": "Invalid options"}
    with pytest.raises(ReconstructionError, match="Invalid options"):
        odm.nodeodm_result(response)


def test_odm_init_is_multipart_and_requests_cameras_and_mesh(worker, monkeypatch, tmp_path):
    images = tmp_path / "images"; images.mkdir()
    for name in ("a.jpg", "b.jpg"):
        (images / name).write_bytes(b"image")
    calls = []
    def post(url, **kwargs):
        calls.append((url, kwargs))
        response = Mock()
        response.json.return_value = {"uuid": "task"} if url.endswith("/init") else {"success": True}
        return response
    monkeypatch.setattr(requests, "post", post)
    info = Mock(); info.json.return_value = {"status": {"code": 40}, "progress": 100}
    monkeypatch.setattr(requests, "get", Mock(return_value=info))
    monkeypatch.setattr(odm, "download_reconstruction", Mock(return_value=(Path("model"), Path("cameras"), Path("mesh"))))
    result = odm.reconstruct(images, tmp_path / "out", lambda: client.check_cancelled("job"), lambda *args: client.report_progress("job", *args))
    fields = calls[0][1]["files"]
    assert "data" not in calls[0][1]
    outputs = json.loads(fields["outputs"][1])
    assert "opensfm/reconstruction.json" in outputs and "odm_texturing/odm_textured_model_geo.obj" in outputs
    options = {o["name"]: o["value"] for o in json.loads(fields["options"][1])}
    assert options["gltf"] is True and options["mesh-size"] == "2000000"
    assert result.names == {"a.jpg": "image_000000.jpg", "b.jpg": "image_000001.jpg"}


@pytest.mark.parametrize("placement_method", ["triangle", "vertex", "multiview"])
@pytest.mark.parametrize("classes", [[], ["bolt", "anchor"]])
def test_detection_exports_all_cameras_and_maps_bolts_and_anchors(worker, monkeypatch, tmp_path, classes, placement_method):
    images = tmp_path / "images"; images.mkdir(); out = tmp_path / "out"; out.mkdir()
    cv2.imwrite(str(images / "photo.jpg"), np.zeros((100, 100, 3), dtype=np.uint8))
    cameras = tmp_path / "reconstruction.json"; cameras.write_text(json.dumps(scene()))
    detections = [SimpleNamespace(bbox_xyxy=[45, 45, 55, 55], confidence=.9, class_name=name) for name in classes]
    monkeypatch.setitem(sys.modules, "ultralytics", SimpleNamespace(YOLO=Mock()))
    monkeypatch.setitem(sys.modules, "felslager_processing.detection.inference", SimpleNamespace(predict_tiled=Mock(return_value=SimpleNamespace(detections=detections))))
    geometry = mesh() if placement_method != "vertex" else SimpleNamespace(vertices=np.array([[.05, 0, 5.]]), vertex_normals=np.array([[0., 0, 1.]]))
    monkeypatch.setitem(sys.modules, "trimesh", SimpleNamespace(load=Mock(return_value=geometry)))
    detection_runtime.run_detection("job", images, tmp_path / "weights", tmp_path / "mesh.obj", cameras, out, "Wall", {"photo.jpg": "image_000000.jpg"}, placement_method=placement_method)
    project = json.loads((out / "project.json").read_text())
    assert project["cameras"] == {"photo.jpg": [0, 0, 0]}
    assert project["coordinateSystem"] == "Z_UP"
    assert [h["class"] for h in project["hits"]] == classes
    for hit in project["hits"]:
        assert hit["cam_dist"] == pytest.approx(150 if placement_method != "vertex" else np.linalg.norm([.05, 0, 5]))
        assert hit["normal_dot"] == 1
        assert (out / hit["crop"]).is_file()
        assert hit["positioning"]["incidenceAngleDeg"] == 0
        assert hit["positioning"]["fallbackReason"] == ("insufficient_views" if placement_method == "multiview" else None)
    assert project["positioning"]["requestedMethod"] == placement_method
    assert project["mapping"]["unmapped"] == 0
    exported = json.loads((out / "detections.json").read_text())
    assert exported["calibration"]["photo.jpg"]["camera"]["projection_type"] == "brown"


def test_zero_mapped_detections_fails_instead_of_silently_completing(worker, monkeypatch, tmp_path):
    images = tmp_path / "images"; images.mkdir(); out = tmp_path / "out"; out.mkdir()
    cv2.imwrite(str(images / "photo.jpg"), np.zeros((100, 100, 3), dtype=np.uint8))
    cameras = tmp_path / "reconstruction.json"; cameras.write_text(json.dumps(scene()))
    monkeypatch.setitem(sys.modules, "ultralytics", SimpleNamespace(YOLO=Mock()))
    detection = SimpleNamespace(bbox_xyxy=[45, 45, 55, 55], confidence=.9, class_name="bolt")
    monkeypatch.setitem(sys.modules, "felslager_processing.detection.inference", SimpleNamespace(predict_tiled=Mock(return_value=SimpleNamespace(detections=[detection]))))
    monkeypatch.setitem(sys.modules, "trimesh", SimpleNamespace(load=Mock(return_value=mesh(-150))))
    with pytest.raises(ReconstructionError, match="none intersected"):
        detection_runtime.run_detection("job", images, tmp_path / "weights", tmp_path / "mesh.obj", cameras, out, "Wall", {"photo.jpg": "image_000000.jpg"})
    assert json.loads((out / "project.json").read_text())["cameras"]
    assert json.loads((out / "project.json").read_text())["mapping"]["unmapped"] == 1
    exported = json.loads((out / "detections.json").read_text())
    assert exported["frames"][0]["detections"][0]["mapping"] == "no_surface_hit"


def test_invalid_download_is_actionable(worker, monkeypatch, tmp_path):
    response = archive_response({})
    response.iter_content.return_value = [b'{"error":"Asset not ready"}']
    monkeypatch.setattr(requests, "get", Mock(return_value=response))
    with pytest.raises(ReconstructionError, match="valid output ZIP"):
        odm.download_reconstruction("task", tmp_path)


def job(tmp_path, phase="reconstruction", engine="odm"):
    images = tmp_path / "images"
    images.mkdir(exist_ok=True)
    for name in ["photo.jpg", "second.jpg"]:
        (images / name).write_bytes(b"photo")
    return {"id": "job", "engine": engine, "phase": phase, "flowRunId": "run-1",
            "runBoltDetection": True,
            "inputPath": str(tmp_path / "images"), "workPath": str(tmp_path / "work"),
            "outputAbsolutePath": str(tmp_path / "output"), "name": "Wall"}


def write_artifact(tmp_path):
    work = tmp_path / "work"; work.mkdir(exist_ok=True)
    (work / "model.glb").write_bytes(b"glb")
    (work / "cameras.json").write_text(json.dumps(scene()))
    artifact = {"version": 1, "engine": "odm", "model": "model.glb", "detectionMesh": "model.glb",
                "reconstruction": "cameras.json", "names": {"photo.jpg": "image_000000.jpg"},
                "coordinateSystem": "Z_UP"}
    (work / "artifact.json").write_text(json.dumps(artifact))
    return work


def test_reconstruction_only_finishes_without_loading_detector(worker, monkeypatch, tmp_path):
    work = write_artifact(tmp_path)
    monkeypatch.setattr(odm, 'reconstruct', Mock(return_value=artifacts.ReconstructionOutput(work / 'model.glb', work / 'cameras.json',
        {'photo.jpg': 'image_000000.jpg'}, work / 'model.glb', 'Z_UP')))
    detector = Mock(side_effect=AssertionError('Detector must not be loaded'))
    monkeypatch.setattr(detection_runtime, 'get_detection_model', detector)
    api = Mock(); monkeypatch.setattr(client, 'request', api)
    value = {**job(tmp_path), 'runBoltDetection': False}
    worker.reconstruct_job(value)
    assert api.call_args.args == ('POST', '/worker/job/complete')
    assert (tmp_path / 'output/model.glb').read_bytes() == b'glb'
    project = json.loads((tmp_path / 'output/project.json').read_text())
    assert project['hits'] == []
    assert project['cameras'] == {'photo.jpg': [0, 0, 0]}
    detector.assert_not_called()


def test_video_preparation_reads_current_files_and_preserves_srt(worker, monkeypatch, tmp_path):
    import shutil
    import subprocess
    if not shutil.which('ffmpeg'):
        pytest.skip('ffmpeg is required for video preparation')
    source, work = tmp_path / 'images', tmp_path / 'work'
    source.mkdir(); work.mkdir()
    video = source / 'flight.mp4'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=2:d=3',
                    '-c:v', 'mpeg4', str(video)], check=True)
    subtitle = '1\n00:00:00,000 --> 00:00:01,000\nGPS telemetry\n'
    (source / 'flight.srt').write_text(subtitle)
    (source / 'later.jpg').write_bytes(b'photo')
    (source / 'notes.txt').write_text('Ancillary capture notes')
    value = job(tmp_path)
    prepared = capture.prepare_capture(value, source, work)
    assert len(list(prepared.rglob('*.jpg'))) == 6
    assert (prepared / 'photos/later.jpg').is_file()
    assert len(list((prepared / 'videos').rglob('*.jpg'))) == 3
    assert (work / 'telemetry/flight.srt').read_text() == subtitle
    assert video.is_file()
    (work / 'model.glb').write_bytes(b'model')
    (work / 'cameras.json').write_text(json.dumps(scene()))
    monkeypatch.setattr(client, 'request', Mock())
    results.finish_result(value, {'model': 'model.glb', 'reconstruction': 'cameras.json',
        'names': {'photos/photo.jpg': 'image_000000.jpg'}, 'coordinateSystem': 'Z_UP'}, prepared)
    assert (tmp_path / 'output/telemetry/flight.srt').read_text() == subtitle
    assert not (work / 'capture.json').exists()
    assert not (tmp_path / 'output/capture.json').exists()


def test_preparation_cancellation_stops_before_engine_launch(worker, monkeypatch, tmp_path):
    source, work = tmp_path / 'images', tmp_path / 'work'
    source.mkdir(); work.mkdir()
    (source / 'video.mp4').write_bytes(b'video')
    monkeypatch.setattr(capture, 'run_batch', Mock(side_effect=worker.JobCancelled()))
    reconstruct = Mock(); monkeypatch.setattr(odm, 'reconstruct', reconstruct)
    api = Mock(); monkeypatch.setattr(client, 'request', api)
    with pytest.raises(worker.JobCancelled):
        worker.reconstruct_job(job(tmp_path))
    reconstruct.assert_not_called()
    api.assert_not_called()


def test_detection_uses_prepared_video_frames(worker, monkeypatch, tmp_path):
    work = write_artifact(tmp_path)
    (work / 'prepared').mkdir()
    def detect(*args, **kwargs):
        (args[5] / 'project.json').write_text('{"hits": []}')
    detection = Mock(side_effect=detect)
    monkeypatch.setattr(detection_runtime, 'run_detection', detection)
    monkeypatch.setattr(client, 'request', Mock())
    worker.detect_job(job(tmp_path, 'detection'))
    assert detection.call_args.args[1] == work / 'prepared'
    assert detection.call_args.kwargs['placement_method'] == 'triangle'


def test_detection_mapping_failure_does_not_publish_or_complete(worker, monkeypatch, tmp_path):
    write_artifact(tmp_path)
    monkeypatch.setattr(detection_runtime, "run_detection", Mock(side_effect=ReconstructionError("Detections were found, but none intersected the model.")))
    api = Mock(); monkeypatch.setattr(client, "request", api)
    with pytest.raises(ReconstructionError, match="none intersected"):
        worker.detect_job(job(tmp_path, "detection"))
    api.assert_not_called()
    assert not (tmp_path / "output").exists()
    assert (tmp_path / "work/model.glb").is_file()


@pytest.mark.parametrize("engine,coordinate_system", [("meshroom", "Y_UP"), ("realityscan", "Z_UP"), ("odm", "Z_UP")])
@pytest.mark.parametrize("placement_method", ["vertex", "multiview"])
def test_reconstruction_writes_private_handoff_without_detection(worker, monkeypatch, tmp_path, engine, coordinate_system, placement_method):
    import importlib
    work = write_artifact(tmp_path)
    reconstruct = Mock(return_value=artifacts.ReconstructionOutput(work / "model.glb", work / "cameras.json", {"photo.jpg": "image_000000.jpg"}, work / "model.glb", coordinate_system))
    if engine == "odm":
        monkeypatch.setattr(odm, "reconstruct", reconstruct)
    else:
        monkeypatch.setattr(importlib.import_module(f"felslager_processing.engines.{engine}"), "reconstruct", reconstruct)
    detection = Mock(); monkeypatch.setattr(detection_runtime, "run_detection", detection)
    api = Mock(); monkeypatch.setattr(client, "request", api)
    worker.reconstruct_job(job(tmp_path, engine=engine))
    reconstruct.assert_called_once()
    detection.assert_not_called()
    artifact = json.loads((work / "artifact.json").read_text())
    assert artifact["coordinateSystem"] == coordinate_system
    assert artifact["model"] == "reconstruction/model.glb" and artifact["reconstruction"] == "reconstruction/cameras.json"
    assert artifact["images"] == "reconstruction/prepared-images"
    assert isinstance(json.loads((work / artifact["reconstruction"]).read_text()), dict)
    assert (work / artifact["images"]).is_dir()
    assert artifact["engine"] == engine and artifact["version"] == 1
    assert not (tmp_path / "output").exists()
    api.assert_not_called()
    # The same detection consumer reads all three adapters' standardized output.
    def detect(*args, **kwargs):
        (args[5] / "project.json").write_text('{"hits": []}')
    detection.side_effect = detect
    worker.detect_job({**job(tmp_path, "detection", engine), "boltPlacementMethod": placement_method})
    assert detection.call_args.args[1] == work / artifact["images"]
    assert detection.call_args.args[4] == work / "reconstruction/cameras.json"
    assert detection.call_args.kwargs["coordinate_system"] == coordinate_system
    assert detection.call_args.kwargs["placement_method"] == placement_method
    assert api.call_args.args == ("POST", "/worker/job/complete")


def test_detection_consumes_handoff_and_completes_private_output(worker, monkeypatch, tmp_path):
    work = write_artifact(tmp_path)
    def detect(*args, **kwargs):
        (args[5] / "project.json").write_text('{"hits": []}')
    detection = Mock(side_effect=detect); monkeypatch.setattr(detection_runtime, "run_detection", detection)
    api = Mock(); monkeypatch.setattr(client, "request", api)
    worker.detect_job(job(tmp_path, "detection"))
    assert detection.call_args.args[3] == work / "model.glb"
    assert (tmp_path / "output/model.glb").read_bytes() == b"glb"
    assert (tmp_path / "output/project.json").is_file()
    assert api.call_args.args == ("POST", "/worker/job/complete")
    assert (work / "artifact.json").is_file()


def test_detector_model_is_loaded_once(worker, monkeypatch, tmp_path):
    factory = Mock()
    monkeypatch.setitem(sys.modules, "ultralytics", SimpleNamespace(YOLO=factory))
    first = detection_runtime.get_detection_model(tmp_path / "weights")
    assert detection_runtime.get_detection_model(tmp_path / "weights") is first
    factory.assert_called_once()


@pytest.mark.parametrize("relative", ["../outside.glb", "/etc/passwd", "missing.glb"])
def test_artifact_rejects_unsafe_or_missing_paths(worker, tmp_path, relative):
    with pytest.raises(ReconstructionError):
        artifacts.artifact_path(tmp_path, relative)


@pytest.mark.parametrize("argv", [[], ["--role", "reconstruction"], ["--role", "detection", "--engine", "odm"]])
def test_cli_requires_independent_explicit_role(worker, argv):
    with pytest.raises(SystemExit):
        cli.arguments(argv)


def test_cli_accepts_independent_roles(worker):
    assert cli.arguments(["--role", "detection"]).engine is None
    assert cli.arguments(["--role", "reconstruction", "--engine", "meshroom"]).engine == "meshroom"


def test_runtime_import_does_not_load_ml_or_engine_adapters(monkeypatch):
    """Reconstruction images can start without torch; detection needs no engine installation."""
    import subprocess
    script = '\n'.join([
        'import importlib.abc, sys',
        'class BlockHeavyImports(importlib.abc.MetaPathFinder):',
        '    def find_spec(self, fullname, *args):',
        "        if fullname.split('.')[0] in {'torch', 'ultralytics'} or fullname in {'felslager_processing.engines.odm', 'felslager_processing.engines.meshroom', 'felslager_processing.engines.realityscan', 'felslager_processing.detection.runner'}:",
        "            raise AssertionError('Unexpected eager import: ' + fullname)",
        'sys.meta_path.insert(0, BlockHeavyImports())',
        'import felslager_processing.__main__',
    ])
    subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).resolve().parents[1], check=True)


def test_cancellation_cancels_nodeodm_task(worker, monkeypatch, tmp_path):
    images = tmp_path / "images"; images.mkdir()
    for name in ("a.jpg", "b.jpg"):
        (images / name).write_bytes(b"image")
    monkeypatch.setattr(client, "check_cancelled", Mock(side_effect=[None, worker.JobCancelled()]))
    response = Mock(); response.json.return_value = {"uuid": "odm-task"}
    monkeypatch.setattr(requests, "post", Mock(return_value=response))
    cancel = Mock(); monkeypatch.setattr(odm, "cancel_task", cancel)
    with pytest.raises(worker.JobCancelled):
        odm.reconstruct(images, tmp_path / "work", lambda: client.check_cancelled("job"), lambda *args: client.report_progress("job", *args))
    cancel.assert_called_once_with("odm-task")


@pytest.mark.parametrize('method', ['triangle', 'vertex', 'multiview'])
def test_cached_detections_reposition_without_loading_detector(worker, monkeypatch, tmp_path, method):
    images = tmp_path / 'images'; images.mkdir()
    out = tmp_path / 'out'; out.mkdir()
    cv2.imwrite(str(images / 'photo.jpg'), np.zeros((100, 100, 3), dtype=np.uint8))
    cameras = tmp_path / 'reconstruction.json'; cameras.write_text(json.dumps(scene()))
    cached = tmp_path / 'detections.json'
    cached.write_text(json.dumps({'frames': [{'image': 'photo.jpg', 'detections': [
        {'bbox_xyxy': [45, 45, 55, 55], 'confidence': .9, 'class_name': 'bolt'}]}]}))
    monkeypatch.setattr(detection_runtime, 'get_detection_model', Mock(side_effect=AssertionError('Must not load YOLO')))
    geometry = SimpleNamespace(vertices=np.array([[0., 0, 5], [1., 0, 5], [0., 1, 5]]), faces=np.array([[0, 1, 2]]), vertex_normals=np.array([[0., 0, -1]] * 3))
    monkeypatch.setitem(sys.modules, 'trimesh', SimpleNamespace(load=Mock(return_value=geometry)))
    detection_runtime.run_detection('job', images, tmp_path / 'weights', tmp_path / 'mesh.obj', cameras,
        out, 'Wall', {'photo.jpg': 'image_000000.jpg'}, placement_method=method, cached_detections=cached)
    project = json.loads((out / 'project.json').read_text())
    assert project['positioning']['requestedMethod'] == method
    assert project['hits']
    assert (out / project['hits'][0]['crop']).is_file()
    assert json.loads((out / 'detections.json').read_text())['frames'][0]['detections'][0]['confidence'] == .9
    detection_runtime.get_detection_model.assert_not_called()


def test_placement_job_reads_source_and_packages_into_own_output(worker, monkeypatch, tmp_path):
    source = write_artifact(tmp_path)
    (source / 'prepared').mkdir()
    (source / 'telemetry').mkdir()
    (source / 'telemetry/flight.srt').write_text('original telemetry')
    own = tmp_path / 'child'; own.mkdir()
    cached = tmp_path / 'detections.json'; cached.write_text('{"frames": []}')
    def detect(*args, **kwargs):
        assert args[1] == source / 'prepared'
        assert kwargs['cached_detections'] == cached
        (args[5] / 'project.json').write_text('{"hits": []}')
    detector = Mock(side_effect=detect)
    monkeypatch.setattr(detection_runtime, 'run_detection', detector)
    monkeypatch.setattr(client, 'request', Mock())
    value = {**job(tmp_path), 'sourceProcessingId': 'source', 'sourceWorkPath': str(source),
             'workPath': str(own), 'detectionsPath': str(cached), 'boltPlacementMethod': 'multiview'}
    worker.detect_job(value)
    assert (tmp_path / 'output/model.glb').read_bytes() == b'glb'
    assert (tmp_path / 'output/telemetry/flight.srt').read_text() == 'original telemetry'
    assert (source / 'artifact.json').is_file()


def test_cached_placement_rejects_missing_original_images(worker, monkeypatch, tmp_path):
    images = tmp_path / 'images'; images.mkdir()
    out = tmp_path / 'out'; out.mkdir()
    cached = tmp_path / 'detections.json'
    cached.write_text('{"frames": [{"image": "missing.jpg", "detections": []}]}')
    cameras = tmp_path / 'cameras.json'; cameras.write_text(json.dumps(scene()))
    monkeypatch.setitem(sys.modules, 'trimesh', SimpleNamespace(load=Mock(return_value=mesh(5))))
    monkeypatch.setattr(detection_runtime, 'get_detection_model', Mock(side_effect=AssertionError('Must not load YOLO')))
    with pytest.raises(ReconstructionError, match='Original detection images are missing'):
        detection_runtime.run_detection('job', images, tmp_path / 'weights', tmp_path / 'mesh.obj', cameras,
            out, 'Wall', {}, cached_detections=cached)
    detection_runtime.get_detection_model.assert_not_called()
