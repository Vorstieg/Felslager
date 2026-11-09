"""Content identifiers for the actual model and engine presets used by a run."""
import hashlib
import os
from pathlib import Path


def digest(filename):
    path = Path(filename).expanduser()
    if not path.is_file():
        return None
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else _digest(stream)


def _digest(stream):
    value = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        value.update(chunk)
    return value.hexdigest()


def reconstruction_presets(engine, work):
    result = {'presetVersion': 1}
    if engine == 'meshroom':
        result['pipelineSha256'] = digest(work / 'meshroom' / 'pipeline.mg')
    elif engine == 'realityscan':
        result['exportPresetSha256'] = {key: digest(os.environ[key]) for key in
            ('REALITYSCAN_MODEL_PARAMS', 'REALITYSCAN_REGISTRATION_PARAMS') if key in os.environ}
    return result
