"""Felslager HTTP protocol, leases, heartbeats and progress reporting."""
from datetime import datetime, timezone
import logging
import os
from pathlib import Path
import threading

import requests
from dotenv import load_dotenv

from .errors import JobCancelled, LeaseLost

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
LOG = logging.getLogger("felslager-worker")
API = os.environ.get("FELSLAGER_JOBS_URL", "http://127.0.0.1:3001/api/processing").rstrip("/")
TOKEN = os.environ.get("BOLT_WORKER_TOKEN", "")
ACTIVE_LEASE = None
LEASE_ERROR = None


def heartbeat_interval():
    interval = float(os.environ.get("BOLT_HEARTBEAT_SECONDS", "10"))
    if not 0 < interval < float("inf"):
        raise ValueError("BOLT_HEARTBEAT_SECONDS must be positive and finite")
    return interval


class Heartbeat:
    """Renew the lease even during blocking engine uploads and model inference."""
    def __init__(self, job_id, lease_expires_at=None):
        self.job_id = job_id
        self.interval = heartbeat_interval()
        if lease_expires_at:
            remaining = (datetime.fromisoformat(lease_expires_at.replace("Z", "+00:00"))
                         - datetime.now(timezone.utc)).total_seconds()
            if remaining <= 0:
                raise LeaseLost("Claimed job lease already expired")
            self.interval = min(self.interval, max(0.001, remaining / 3))
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def run(self):
        global LEASE_ERROR
        while not self.stopped.wait(self.interval):
            try:
                check_cancelled(self.job_id)
            except Exception as error:
                LEASE_ERROR = error
                return

    def __exit__(self, *args):
        self.stopped.set()
        self.thread.join(timeout=65)


def request(method: str, path: str, **kwargs):
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if ACTIVE_LEASE:
        headers["X-Worker-Lease"] = ACTIVE_LEASE
    response = requests.request(method, API + path, headers=headers, timeout=kwargs.pop("timeout", 60), **kwargs)
    if response.status_code == 409:
        raise LeaseLost("Job lease has expired or belongs to another worker")
    if response.status_code >= 400:
        raise RuntimeError(f"Felslager API {method} {path}: {response.status_code} {response.text[:500]}")
    return response


def check_cancelled(job_id: str) -> None:
    if LEASE_ERROR:
        raise LEASE_ERROR
    status = request("GET", f"/worker/{job_id}").json()
    if status.get("cancelRequested") or status.get("status") == "cancelled":
        raise JobCancelled()


def report_progress(job_id: str, stage: str, progress: int, current: int | None = None, total: int | None = None):
    payload = {"stage": stage, "progress": progress}
    if current is not None and total is not None:
        payload.update(stageCurrent=current, stageTotal=total)
    try:
        request("POST", f"/worker/{job_id}/progress", json=payload)
    except Exception:
        LOG.warning("Could not update progress for job %s", job_id, exc_info=True)

