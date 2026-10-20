"""Private artifact access and progress callbacks for Prefect flow runs."""
from contextlib import contextmanager
import logging
import os
from pathlib import Path
import signal
import threading

import requests
from dotenv import load_dotenv

from .errors import JobCancelled

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
LOG = logging.getLogger("felslager-worker")
API = os.environ.get("FELSLAGER_JOBS_URL", "http://127.0.0.1:3001/api/processing").rstrip("/")
TOKEN = os.environ.get("BOLT_WORKER_TOKEN", "")
ACTIVE_RUN_ID = None


def request(method: str, path: str, **kwargs):
    response = requests.request(method, API + path,
        headers={"Authorization": f"Bearer {TOKEN}", "X-Processing-Run": ACTIVE_RUN_ID or ""},
        timeout=kwargs.pop("timeout", 60), **kwargs)
    if response.status_code in {404, 409}:
        raise JobCancelled("Processing run is no longer active")
    response.raise_for_status()
    return response


@contextmanager
def execution(job_id: str, run_id: str):
    """One Prefect runner subprocess owns one execution and its cleanup."""
    global ACTIVE_RUN_ID
    ACTIVE_RUN_ID = run_id
    previous = None
    def stop(*args):
        raise JobCancelled("Prefect stopped this run")
    if threading.current_thread() is threading.main_thread():
        previous = signal.signal(signal.SIGTERM, stop)
    try:
        yield request("GET", f"/worker/{job_id}").json()
    finally:
        if previous is not None:
            signal.signal(signal.SIGTERM, previous)
        ACTIVE_RUN_ID = None


def check_cancelled(job_id: str) -> None:
    request("GET", f"/worker/{job_id}")


def report_progress(job_id: str, stage: str, progress: int, current: int | None = None, total: int | None = None, details: dict | None = None):
    payload = {"stage": stage, "progress": progress}
    if current is not None and total is not None:
        payload.update(stageCurrent=current, stageTotal=total)
    if details:
        payload.update(details)
    try:
        request("POST", f"/worker/{job_id}/progress", json=payload)
    except JobCancelled:
        raise
    except requests.RequestException:
        LOG.warning("Could not update progress for job %s", job_id, exc_info=True)
