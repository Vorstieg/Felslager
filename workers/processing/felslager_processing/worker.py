"""Prefect deployments for reconstruction and optional remote detection."""
from importlib import import_module
import json
import os
from pathlib import Path

from prefect import flow, task
from prefect.context import get_run_context
from prefect.deployments import run_deployment
from prefect.states import Cancelled

from . import api as client
from .artifacts import publish_artifacts
from .capture import prepare_capture
from .errors import ReconstructionError, JobCancelled
from .results import finish_result
from .provenance import reconstruction_presets

# Keep the existing implementations as tasks without forwarding wrappers.
prepare = task(prepare_capture, name="Prepare capture", cache_policy=None, persist_result=False, retries=0)
export = task(publish_artifacts, name="Export reconstruction", cache_policy=None, persist_result=False, retries=0)
package = task(finish_result, name="Package result", cache_policy=None, persist_result=False, retries=0)


def reconstruct_job(job: dict):
    work = Path(job["workPath"])
    if job["startStep"] == "reconstructing":
        source = Path(job["sourceWorkPath"])
        manifest = source / "artifact.json"
        if not manifest.is_file():
            manifest = source / "prepared.json"
        artifact = json.loads(manifest.read_text())
        original_images = (source / artifact["images"]).resolve()
        if not original_images.is_relative_to(source.resolve()) or not original_images.is_dir():
            raise ReconstructionError("Prepared images are outside the private work directory or missing")
        images = work / "prepared"
        images.mkdir()
        # Own the directory layout while sharing the immutable input bytes.
        for original_root, target_root in [(original_images, images), (source / "telemetry", work / "telemetry")]:
            if not original_root.is_dir():
                continue
            for original in sorted(original_root.rglob("*")):
                client.check_cancelled(job["id"])
                target = target_root / original.relative_to(original_root)
                if original.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    if not original.is_file():
                        raise ReconstructionError("Prepared input is missing")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.symlink_to(original.resolve())
        checkpoint = work / "prepared.json"
        checkpoint.write_text(json.dumps({"version": 1, "images": "prepared"}))
    else:
        images = prepare(job, Path(job["inputPath"]), work)
    engine = job["engine"]
    if engine not in {"odm", "meshroom", "realityscan"}:
        raise ReconstructionError(f"Unsupported reconstruction engine: {engine}")
    adapter = import_module(f".engines.{engine}", __package__)
    reconstruct = task(adapter.reconstruct, name=f"Reconstruct with {engine}",
                       cache_policy=None, persist_result=False, retries=0)
    result = reconstruct(images, work / engine, lambda: client.check_cancelled(job["id"]),
                         lambda *args: client.report_progress(job["id"], *args),
                         options=job["options"]["reconstructing"])
    client.check_cancelled(job["id"])
    (work / "processing-provenance.json").write_text(json.dumps(reconstruction_presets(engine, work)))
    artifact = export(work, result, images, engine)
    if not job["runBoltDetection"]:
        package(job, artifact, work / artifact["images"])


def detect_job(job: dict):
    work = Path(job["sourceWorkPath"] if job["startStep"] in {"detecting", "positioning"} else job["workPath"])
    artifact = json.loads((work / "artifact.json").read_text())
    if (artifact.get("version") != 1 or artifact.get("engine") != job["engine"]
            or artifact.get("coordinateSystem") not in {"Z_UP", "Y_UP"}
            or not isinstance(artifact.get("names"), dict)):
        raise ReconstructionError("Invalid reconstruction artifact metadata")
    images = (work / artifact["images"]).resolve()
    if not images.is_relative_to(work.resolve()) or not images.is_dir():
        raise ReconstructionError("Prepared images are outside the private work directory or missing")
    package.with_options(name="Detect bolts and package result")(job, artifact, images, detect=True)


@flow(name="Felslager reconstruction", flow_run_name="processing-{job_id}", persist_result=False, retries=0)
def reconstruction_flow(job_id: str):
    run_id = str(get_run_context().flow_run.id)
    try:
        with client.execution(job_id, run_id) as job:
            reconstruct_job(job)
            if job["runBoltDetection"]:
                client.check_cancelled(job_id)
                client.report_progress(job_id, "detecting", 0)
                detection = run_deployment("Felslager detection/detection",
                    parameters={"job_id": job_id, "root_run_id": run_id},
                    flow_run_name=f"detection-{job_id}", idempotency_key=run_id)
                if not detection.state.is_completed():
                    raise ReconstructionError(detection.state.message or "Bolt detection failed")
    except JobCancelled:
        return Cancelled(message="Processing cancelled")


@flow(name="Felslager detection", flow_run_name="detection-{job_id}", persist_result=False, retries=0)
def detection_flow(job_id: str, root_run_id: str | None = None):
    root_run_id = root_run_id or str(get_run_context().flow_run.id)
    try:
        with client.execution(job_id, root_run_id) as job:
            detect_job(job)
    except JobCancelled:
        return Cancelled(message="Processing cancelled")


def run(role: str, engine: str | None = None):
    if not os.environ.get("PREFECT_API_URL"):
        raise RuntimeError("PREFECT_API_URL is required; start the Prefect server first")
    selected = reconstruction_flow if role == "reconstruction" else detection_flow
    selected.serve(name=f"reconstruct-{engine}" if role == "reconstruction" else "detection",
                   limit=1, pause_on_shutdown=False)
