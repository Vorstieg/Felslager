"""Independent analytic checks; round trips alone can hide shared errors."""
import numpy as np
import pytest

from felslager_processing.reconstruction import (
    MeshProjector, ReconstructionError, camera_records, camera_ray, project_pixels,
)


def calibrated(**parameters):
    camera = dict(projection_type="brown", width=1000, height=800,
                  focal_x=.5, focal_y=.6, c_x=.02, c_y=-.01)
    camera.update(parameters)
    return camera_records(dict(cameras={"c": camera}, shots={
        "photo": dict(camera="c", rotation=[0, 0, 0], translation=[0, 0, 0])}))["photo"]


def test_analytic_brown_projection_and_world_pose():
    cam = calibrated(k1=.1, k2=-.02, k3=.003, p1=.004, p2=-.005)
    cam["R"] = np.array([[0., -1, 0], [1., 0, 0], [0., 0, 1]])
    cam["center"] = np.array([3., -2, 1])
    x, y, z = .3, -.2, 5.
    world = cam["center"] + cam["R"].T @ np.array([x*z, y*z, z])
    radius2 = x*x + y*y
    radial = 1 + .1*radius2 - .02*radius2**2 + .003*radius2**3
    xd = x*radial + 2*.004*x*y - .005*(radius2 + 2*x*x)
    yd = y*radial + .004*(radius2 + 2*y*y) - 2*.005*x*y
    expected = np.array([500*xd + 520, 600*yd + 390])
    np.testing.assert_allclose(project_pixels(cam, [world])[0], expected, atol=1e-9)
    direction = world - cam["center"]
    direction /= np.linalg.norm(direction)
    # Edge-based coordinates resize directly, even with unequal X/Y factors.
    np.testing.assert_allclose(camera_ray(cam, expected * [.5, .25], (200, 500)),
                               direction, atol=1e-10)


def test_opensfm_pixel_center_conversion():
    cam = calibrated(c_x=0, c_y=0)
    # OpenSfM's pixel-center optical axis is (499.5, 399.5). Detection
    # boxes use image-edge coordinates, i.e. add .5 before projecting rays.
    center_pixel = np.array([499.5, 399.5])
    np.testing.assert_allclose(camera_ray(cam, center_pixel + .5, (800, 1000)), [0, 0, 1])
    np.testing.assert_allclose(project_pixels(cam, [[0, 0, 5]])[0] - .5, center_pixel)


def test_strong_distortion_inversion_at_image_edge():
    cam = calibrated(focal_x=.5, focal_y=.5, c_x=0, c_y=0, k1=.3, k2=.05)
    # x=.7, y=.5 => r^2=.74; explicit Brown polynomial, independent
    # of the production projection function and OpenCV's forward projection.
    radial = 1 + .3*.74 + .05*.74**2
    pixel = np.array([500*.7*radial + 500, 500*.5*radial + 400])
    expected = np.array([.7, .5, 1.])
    expected /= np.linalg.norm(expected)
    np.testing.assert_allclose(camera_ray(cam, pixel, (800, 1000)), expected, atol=1e-10)


def test_nonconvergent_distortion_does_not_silently_return_a_wrong_ray():
    cam = calibrated(focal_x=.5, focal_y=.5, c_x=0, c_y=0, k1=-1)
    with pytest.raises(ReconstructionError, match="inversion did not converge"):
        camera_ray(cam, (1000, 400), (800, 1000))


@pytest.mark.parametrize("parameter", ["c_x", "c_y", "k1", "k2", "k3", "p1", "p2"])
def test_nonfinite_calibration_is_rejected(parameter):
    with pytest.raises(ReconstructionError, match="Invalid camera calibration"):
        calibrated(**{parameter: float("nan")})


@pytest.mark.parametrize("scale", [1e-10, 1e-6, 1, 1e6])
@pytest.mark.parametrize("reverse", [False, True])
def test_triangle_intersection_is_independent_of_reconstruction_units(scale, reverse):
    vertices = np.array([[-1., -1, 5], [1., -1, 5], [0., 1, 5]]) * scale
    face = [0, 2, 1] if reverse else [0, 1, 2]
    projector = MeshProjector(vertices, np.array([face]))
    point, distance, incidence = projector.intersect(np.zeros(3), np.array([0., 0, 1]))
    np.testing.assert_allclose(point / scale, [0, 0, 5], atol=1e-12)
    assert distance / scale == pytest.approx(5)
    assert incidence == pytest.approx(1)
    assert projector.intersect(np.zeros(3), np.array([1., 0, 0])) is None
    assert projector.intersect(np.zeros(3), np.array([0., 0, -1])) is None
