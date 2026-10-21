"""Queue consumption and orchestration of the two processing roles."""
from importlib import import_module
import json
import logging
import os
from pathlib import Path
import time

from . import api as client
from .artifacts import publish_artifacts
from .capture import prepare_capture
from .errors import ReconstructionError, JobCancelled, LeaseLost
from .results import finish_result

LOG = logging.getLogger("felslager-worker")


def reconstruct_job(job: dict):
    job_id = job["id"]
    root, work = Path(job["inputPath"]), Path(job["workPath"])
    work.mkdir(parents=True, exist_ok=True)
    root = prepare_capture(job, root, work)
    engine = job["engine"]
    if engine not in {"odm", "meshroom", "realityscan"}:
        raise ReconstructionError(f"Unsupported reconstruction engine: {engine}")
    adapter = import_module(f".engines.{engine}", __package__)
    result = adapter.reconstruct(root, work / engine,
                                 lambda: client.check_cancelled(job_id),
                                 lambda *args: client.report_progress(job_id, *args))
    client.check_cancelled(job_id)
    artifact = publish_artifacts(work, result, root, engine)
    client.check_cancelled(job_id)
    if job["runBoltDetection"]:
        client.request("POST", f"/worker/{job_id}/reconstructed", json={})
    else:
        finish_result(job, artifact, work / artifact["images"])


def detect_job(job: dict):
    work = Path(job["workPath"])
    artifact = json.loads((work / "artifact.json").read_text())
    if (artifact.get("version") != 1 or artifact.get("engine") != job["engine"]
            or artifact.get("coordinateSystem") not in {"Z_UP", "Y_UP"}
            or not isinstance(artifact.get("names"), dict)):
        raise ReconstructionError("Invalid reconstruction artifact metadata")
    images = (work / artifact.get("images", "prepared")).resolve()
    if not images.is_relative_to(work.resolve()) or ("images" in artifact and not images.is_dir()):
        raise ReconstructionError("Prepared images are outside the private work directory or missing")
    finish_result(job, artifact, images, detect=True)


def process(job: dict, role: str):
    job_id = job["id"]
    client.ACTIVE_LEASE, client.LEASE_ERROR = job["leaseToken"], None
    try:
        with client.Heartbeat(job_id, job.get("leaseExpiresAt")):
            client.check_cancelled(job_id)
            if job.get("phase") != role:
                raise ReconstructionError("Claimed job phase does not match worker role")
            if role == "reconstruction":
                reconstruct_job(job)
            elif role == "detection":
                detect_job(job)
            else:
                raise ReconstructionError(f"Unsupported worker role: {role}")
        LOG.info("Job %s %s stage completed", job_id, role)
    except LeaseLost:
        LOG.warning("Job %s lease lost; leaving recovery to the queue", job_id)
    except JobCancelled:
        LOG.info("Job %s cancelled", job_id)
        try:
            client.request("POST", f"/worker/{job_id}/cancelled", json={})
        except Exception:
            LOG.exception("Could not mark job %s cancelled", job_id)
    except Exception as error:
        LOG.exception("Job %s failed", job_id)
        try:
            client.request("POST", f"/worker/{job_id}/fail", json={"error": str(error) if isinstance(error, ReconstructionError) else "Reconstruction or bolt detection failed. Contact the administrator if this keeps happening."})
        except Exception:
            LOG.exception("Could not mark job %s failed", job_id)
    finally:
        client.ACTIVE_LEASE, client.LEASE_ERROR = None, None


def run(role: str, engine: str | None = None):
    params = {"role": role}
    if engine:
        params["engine"] = engine
    poll_seconds = int(os.environ.get("BOLT_POLL_SECONDS", "5"))
    LOG.info("Polling Felslager queue as %s (%s)", role, engine or "YOLO")
    while True:
        try:
            response = client.request("GET", "/worker/next", params=params)
            if response.status_code == 204:
                time.sleep(poll_seconds)
                continue
            process(response.json(), role)
        except KeyboardInterrupt:
            return
        except Exception:
            LOG.exception("Worker polling failed")
            time.sleep(poll_seconds)
