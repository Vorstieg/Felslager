"""Package private editor results for either processing role."""
import json
from pathlib import Path
import shutil
import tempfile

from . import api as client
from .artifacts import artifact_path
from .errors import ReconstructionError
from .reconstruction import load_cameras


def finish_result(job: dict, artifact: dict, images: Path, detect: bool = False):
    work, output = Path(job["workPath"]), Path(job["outputAbsolutePath"])
    source = Path(job.get("sourceWorkPath", work))
    glb = artifact_path(source, artifact["model"])
    reconstruction = artifact_path(source, artifact["reconstruction"])
    with tempfile.TemporaryDirectory(prefix="result-", dir=work) as temporary:
        staged = Path(temporary)
        if detect:
            from .detection import runner as detection
            mesh = artifact_path(source, artifact["detectionMesh"])
            detection.run_detection(job["id"], images, detection.MODEL, mesh, reconstruction, staged,
                          job["name"], artifact["names"], coordinate_system=artifact["coordinateSystem"],
                          placement_method=job.get("boltPlacementMethod", "triangle"),
                          **({"cached_detections": Path(job["detectionsPath"])} if job.get("sourceProcessingId") else {}))
        else:
            cameras = load_cameras(reconstruction)
            exported = {name: cameras[engine_name]["center"].tolist()
                        for name, engine_name in artifact["names"].items() if engine_name in cameras}
            if not exported:
                raise ReconstructionError("Reconstructed cameras do not match any capture images")
            (staged / "project.json").write_text(json.dumps({"name": job["name"], "hits": [], "gps": [],
                "cameras": exported, "coordinateSystem": artifact["coordinateSystem"]}))
        shutil.copy2(glb, staged / "model.glb")
        if (source / "telemetry").is_dir():
            shutil.copytree(source / "telemetry", staged / "telemetry")
        client.check_cancelled(job["id"])
        client.report_progress(job["id"], "finalizing", 99)
        output.parent.mkdir(parents=True, exist_ok=True)
        staged.rename(output)
        client.check_cancelled(job["id"])
        client.request("POST", f"/worker/{job['id']}/complete", json={})

