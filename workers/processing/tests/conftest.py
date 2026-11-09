"""A real, isolated Prefect server for worker integration tests."""
import pytest


@pytest.fixture(scope="session")
def prefect_backend():
    from prefect.testing.utilities import prefect_test_harness

    with prefect_test_harness():
        yield
