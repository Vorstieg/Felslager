"""Camera reprojection, textured GLB alignment, process failure and cancellation."""
import copy
import json
import os
import signal
import sys
import time
from pathlib import Path
from unittest.mock import Mock

import cv2
import numpy as np
import pytest

from felslager_processing.engines.meshroom import OBJ_BASIS, convert_cameras, make_pipeline, reconstruct, run_batch
from felslager_processing.reconstruction import ReconstructionError, camera_records, camera_ray, MeshProjector


def scene(distortion='brown'):
    rotation = cv2.Rodrigues(np.array([.2, -.3, .4]))[0]
    return {'version': ['1', '2', '10'],
            'intrinsics': [{'intrinsicId': '1', 'type': 'pinhole', 'width': '800', 'height': '1000',
                            'sensorWidth': '20', 'focalLength': '15', 'pixelRatio': '1.2',
                            'principalPoint': ['12', '-8'], 'distortionType': distortion,
                            'distortionParams': {'brown': ['.08', '-.02', '.001', '.002', '-.003'],
                                                 'radialk3': ['.08', '-.02', '.001'], 'none': []}[distortion]}],
            'views': [{'path': '/private/images/image_000000.jpg', 'poseId': '7', 'intrinsicId': '1'},
                      {'path': '/private/unregistered.jpg', 'poseId': '8', 'intrinsicId': '1'}],
            'poses': [{'poseId': '7', 'pose': {'transform': {
                'rotation': rotation.ravel(order='F').tolist(), 'center': [3, 4, 5]}}}]}


@pytest.mark.parametrize('distortion', ['none', 'radialk3', 'brown'])
@pytest.mark.parametrize('revision', [10, 11, 12])
def test_camera_reprojection_matches_exported_mesh(distortion, revision):
    data = scene(distortion)
    data['version'][-1] = str(revision)
    normalized = convert_cameras(data)
    cam = camera_records(normalized)['image_000000.jpg']
    R = np.asarray(data['poses'][0]['pose']['transform']['rotation']).reshape(3, 3, order='F')
    center = np.array([3., 4., 5.])
    local = np.array([1.3, -.7, 8.])
    world = center + R.T @ local
    exported = OBJ_BASIS @ world
    fx, fy = {10: (600., 720.), 11: (500., 600.), 12: (625., 750.)}[revision]
    K = np.array([[fx, 0, 412.], [0, fy, 492.], [0, 0, 1.]])
    params = [float(v) for v in data['intrinsics'][0]['distortionParams']]
    distortion_cv = np.zeros(5)
    if params:
        distortion_cv[[0, 1, 4]] = params[:3]
    if distortion == 'brown':
        distortion_cv[2:4] = params[3:5]
    uv = cv2.projectPoints(local.reshape(1, 3), np.zeros(3), np.zeros(3), K, distortion_cv)[0][0, 0]
    direction = camera_ray(cam, tuple(uv), (1000, 800, 3))
    expected = exported - cam['center']
    expected /= np.linalg.norm(expected)
    np.testing.assert_allclose(cam['center'], OBJ_BASIS @ center, atol=1e-8)
    np.testing.assert_allclose(direction, expected, atol=1e-7)
    # A triangle in the exported OBJ basis must intersect at the projected point.
    points = [OBJ_BASIS @ (center + R.T @ (local + offset))
              for offset in [np.array([-2, -2, 0]), np.array([2, -2, 0]), np.array([0, 2, 0])]]
    hit = MeshProjector(np.array(points), np.array([[0, 1, 2]])).intersect(cam['center'], direction)
    np.testing.assert_allclose(hit[0], exported, atol=1e-6)


@pytest.mark.parametrize('change', [
    lambda s: s.update(poses=[]),
    lambda s: s.update(version=['99', '0', '0']),
    lambda s: s['intrinsics'][0].update(type='equidistant'),
    lambda s: s['intrinsics'][0].update(distortionType='fisheye4'),
    lambda s: s['intrinsics'][0].update(undistortionType='3deanamorphic4'),
    lambda s: s['intrinsics'][0].update(distortionParams=['nan'] * 5),
    lambda s: s['intrinsics'][0].update(focalLength='0'),
    lambda s: s['views'][0].update(isPoseIndependant='false'),
    lambda s: s['poses'][0]['pose']['transform'].update(rotation=[0] * 9),
    lambda s: s['views'].append(copy.deepcopy(s['views'][0])),
])
def test_invalid_cameras_fail_explicitly(change):
    data = scene()
    change(data)
    with pytest.raises(ReconstructionError):
        convert_cameras(data)


def test_batch_failure_includes_diagnostics(tmp_path):
    with pytest.raises(ReconstructionError, match='CUDA unavailable'):
        run_batch([sys.executable, '-c', 'print("CUDA unavailable"); raise SystemExit(2)'],
                  tmp_path / 'batch.log', lambda: None)


