"""Deployment orchestration uses Prefect state rather than a second queue."""
from contextlib import contextmanager
from unittest.mock import Mock

import pytest
from prefect.client.orchestration import get_client
from prefect.states import Completed, Failed

from felslager_processing import api, worker
from felslager_processing.errors import JobCancelled, ReconstructionError


@pytest.fixture
def execution(monkeypatch):
    @contextmanager
    def enter(job_id, run_id):
        yield {"id": job_id, "runBoltDetection": True}
    monkeypatch.setattr(api, "execution", enter)
    monkeypatch.setattr(api, "check_cancelled", Mock())
    monkeypatch.setattr(api, "report_progress", Mock())
    monkeypatch.setattr(worker, "reconstruct_job", Mock())


def test_reconstruction_invokes_detection_deployment(prefect_backend, execution, monkeypatch):
    deploy = Mock(return_value=Mock(state=Completed()))
    monkeypatch.setattr(worker, "run_deployment", deploy)
    state = worker.reconstruction_flow("job", return_state=True)
    assert state.is_completed()
    args = deploy.call_args
    assert args.args == ("Felslager detection/detection",)
    assert args.kwargs["parameters"] == {"job_id": "job", "root_run_id": str(state.state_details.flow_run_id)}
    with get_client(sync_client=True) as client:
        run = client.read_flow_run(state.state_details.flow_run_id)
        assert run.parameters == {"job_id": "job"}
        assert run.name == "processing-job"


@pytest.mark.parametrize("error,cancelled", [(ReconstructionError("Engine failed"), False), (JobCancelled(), True)])
def test_failures_and_cancellation_are_prefect_states(prefect_backend, execution, monkeypatch, error, cancelled):
    worker.reconstruct_job.side_effect = error
    state = worker.reconstruction_flow("job", return_state=True)
    assert state.is_cancelled() if cancelled else state.is_failed()


def test_detection_failure_fails_parent(prefect_backend, execution, monkeypatch):
    monkeypatch.setattr(worker, "run_deployment", Mock(return_value=Mock(state=Failed(message="Inference failed"))))
    state = worker.reconstruction_flow("job", return_state=True)
    assert state.is_failed()


def test_reconstruction_only_skips_detection(prefect_backend, execution, monkeypatch):
    @contextmanager
    def enter(*args):
        yield {"id": "job", "runBoltDetection": False}
    monkeypatch.setattr(api, "execution", enter)
    deploy = Mock()
    monkeypatch.setattr(worker, "run_deployment", deploy)
    assert worker.reconstruction_flow("job", return_state=True).is_completed()
    deploy.assert_not_called()


def test_runner_serves_deployments_without_custom_polling(monkeypatch):
    monkeypatch.setenv("PREFECT_API_URL", "http://example.invalid/api")
    serve = Mock()
    monkeypatch.setattr(worker.reconstruction_flow, "serve", serve)
    worker.run("reconstruction", "odm")
    serve.assert_called_once_with(name="reconstruct-odm", limit=1, pause_on_shutdown=False)


def test_worker_requires_explicit_prefect_server(monkeypatch):
    monkeypatch.delenv("PREFECT_API_URL", raising=False)
    with pytest.raises(RuntimeError, match="PREFECT_API_URL"):
        worker.run("reconstruction", "odm")


def test_execution_restores_run_context_on_failure(monkeypatch):
    monkeypatch.setattr(api, "request", Mock(return_value=Mock(json=lambda: {"id": "job"})))
    with pytest.raises(ReconstructionError):
        with api.execution("job", "root-run") as job:
            assert job["id"] == "job" and api.ACTIVE_RUN_ID == "root-run"
            raise ReconstructionError("Engine stopped")
    assert api.ACTIVE_RUN_ID is None
