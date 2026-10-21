"""Verify the engine-independent reconstruction handoff."""
import json
from pathlib import Path

import pytest

from felslager_processing.artifacts import ReconstructionOutput, publish_artifacts
from felslager_processing.reconstruction import ReconstructionError


def output(tmp_path):
    work = tmp_path / 'work'; work.mkdir()
    scratch = work / 'engine'; scratch.mkdir()
    model = scratch / 'textured.glb'; model.write_bytes(b'model')
    cameras = scratch / 'native.json'
    cameras.write_text(json.dumps([{
        'cameras': {'c': {'projection_type': 'perspective', 'width': 100, 'height': 100, 'focal': .5}},
        'shots': {'image.jpg': {'camera': 'c', 'rotation': [0, 0, 0], 'translation': [0, 0, 0]}}
    }]))
    images = work / 'prepared'; images.mkdir(); (images / 'photo.jpg').write_bytes(b'photo')
    return work, images, ReconstructionOutput(model, cameras, {'photo.jpg': 'image.jpg'}, model, 'Z_UP')


def test_bundle_has_fixed_paths_normalized_cameras_and_original_image_bytes(tmp_path):
    work, images, result = output(tmp_path)
    artifact = publish_artifacts(work, result, images, 'odm')
    assert json.loads((work / 'artifact.json').read_text()) == artifact
    assert artifact['model'] == artifact['detectionMesh'] == 'reconstruction/model.glb'
    assert (work / artifact['model']).read_bytes() == b'model'
    assert isinstance(json.loads((work / artifact['reconstruction']).read_text()), dict)
    assert (work / artifact['images'] / 'photo.jpg').read_bytes() == b'photo'
    assert not images.exists()


def test_matching_obj_is_preserved_separately_from_textured_glb(tmp_path):
    work, images, result = output(tmp_path)
    mesh = work / 'engine/mesh.obj'; mesh.write_text('v 0 0 0')
    result = ReconstructionOutput(result.model, result.cameras, result.names, mesh, result.coordinate_system)
    artifact = publish_artifacts(work, result, images, 'odm')
    assert artifact['detectionMesh'] == 'reconstruction/detection-mesh.obj'
    assert (work / artifact['detectionMesh']).read_bytes() == mesh.read_bytes()


def test_invalid_calibration_does_not_commit_handoff(tmp_path):
    work, images, result = output(tmp_path)
    result.cameras.write_text('{"cameras":{},"shots":{}}')
    with pytest.raises(ReconstructionError, match='no calibrated cameras'):
        publish_artifacts(work, result, images, 'odm')
    assert not (work / 'artifact.json').exists()


def test_engine_outputs_cannot_escape_private_work_directory(tmp_path):
    work, images, result = output(tmp_path)
    outside = tmp_path / 'outside.glb'; outside.write_bytes(b'outside')
    result = ReconstructionOutput(outside, result.cameras, result.names, result.detection_mesh, 'Z_UP')
    with pytest.raises(ReconstructionError, match='outside'):
        publish_artifacts(work, result, images, 'odm')
    assert not (work / 'artifact.json').exists()
