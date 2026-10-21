import json
from pathlib import Path
from unittest.mock import Mock

import numpy as np
import pytest

from felslager_processing.engines.realityscan import convert_cameras, reconstruct, wine_path
from felslager_processing.reconstruction import ReconstructionError, camera_records, camera_ray


def scene(folder, camera='PINHOLE 100 80 50 60 55 38', pose='1 0 0 0 -1 -2 -3'):
    (folder / 'cameras.txt').write_text(f'# Camera calibration\n1 {camera}\n')
    (folder / 'images.txt').write_text(f'# Images\n1 {pose} 1 image_000000.jpg\n\n')


def test_camera_center_and_off_center_pixel_ray(tmp_path):
    scene(tmp_path)
    cameras = camera_records(convert_cameras(tmp_path, {'nested/photo.jpg': 'image_000000.jpg'}))
    camera = cameras['image_000000.jpg']
    np.testing.assert_allclose(camera['center'], [1, 2, 3])
    np.testing.assert_allclose(camera_ray(camera, (55, 38), (80, 100)), [0, 0, 1])
    ray = np.array([1., 1., 1.]); ray /= np.linalg.norm(ray)
    np.testing.assert_allclose(camera_ray(camera, (105, 98), (80, 100)), ray)


@pytest.mark.parametrize('camera', ['FISHEYE 100 80 50 50 50 40',
    'FULL_OPENCV 100 80 50 50 50 40 0 0 0 0 0 1 0 0',
    'PINHOLE 100 80 nan 50 50 40'])
def test_rejects_unsupported_or_invalid_calibration(tmp_path, camera):
    scene(tmp_path, camera)
    with pytest.raises(ReconstructionError):
        convert_cameras(tmp_path, {'photo.jpg': 'image_000000.jpg'})


def test_skips_observation_lines_and_rejects_renamed_images(tmp_path):
    scene(tmp_path)
    with pytest.raises(ReconstructionError, match='original image names'):
        convert_cameras(tmp_path, {'photo.jpg': 'different.jpg'})


def test_missing_configuration_is_actionable(tmp_path, monkeypatch):
    monkeypatch.setenv('REALITYSCAN_CLI', '/missing/realityscan-cli')
    with pytest.raises(ReconstructionError, match='REALITYSCAN_CLI'):
        reconstruct(tmp_path, tmp_path / 'out', Mock(), Mock())


def test_adapter_runs_cli_and_converts_outputs(tmp_path, monkeypatch):
    import felslager_processing.engines.realityscan as module
    import trimesh
    images = tmp_path / 'inputs'; images.mkdir()
    (images / 'one.jpg').write_bytes(b'original1')
    (images / 'two.jpg').write_bytes(b'original2')
    preset = tmp_path / 'preset.xml'; preset.write_text('<settings/>')
    monkeypatch.setenv('REALITYSCAN_CLI', '/bin/true')
    monkeypatch.setenv('REALITYSCAN_MODEL_PARAMS', str(preset))
    monkeypatch.setenv('REALITYSCAN_REGISTRATION_PARAMS', str(preset))
    out = tmp_path / 'output'
    def run(command, log, cancel):
        assert command[:4] == ['/bin/true', '-silent', wine_path(out / 'crash-reports'), '-headless']
        assert (out / 'crash-reports').is_dir()
        assert command[4:6] == ['-set', 'appQuitOnError=true']
        assert '-align' in command and '-calculateTexture' in command
        assert wine_path(out / 'model.obj') in command
        scene(out / 'registration')
        (out / 'model.obj').write_text(trimesh.creation.box().export(file_type='obj'))
    monkeypatch.setattr(module, 'run_batch', run)
    output = reconstruct(images, out, Mock(), Mock())
    glb, calibration, names, detection_mesh = output.model, output.cameras, output.names, output.detection_mesh
    assert output.coordinate_system == 'Z_UP'
    assert glb.read_bytes()[:4] == b'glTF'
    assert glb == detection_mesh
    assert len(names) == 2
    assert json.loads(calibration.read_text())['shots']
    assert (images / 'one.jpg').read_bytes() == b'original1'
