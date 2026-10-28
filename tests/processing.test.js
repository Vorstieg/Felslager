import { prefectServer } from './helpers/prefect.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import express from 'express';
import { createCaptureLibrary, createCapturesRouter } from '../capture-library.js';
import { createProcessingRouter } from '../processing.js';
import { createProcessingResults } from '../processing-results.js';

async function fixture(t, overrides = {}) {
  const prefect = await prefectServer(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fels-processing-'));
  const config = { databasePath: path.join(root, 'auth.sqlite'), dataDir: path.join(root, 'content'),
    captureDir: path.join(root, 'captures'), processingDir: path.join(root, 'processing'),
    boltWorkerToken: 'test-worker', prefectApiUrl: prefect.url, ...overrides };
  await fs.mkdir(config.dataDir);
  const captures = createCaptureLibrary(config), results = createProcessingResults(config);
  const auth = { api: { getSession: async ({ headers }) => ({ headers: new Headers(),
    response: headers.has('x-no-session') ? null : { user: {} } }) } };
  const app = express();
  app.use('/api/captures', createCapturesRouter(captures, auth));
  let router = createProcessingRouter(config, auth, { captures: captures, results });
  app.use('/api/processing', (req, res, next) => router(req, res, next));
  const restart = () => {
    router = createProcessingRouter(config, auth, { captures: createCaptureLibrary(config), results: createProcessingResults(config) });
  };
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  const request = (route, { body, bytes, headers, ...options } = {}) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    ...options, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: bytes ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const capture = async () => {
    const response = await request('/api/captures', { method: 'POST', body: { entryPath: 'austria/crag/wall', name: 'Survey' } });
    assert.equal(response.status, 201); return response.json();
  };
  const upload = (id, name, bytes = 'original') => request(`/api/captures/${id}/files?path=${encodeURIComponent(name)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, bytes,
  });
  const start = (captureId, options = {}) => request('/api/processing', { method: 'POST', body: { captureId, ...options } });
  const worker = (route, job, method = 'POST') => request('/api/processing/worker' + route, {
    method, headers: { Authorization: 'Bearer test-worker', ...(job ? { 'X-Processing-Run': job.flowRunId } : {}) },
  });
  const claim = async () => {
    const run = [...prefect.runs.values()].find(r => r.state.type === 'SCHEDULED');
    prefect.state(run.id, 'RUNNING');
    const response = await request(`/api/processing/worker/${run.parameters.job_id}`, {
      headers: { Authorization: 'Bearer test-worker', 'X-Processing-Run': run.id } });
    const job = await response.json();
    return { json: async () => ({ ...job, flowRunId: run.id }) };
  };
  return { config, request, captures, results, capture, upload, start, worker, claim, restart, prefect };
}

test('bolt placement selection is validated, persisted and passed to workers', async (t) => {
  const f = await fixture(t), capture = await f.capture();
  for (const boltPlacementMethod of [null, '', 'snap', 1, {}]) {
    assert.equal((await f.start(capture.id, { boltPlacementMethod })).status, 400);
  }
  const response = await f.start(capture.id, { boltPlacementMethod: 'vertex' });
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.equal(job.boltPlacementMethod, 'vertex');
  f.restart();
  assert.equal((await (await f.request(`/api/processing/${job.id}`)).json()).boltPlacementMethod, 'vertex');
  assert.equal((await (await f.claim()).json()).boltPlacementMethod, 'vertex');
  assert.equal((await (await f.start(capture.id)).json()).boltPlacementMethod, 'triangle');
  const multi = await f.start(capture.id, { boltPlacementMethod: 'multiview' });
  assert.equal(multi.status, 202);
  assert.equal((await multi.json()).boltPlacementMethod, 'multiview');
});

test('processing uses live capture files and permits later uploads', async (t) => {
  const f = await fixture(t), capture = await f.capture();
  for (const name of ['flight/video.mp4', 'flight/video.srt', 'photo.jpg']) assert.equal((await f.upload(capture.id, name)).status, 201);
  assert.equal((await f.upload(capture.id, 'photo.jpg')).status, 409);
  const response = await f.start(capture.id, { runBoltDetection: false });
  assert.equal(response.status, 202);
  const first = await response.json();
  assert.equal(first.runBoltDetection, false);
  assert.equal((await f.upload(capture.id, 'later.png')).status, 201);
  const claimed = await (await f.claim()).json();
  assert.equal(await fs.readFile(path.join(claimed.inputPath, 'later.png'), 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(claimed.inputPath, 'flight/video.srt'), 'utf8'), 'original');
  const second = await (await f.start(capture.id)).json();
  assert.notEqual(first.id, second.id);
  const restarted = createCaptureLibrary(f.config);
  assert.equal((await restarted.get(capture.id)).files.length, 4);
  assert.deepEqual(await fs.readdir(f.config.dataDir), []);
});

test('reconstruction-only completion returns immutable downloadable results and survives API restart', async (t) => {
  const f = await fixture(t), capture = await f.capture();
  await f.upload(capture.id, 'video.mov');
  const job = await (await f.start(capture.id, { runBoltDetection: false })).json();
  assert.equal((await f.request(`/api/processing/${job.id}/results`)).status, 409);
  const claim = await (await f.claim()).json();
  await fs.mkdir(claim.outputAbsolutePath, { recursive: true });
  await fs.writeFile(path.join(claim.outputAbsolutePath, 'model.glb'), 'model-bytes');
  await fs.writeFile(path.join(claim.outputAbsolutePath, 'project.json'), JSON.stringify({ hits: [], cameras: {}, coordinateSystem: 'Z_UP' }));
  assert.equal((await f.worker(`/${job.id}/complete`, claim)).status, 200);
  const manifest = await (await f.request(`/api/processing/${job.id}/results`)).json();
  assert.equal(manifest.captureId, capture.id);
  const file = manifest.files.find((file) => file.path === 'model.glb');
  assert.equal(await (await f.request(file.url)).text(), 'model-bytes');
  assert.ok((await fs.stat(claim.workPath)).isDirectory());
  assert.ok((await fs.stat(claim.outputAbsolutePath)).isDirectory());
  await fs.mkdir(claim.outputAbsolutePath, { recursive: true });
  await fs.writeFile(path.join(claim.outputAbsolutePath, 'model.glb'), 'changed-worker-output');
  assert.equal(await (await f.request(file.url)).text(), 'model-bytes');
  const stored = JSON.parse(await fs.readFile(path.join(f.config.processingDir, job.id, 'job.json')));
  assert.deepEqual(await createProcessingResults(f.config).manifest(stored, `/api/processing/${job.id}/results`), manifest);
  assert.equal((await f.request(file.url, { headers: { 'X-No-Session': '1' } })).status, 401);
  assert.equal((await f.request(`/api/processing/${job.id}/results/files?path=../job.json`)).status, 400);
  assert.equal((await f.request(`/api/processing/${job.id}/results/files?path=missing.json`)).status, 404);
  assert.equal((await f.request(file.url, { method: 'PUT', bytes: 'edit' })).status, 404);
  const generated = path.join(f.config.processingDir, job.id, 'results', 'generated');
  await fs.mkdir(path.join(generated, 'empty-directory'));
  await fs.symlink('missing-file', path.join(generated, 'unrelated'));
  assert.equal(await (await f.request(file.url)).text(), 'model-bytes');
  assert.equal((await f.request(`/api/processing/${job.id}/results/files?path=empty-directory`)).status, 404);
  assert.equal((await f.request(`/api/processing/${job.id}/results/files?path=unrelated`)).status, 403);
  assert.deepEqual(await fs.readdir(f.config.dataDir), []);
});

test('capture streams enforce limits, reject unsafe paths and recover interrupted uploads', async (t) => {
  const f = await fixture(t, { captureMaxFileBytes: 8 }), capture = await f.capture();
  for (const name of ['../v.mp4', '/v.mp4', '.hidden/v.srt', 'a/../v.jpg']) {
    assert.equal((await f.upload(capture.id, name)).status, 400);
  }
  assert.equal((await f.upload(capture.id, 'v.mp4', '123456789')).status, 413);
  const broken = Readable.from((async function* () { yield 'part'; throw new Error('disconnected'); })());
  await assert.rejects(f.captures.upload(capture.id, 'v.mp4', broken), /disconnected/);
  assert.equal((await f.captures.get(capture.id)).totalBytes, 0);
  assert.equal((await f.upload(capture.id, 'v.mp4', '123')).status, 201);
  for (const runBoltDetection of [null, 'yes', 1]) assert.equal((await f.start(capture.id, { runBoltDetection })).status, 400);
  assert.equal((await f.start(capture.id, { engine: 'unknown' })).status, 400);
});

test('cancellation prevents reconstruction-only completion from exposing results', async (t) => {
  const f = await fixture(t), capture = await f.capture();
  await f.upload(capture.id, 'video.webm');
  const queued = await (await f.start(capture.id)).json();
  assert.equal((await (await f.request(`/api/processing/${queued.id}/cancel`, { method: 'POST' })).json()).status, 'cancelled');
  const active = await (await f.start(capture.id, { runBoltDetection: false })).json();
  const claimed = await (await f.claim()).json();
  assert.equal((await f.request(`/api/processing/${active.id}/cancel`, { method: 'POST' })).status, 202);
  assert.equal((await f.worker(`/${active.id}/complete`, claimed)).status, 409);
  assert.equal((await f.request(`/api/processing/${active.id}/results`)).status, 409);
});


for (const runBoltDetection of [false, true]) {
  test(`a committed result recovers completion after restart (detection=${runBoltDetection})`, async (t) => {
    const f = await fixture(t), capture = await f.capture();
    await f.upload(capture.id, 'video.mp4');
    const job = await (await f.start(capture.id, { runBoltDetection })).json();
    let claimed = await (await f.claim()).json();
    await fs.mkdir(claimed.outputAbsolutePath, { recursive: true });
    await fs.writeFile(path.join(claimed.outputAbsolutePath, 'model.glb'), 'committed-model');
    await fs.writeFile(path.join(claimed.outputAbsolutePath, 'project.json'), JSON.stringify({ hits: [], cameras: {}, coordinateSystem: 'Z_UP' }));
    const filename = path.join(f.config.processingDir, job.id, 'job.json');
    const stored = JSON.parse(await fs.readFile(filename));
    // Crash point: result is installed, but job.json still says processing.
    const result = await f.results.importResult(stored, claimed.outputAbsolutePath);
    await fs.writeFile(filename, JSON.stringify(stored));
    f.restart();
    const recovered = await (await f.request(`/api/processing/${job.id}`)).json();
    assert.equal(recovered.status, 'completed');
    const persisted = JSON.parse(await fs.readFile(filename));
    assert.equal(persisted.flowRunId, claimed.flowRunId);
    assert.ok(result.completedAt);
    assert.equal((await f.worker(`/${job.id}/complete`, claimed)).status, 409);
    const manifest = await (await f.request(`/api/processing/${job.id}/results`)).json();
    const model = manifest.files.find((file) => file.path === 'model.glb');
    assert.equal(await (await f.request(model.url)).text(), 'committed-model');
  });
}

test('removing a terminal processing run deletes its results and preserves its capture', async (t) => {
  const f = await fixture(t), capture = await f.capture();
  await f.upload(capture.id, 'video.mp4');
  const job = await (await f.start(capture.id, { runBoltDetection: false })).json();
  const claimed = await (await f.claim()).json();
  await fs.mkdir(claimed.outputAbsolutePath, { recursive: true });
  await fs.writeFile(path.join(claimed.outputAbsolutePath, 'model.glb'), 'model');
  await fs.writeFile(path.join(claimed.outputAbsolutePath, 'project.json'), JSON.stringify({ hits: [], cameras: {}, coordinateSystem: 'Z_UP' }));
  assert.equal((await f.worker(`/${job.id}/complete`, claimed)).status, 200);
  assert.equal((await f.request(`/api/processing/${job.id}`, { method: 'DELETE' })).status, 204);
  await assert.rejects(fs.stat(path.join(f.config.processingDir, job.id)), { code: 'ENOENT' });
  assert.equal((await f.request(`/api/captures/${capture.id}`)).status, 200);
});

test('job creation and capture downloads do not scan unrelated capture files', async (t) => {
  const f = await fixture(t), capture = await f.capture();
  await f.upload(capture.id, 'nested/photo.jpg', 'original');
  await fs.symlink('missing-file', path.join(f.captures.filesPath(capture.id), 'unrelated'));
  const started = await f.start(capture.id);
  assert.equal(started.status, 202);
  const downloaded = await f.request(`/api/captures/${capture.id}/files?path=nested/photo.jpg`);
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), 'original');
  for (const name of ['nested', 'missing.jpg']) {
    assert.equal((await f.request(`/api/captures/${capture.id}/files?path=${name}`)).status, 404);
  }
  assert.equal((await f.request(`/api/captures/${capture.id}/files?path=unrelated`)).status, 403);
  const job = await started.json();
  await f.request(`/api/processing/${job.id}/cancel`, { method: 'POST' });
  assert.equal((await f.request(`/api/captures/${capture.id}`, { method: 'DELETE' })).status, 204);
});

test('placement reruns reuse immutable detections and reconstruction, with independent results', async (t) => {
  const f = await fixture(t), capture = await f.capture();
  const source = await (await f.start(capture.id)).json();
  assert.equal((await f.request(`/api/processing/${source.id}/placement`, { method: 'POST', body: { boltPlacementMethod: 'vertex' } })).status, 409);
  const claim = await (await f.claim()).json();
  await fs.writeFile(path.join(claim.workPath, 'artifact.json'), '{}');
  await fs.mkdir(claim.outputAbsolutePath, { recursive: true });
  for (const [name, value] of Object.entries({ 'model.glb': 'model', 'project.json': '{"hits": [], "cameras": {}, "coordinateSystem": "Z_UP"}', 'detections.json': '{"frames": []}' }))
    await fs.writeFile(path.join(claim.outputAbsolutePath, name), value);
  assert.equal((await f.worker(`/${source.id}/complete`, claim)).status, 200);
  const rerun = method => f.request(`/api/processing/${source.id}/placement`, { method: 'POST', body: { boltPlacementMethod: method } });
  assert.equal((await rerun('unknown')).status, 400);
  assert.equal((await f.request(`/api/processing/${source.id}/placement`, { method: 'POST', headers: { 'x-no-session': '1' }, body: { boltPlacementMethod: 'vertex' } })).status, 401);
  for (const method of ['triangle', 'vertex', 'multiview']) {
    const response = await rerun(method);
    assert.equal(response.status, 202);
    const child = await response.json();
    assert.equal(child.sourceProcessingId, source.id);
    assert.equal(child.boltPlacementMethod, method);
    assert.equal(f.prefect.runs.get(child.flowRunId).deployment, 'detection');
    const worker = await (await f.claim()).json();
    assert.equal(worker.sourceWorkPath, claim.workPath);
    assert.notEqual(worker.workPath, claim.workPath);
    assert.notEqual(worker.outputAbsolutePath, claim.outputAbsolutePath);
    assert.equal(await fs.readFile(worker.detectionsPath, 'utf8'), '{"frames": []}');
  }
  assert.equal((await f.request(`/api/processing/${source.id}`, { method: 'DELETE' })).status, 409);
  await fs.rm(path.join(claim.workPath, 'artifact.json'));
  assert.equal((await rerun('triangle')).status, 409);
});
