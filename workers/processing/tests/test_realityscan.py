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
    def run(command, log, cancel, poll=None):
        assert command[:4] == ['/bin/true', '-silent', wine_path(out / 'crash-reports'), '-headless']
        assert (out / 'crash-reports').is_dir()
        image = out / 'images/image_000000.jpg'
        assert image.is_symlink()
        image.with_suffix('.jpg.cache').write_text('sidecar')
        assert not list(images.glob('*.cache'))
        assert command[4:6] == ['-set', 'appQuitOnError=true']
        assert '-align' in command and '-calculateTexture' in command
        assert wine_path(out / 'model.obj') in command
        index = command.index('-writeProgress')
        assert command[index + 1:index + 3] == [wine_path(out / 'realityscan-progress.txt'), '2']
        (out / 'realityscan-progress.txt').write_text('20561 0.5 10 10 #progress\n')
        poll()
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


def test_native_progress_handles_partial_invalid_and_nested_records(tmp_path):
    from felslager_processing.engines.realityscan import RealityScanProgress
    path = tmp_path / 'progress.txt'
    callback = Mock()
    monitor = RealityScanProgress(path, callback)
    monitor()
    callback.assert_not_called()
    path.write_bytes(b'65537 1 20 0 #completed\n20561 0.5 30 30 #progress\n8208 0.2')
    monitor()
    assert callback.call_args.args[1] == 42
    assert callback.call_args.args[4]['operation'] == 'Reconstructing mesh'
    with path.open('ab') as stream:
        stream.write(b' 5 20 #progress\ninvalid\n7 nan 1 2 #progress\n')
    monitor()
    assert callback.call_args.args[1] == 42
    assert callback.call_args.args[4]['operationProgress'] == 20
    assert callback.call_args.args[4]['operation'] == 'Calculating depth maps'
    count = callback.call_count
    monitor()
    assert callback.call_count == count
    path.write_text('7 0.5 4 4 #progress\n')
    monitor()
    assert callback.call_args.args[1] == 65
    assert callback.call_args.args[4]['operationRemainingSeconds'] == 4


def test_subprocess_delivers_final_native_progress(tmp_path):
    import sys
    from felslager_processing.engines.common import run_batch
    from felslager_processing.engines.realityscan import RealityScanProgress
    path = tmp_path / 'progress.txt'
    callback = Mock()
    monitor = RealityScanProgress(path, callback)
    script = 'from pathlib import Path; import sys; Path(sys.argv[1]).write_text("7 0.75 12 4 #progress\\n")'
    run_batch([sys.executable, '-c', script, str(path)], tmp_path / 'cli.log', Mock(), poll=monitor)
    assert callback.call_args.args[4]['operation'] == 'Texturing'
    assert callback.call_args.args[4]['operationProgress'] == 75
