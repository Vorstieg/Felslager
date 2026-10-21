"""Run one reconstruction or detection consumer for the Felslager queue."""
import argparse
import logging
import os
import signal

from . import api as client
from .worker import run


def arguments(argv=None):
    parser = argparse.ArgumentParser(prog="python -m felslager_processing", description=__doc__)
    parser.add_argument("--role", choices=["reconstruction", "detection"], required=True)
    parser.add_argument("--engine", choices=["odm", "meshroom", "realityscan"])
    args = parser.parse_args(argv)
    if (args.role == "reconstruction") != bool(args.engine):
        parser.error("--engine is required only for the reconstruction role")
    return args


def stop_worker(signum, frame):
    # Unwind run_batch's finally block so engine process groups are terminated;
    # leave the lease for queue recovery instead of cancelling the user's job.
    raise KeyboardInterrupt


def main(argv=None):
    args = arguments(argv)
    client.heartbeat_interval()
    signal.signal(signal.SIGTERM, stop_worker)
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    if not client.TOKEN:
        raise SystemExit("BOLT_WORKER_TOKEN is required")
    if args.role == "detection":
        from .detection.runner import MODEL, get_detection_model
        if not MODEL.is_file():
            raise SystemExit(f"Bolt model file not found: {MODEL}")
        get_detection_model(MODEL)
    run(args.role, args.engine)


if __name__ == "__main__":
    main()
