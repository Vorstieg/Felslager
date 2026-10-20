"""Serve a reconstruction or detection deployment with the Prefect runner."""
import argparse
import logging
import os

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


def main(argv=None):
    args = arguments(argv)
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    if not client.TOKEN:
        raise SystemExit("BOLT_WORKER_TOKEN is required")
    run(args.role, args.engine)


if __name__ == "__main__":
    main()
