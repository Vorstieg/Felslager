import hashlib
from felslager_processing.provenance import digest, reconstruction_presets


def test_fingerprints_identify_the_actual_pipeline_and_presets(tmp_path, monkeypatch):
    pipeline = tmp_path / 'meshroom/pipeline.mg'
    pipeline.parent.mkdir()
    pipeline.write_bytes(b'pipeline contents')
    expected = hashlib.sha256(b'pipeline contents').hexdigest()
    assert digest(pipeline) == expected
    assert reconstruction_presets('meshroom', tmp_path)['pipelineSha256'] == expected
    assert digest(tmp_path / 'missing') is None
    preset = tmp_path / 'preset.xml'
    preset.write_bytes(b'<settings/>')
    monkeypatch.setenv('REALITYSCAN_MODEL_PARAMS', str(preset))
    monkeypatch.setenv('REALITYSCAN_REGISTRATION_PARAMS', str(preset))
    provenance = reconstruction_presets('realityscan', tmp_path)
    assert provenance['exportPresetSha256']['REALITYSCAN_MODEL_PARAMS'] == hashlib.sha256(b'<settings/>').hexdigest()
    assert reconstruction_presets('odm', tmp_path) == {'presetVersion': 1}
