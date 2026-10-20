import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProcessingOptions } from '../processing-options.js';

test('cached steps cannot change their options, while positioning can be refined', () => {
  const source = resolveProcessingOptions({ detecting: { confidence: 0.4 } });
  for (const [fromStep, options] of [
    ['positioning', { detecting: { confidence: 0.5 } }],
    ['detecting', { reconstructing: { quality: 'detailed' } }],
    ['reconstructing', { preparing: { excludedPaths: ['a.jpg'] } }],
  ]) assert.throws(() => resolveProcessingOptions(options, { source, fromStep }), /INCOMPATIBLE_RUN_OPTION/);
  const next = resolveProcessingOptions({ positioning: { method: 'vertex' } }, { source, fromStep: 'positioning' });
  assert.equal(next.positioning.method, 'vertex');
  assert.equal(next.detecting.confidence, 0.4);
  assert.equal(resolveProcessingOptions({ preparing: { videoEndSeconds: null } }, { source }).preparing.videoEndSeconds, null);
});

test('engine-specific overrides reject unsupported engines and preserve explicit clears', () => {
  assert.throws(() => resolveProcessingOptions({ reconstructing: { maxMeshVertices: 100000 } }, { engine: 'meshroom' }), /UNSUPPORTED_ENGINE_OPTION/);
  assert.throws(() => resolveProcessingOptions({ reconstructing: { textureResolution: 3000 } }, { engine: 'meshroom' }), /INVALID_PROCESSING_OPTIONS/);
  const source = resolveProcessingOptions({ reconstructing: { maxMeshVertices: 100000 } }, { engine: 'odm' });
  const next = resolveProcessingOptions({ reconstructing: { maxMeshVertices: null, textureResolution: 4096 } }, { source, engine: 'meshroom' });
  assert.equal(next.reconstructing.maxMeshVertices, null);
  assert.equal(next.reconstructing.textureResolution, 4096);
});
