"""Failures shared by the API client, engines and processing stages."""


class ReconstructionError(RuntimeError):
    """A reconstruction cannot produce a usable project."""


class JobCancelled(Exception):
    pass


class LeaseLost(RuntimeError):
    pass