def test_cancellation_terminates_process_group(tmp_path):
    pid_file = tmp_path / 'child.pid'
    class Cancelled(Exception):
        pass
    def cancel():
        if pid_file.exists():
            raise Cancelled()
    command = [sys.executable, '-c',
               'import subprocess,time,pathlib; p=subprocess.Popen(["sleep","60"]); '
               f'pathlib.Path({str(pid_file)!r}).write_text(str(p.pid)); time.sleep(60)']
    start = time.monotonic()
    with pytest.raises(Cancelled):
        run_batch(command, tmp_path / 'batch.log', cancel)
    assert time.monotonic() - start < 15
    pid = int(pid_file.read_text())
    status = Path(f'/proc/{pid}/status')
    if status.exists():
        assert 'State:\tZ' in status.read_text()  # Exited child awaiting init reaping.


def test_pipeline_uses_same_scene_as_textured_mesh(tmp_path):
    installation = Path('/media/benjamin/Data3/Meshroom-2025.1.0')
    if not installation.is_dir():
        pytest.skip('Local Meshroom installation is not present')
    target = tmp_path / 'pipeline.mg'
    make_pipeline(installation, target)
    graph = json.loads(target.read_text())['graph']
    assert graph['ConvertSfMFormat_1']['inputs']['input'] == graph['Texturing_1']['inputs']['input']
    assert '{ConvertSfMFormat_1.output}' in graph['Publish_1']['inputs']['inputFiles']
    assert graph['Texturing_1']['inputs']['colorMapping']['colorMappingFileType'] == 'png'


def test_reconstruct_preserves_textures_geometry_and_nested_image_names(tmp_path, monkeypatch):
    import trimesh
    from PIL import Image
    import felslager_processing.engines.meshroom as module
    installation = tmp_path / 'installation'
    executable = installation / 'meshroom_batch'
    installation.mkdir(); executable.write_text(''); executable.chmod(0o700)
    images = tmp_path / 'input'
    for directory in ['a', 'b']:
        folder = images / directory; folder.mkdir(parents=True)
        (folder / 'same.jpg').write_bytes(b'original EXIF image')
    monkeypatch.setattr(module, 'make_pipeline', Mock())
    def batch(command, log, cancel):
        published = Path(command[command.index('--output') + 1]); published.mkdir()
        obj = ('mtllib texturedMesh.mtl\nv -2 -2 -5\nv 2 -2 -5\nv 0 2 -5\n'
               'vt 0 0\nvt 1 0\nvt .5 1\nusemtl wall\nf 1/1 2/2 3/3\n')
        (published / 'texturedMesh.obj').write_text(obj)
        (published / 'texturedMesh.mtl').write_text('newmtl wall\nmap_Kd texture.png\n')
        Image.new('RGB', (8, 8), color=(130, 20, 40)).save(published / 'texture.png')
        (published / 'sfm.sfm').write_text(json.dumps(scene()))
    monkeypatch.setattr(module, 'run_batch', batch)
    output = reconstruct(images, tmp_path / 'work', lambda: None, Mock(), installation=installation)
    glb, cameras, names, detection_mesh = output.model, output.cameras, output.names, output.detection_mesh
    assert output.coordinate_system == 'Y_UP'
    assert names == {'a/same.jpg': 'image_000000.jpg', 'b/same.jpg': 'image_000001.jpg'}
    assert detection_mesh == glb
    assert (tmp_path / 'work/images/image_000000.jpg').read_bytes() == b'original EXIF image'
    model = trimesh.load(glb, force='scene', process=False)
    np.testing.assert_allclose(model.bounds, [[-2, -2, -5], [2, 2, -5]])
    material = next(iter(model.geometry.values())).visual.material
    assert material.baseColorTexture is not None
    assert camera_records(json.loads(cameras.read_text()))


def test_missing_installation_is_actionable(tmp_path):
    with pytest.raises(ReconstructionError, match='MESHROOM_HOME'):
        reconstruct(tmp_path, tmp_path / 'out', lambda: None, Mock(), installation=tmp_path / 'missing')


def test_exported_photo_materials_are_unlit_and_untinted(tmp_path):
    import trimesh
    import struct
    from PIL import Image
    from felslager_processing.engines.meshroom import photogrammetry_materials
    mesh = trimesh.creation.box()
    mesh.visual = trimesh.visual.TextureVisuals(
        uv=np.zeros((len(mesh.vertices), 2)), image=Image.new("RGB", (2, 2), (120, 160, 200)))
    data = trimesh.Scene(mesh).export(file_type="glb", tree_postprocessor=photogrammetry_materials)
    length = struct.unpack_from("<I", data, 12)[0]
    tree = json.loads(data[20:20+length])
    assert "KHR_materials_unlit" in tree["extensionsUsed"]
    for material in tree["materials"]:
        assert material["extensions"]["KHR_materials_unlit"] == {}
        pbr = material["pbrMetallicRoughness"]
        assert pbr["baseColorFactor"] == [1, 1, 1, 1]
        assert pbr["metallicFactor"] == 0
        assert "baseColorTexture" in pbr
    np.testing.assert_allclose(trimesh.load(__import__("io").BytesIO(data), file_type="glb").bounds, mesh.bounds)
