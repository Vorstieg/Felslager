"""The engine-independent handoff between reconstruction and detection."""
from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import shutil

from felslager_processing.reconstruction import ReconstructionError, camera_records


@dataclass(frozen=True)
class ReconstructionOutput:
    model: Path
    cameras: Path
    names: dict[str, str]
    detection_mesh: Path
    coordinate_system: str


def publish_artifacts(work: Path, output: ReconstructionOutput, images: Path, engine: str) -> dict:
    """Export every engine into the same layout, committing the manifest last.

    Keep artifact.json and its v1 fields compatible with the artifact contract. Engine
    scratch files are private implementation details outside reconstruction/.
    """
    work = work.resolve()

    def source(filename):
        filename = Path(filename).resolve()
        if not filename.is_relative_to(work) or not filename.is_file():
            raise ReconstructionError("Reconstruction output is outside the private work directory or missing")
        return filename

    model, calibration, mesh = map(source, (output.model, output.cameras, output.detection_mesh))
    if output.coordinate_system not in {"Y_UP", "Z_UP"}:
        raise ReconstructionError("Unsupported reconstruction coordinate system")
    scene = json.loads(calibration.read_text())
    cameras = camera_records(scene)
    if (not output.names or not all(isinstance(key, str) and isinstance(value, str)
                                   for key, value in output.names.items())
            or not any(value in cameras for value in output.names.values())):
        raise ReconstructionError("Reconstructed cameras do not match any capture images")
    # ODM uses a one-element scene list; all adapters publish a single scene object.
    if isinstance(scene, list):
        scene = scene[0]
    images = images.resolve()
    if not images.is_relative_to(work) or not images.is_dir():
        raise ReconstructionError("Prepared images are outside the private work directory or missing")
    bundle = work / "reconstruction"
    bundle.mkdir()
    # Engine output and the handoff share private job storage. Rename large
    # files instead of retaining a second copy of every reconstructed mesh.
    shutil.move(str(model), bundle / "model.glb")
    (bundle / "cameras.json").write_text(json.dumps(scene))
    # Detection may need the engine's matching OBJ rather than its textured GLB.
    if mesh == model:
        mesh_name = "model.glb"
    else:
        if mesh.suffix.lower() not in {".glb", ".obj"}:
            raise ReconstructionError("Unsupported detection mesh format")
        mesh_name = "detection-mesh" + mesh.suffix.lower()
        shutil.move(str(mesh), bundle / mesh_name)
    shutil.move(str(images), bundle / "prepared-images")
    artifact = {
        "version": 1, "engine": engine,
        "model": "reconstruction/model.glb", "reconstruction": "reconstruction/cameras.json",
        "detectionMesh": "reconstruction/" + mesh_name,
        "images": "reconstruction/prepared-images", "names": output.names,
        "coordinateSystem": output.coordinate_system,
    }
    temporary = work / "artifact.json.tmp"
    temporary.write_text(json.dumps(artifact))
    temporary.replace(work / "artifact.json")
    return artifact


def artifact_path(work: Path, relative: str) -> Path:
    if not isinstance(relative, str) or Path(relative).is_absolute():
        raise ReconstructionError("Artifact paths must be relative to the private work directory")
    result = (work / relative).resolve()
    if not result.is_relative_to(work.resolve()) or not result.is_file():
        raise ReconstructionError("Artifact is missing or outside the private work directory")
    return result

