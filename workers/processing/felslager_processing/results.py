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
    source = Path(job["sourceWorkPath"] if job["startStep"] in {"detecting", "positioning"} else work)
    glb = artifact_path(source, artifact["model"])
    reconstruction = artifact_path(source, artifact["reconstruction"])
    with tempfile.TemporaryDirectory(prefix="result-", dir=work) as temporary:
        staged = Path(temporary)
        if detect:
            from .detection import runner as detection
            mesh = artifact_path(source, artifact["detectionMesh"])
            detection.run_detection(job["id"], images, detection.MODEL, mesh, reconstruction, staged,
                          job["name"], artifact["names"], coordinate_system=artifact["coordinateSystem"],
                          placement_method=job["options"]["positioning"]["method"],
                          options=job["options"],
                          **({"cached_detections": Path(job["detectionsPath"])} if job["startStep"] == "positioning" else {}))
        else:
            cameras = load_cameras(reconstruction)
            exported = {name: cameras[engine_name]["center"].tolist()
                        for name, engine_name in artifact["names"].items() if engine_name in cameras}
            if not exported:
                raise ReconstructionError("Reconstructed cameras do not match any capture images")
            (staged / "project.json").write_text(json.dumps({"name": job["name"], "hits": [], "gps": [],
                "cameras": exported, "coordinateSystem": artifact["coordinateSystem"]}))
        project_path = staged / "project.json"
        project = json.loads(project_path.read_text())
        project["processing"] = {"optionsVersion": job["optionsVersion"],
                                 "options": job["options"], "engine": job.get("engine"),
                                 "processingId": job["id"]}
        provenance = source / "processing-provenance.json"
        if provenance.is_file():
            project["processing"]["reconstruction"] = json.loads(provenance.read_text())
        if "detector" in project:
            project["processing"]["detector"] = project.pop("detector")
        project_path.write_text(json.dumps(project))
        shutil.copy2(glb, staged / "model.glb")
        if (source / "telemetry").is_dir():
            shutil.copytree(source / "telemetry", staged / "telemetry")
        client.check_cancelled(job["id"])
        client.report_progress(job["id"], "finalizing", 99)
        output.parent.mkdir(parents=True, exist_ok=True)
        staged.rename(output)
        client.check_cancelled(job["id"])
        client.request("POST", f"/worker/{job['id']}/complete", json={})

