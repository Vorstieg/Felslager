import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createCaptureLibrary } from '../capture-library.js';
import { createProcessingResults } from '../processing-results.js';
import { createProcessingRouter } from '../processing.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'fels-queue-'));
  const dataDir = path.join(directory, 'content');
  const processingDir = path.join(directory, 'jobs');
  await mkdir(dataDir);
  const config = { dataDir, processingDir, databasePath: path.join(directory, 'auth.sqlite'), boltWorkerToken: 'worker-secret' };
  const captures = createCaptureLibrary(config);
  const results = createProcessingResults(config);
  const app = express();
  const router = createProcessingRouter(config, {
    api: { getSession: async ({ headers }) => ({ headers: new Headers(), response: headers.get('x-no-session') ? null : { user: {} } }) }
  }, { captures: captures, results });
  app.use(router);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, { body, ...options } = {}) => fetch(base + route, {
    ...options, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer worker-secret', ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const create = async (engine = 'odm', imageCount = 2) => {
    const source = await captures.create({ name: 'Survey', entryPath: 'wall' });
    for (let i = 0; i < imageCount; i++) await captures.upload(source.id, `${i}.jpg`, Readable.from(['image']));
    const response = await request('/', { method: 'POST', body: { engine, captureId: source.id } });
    assert.equal(response.status, 202);
    const job = await response.json();
    return job;
  };
  const claim = (role = 'reconstruction', engine = 'odm') => request(`/worker/next?role=${role}&engine=${engine}`);
  const worker = (job, action, body = {}) => request(`/worker/${job.id}/${action}`, {
    method: 'POST', headers: { 'X-Worker-Lease': job.leaseToken }, body
  });
  const expire = async (job) => {
    const filename = path.join(processingDir, job.id, 'job.json');
    const stored = JSON.parse(await readFile(filename));
    stored.leaseExpiresAt = '2000-01-01T00:00:00.000Z';
    await writeFile(filename, JSON.stringify(stored));
  };
  const artifact = async (job, overrides = {}) => {
    for (const filename of ['model.glb', 'reconstruction.json']) await writeFile(path.join(job.workPath, filename), 'artifact');
    await writeFile(path.join(job.workPath, 'artifact.json'), JSON.stringify({
      version: 1, engine: job.engine, model: 'model.glb', reconstruction: 'reconstruction.json',
      detectionMesh: 'model.glb', names: { '0.jpg': '0.jpg' }, coordinateSystem: 'Z_UP', ...overrides
    }));
  };
  return { request, create, claim, worker, expire, artifact, dataDir, processingDir };
}

test('uploads preserve data and workers claim jobs for their selected engine', async (t) => {
  const f = await fixture(t);
  for (const engine of ['unknown', '', 1, {}]) {
    assert.equal((await f.request('/', { method: 'POST', body: { engine } })).status, 400);
  }
  const first = await f.create('meshroom', 20);
  const second = await f.create('realityscan');
  const third = await f.create();
  assert.equal((await f.claim('detection')).status, 204);
  const leased = await (await f.claim('reconstruction', 'meshroom')).json();
  assert.equal((await f.claim('reconstruction', 'meshroom')).status, 204);
  assert.equal(leased.id, first.id);
  assert.equal(leased.phase, 'reconstruction');
  assert.equal((await f.claim('reconstruction', 'realityscan').then((r) => r.json())).id, second.id);
  assert.equal((await f.claim().then((r) => r.json())).id, third.id);
  assert.equal((await f.request('/worker/next')).status, 400);
  assert.equal((await f.request('/worker/next?role=detection', { headers: { Authorization: '' } })).status, 401);
  assert.equal((await f.request('/', { headers: { 'X-No-Session': '1' } })).status, 401);
});

test('FIFO ordering uses creation time', async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  await f.create();
  const filename = path.join(f.processingDir, first.id, 'job.json');
  const stored = JSON.parse(await readFile(filename));
  stored.createdAt = '2000-01-01T00:00:00Z';
  await writeFile(filename, JSON.stringify(stored));
  const claimed = await f.claim().then((r) => r.json());
  assert.equal(claimed.id, first.id);
  assert.equal(claimed.engine, 'odm');
  assert.equal(claimed.phase, 'reconstruction');
});

test('reconstruction handoff validates private artifacts and only detection can finalize', async (t) => {
  const f = await fixture(t);
  await f.create();
  const reconstruction = await f.claim().then((r) => r.json());
  assert.equal((await f.worker(reconstruction, 'complete')).status, 409);
  assert.equal((await f.worker(reconstruction, 'reconstructed')).status, 400);
  await f.artifact(reconstruction, { model: '../outside.glb' });
  assert.equal((await f.worker(reconstruction, 'reconstructed')).status, 400);
  const outside = path.join(f.dataDir, 'outside.glb');
  await writeFile(outside, 'private');
  await symlink(outside, path.join(reconstruction.workPath, 'linked.glb'));
  await f.artifact(reconstruction, { model: 'linked.glb' });
  assert.equal((await f.worker(reconstruction, 'reconstructed')).status, 400);
  await f.artifact(reconstruction);
  const handed = await f.worker(reconstruction, 'reconstructed').then((r) => r.json());
  assert.equal(handed.phase, 'detection'); assert.equal(handed.status, 'queued');
  assert.equal((await f.claim()).status, 204);
  const detection = await f.claim('detection').then((r) => r.json());
  assert.equal(detection.workPath, reconstruction.workPath);
  assert.notEqual(detection.leaseToken, reconstruction.leaseToken);
  assert.equal((await f.worker(reconstruction, 'fail')).status, 409);
  assert.equal((await f.worker(detection, 'reconstructed')).status, 409);
  assert.equal((await f.worker(detection, 'complete')).status, 500);
  await mkdir(detection.outputAbsolutePath, { recursive: true });
  await writeFile(path.join(detection.outputAbsolutePath, 'model.glb'), 'model');
  await writeFile(path.join(detection.outputAbsolutePath, 'project.json'), JSON.stringify({ hits: [], cameras: {}, coordinateSystem: 'Z_UP' }));
  const completed = await f.worker(detection, 'complete');
  assert.equal(completed.status, 200, await completed.clone().text());
  const result = await completed.json();
  assert.equal(result.status, 'completed');
  await assert.rejects(readFile(path.join(f.dataDir, 'wall', 'model.glb')), { code: 'ENOENT' });
});

test('expired workers are recovered with isolated artifacts and stale leases cannot mutate', async (t) => {
  const f = await fixture(t);
  await f.create();
  const old = await f.claim().then((r) => r.json());
  assert.equal((await f.request(`/worker/${old.id}`)).status, 409);
  assert.equal((await f.request(`/worker/${old.id}`, { headers: { 'X-Worker-Lease': old.leaseToken } })).status, 200);
  await f.expire(old);
  assert.equal((await f.worker(old, 'progress', { stage: 'reconstructing', progress: 10 })).status, 409);
  const current = await f.claim().then((r) => r.json());
  assert.equal(current.id, old.id);
  assert.notEqual(current.workPath, old.workPath);
  assert.notEqual(current.outputAbsolutePath, old.outputAbsolutePath);
  for (const action of ['progress', 'reconstructed', 'complete', 'fail', 'cancelled']) assert.equal((await f.worker(old, action)).status, 409);
  assert.equal((await f.worker(current, 'progress', { stage: 'reconstructing', progress: 30 })).status, 200);
  await f.artifact(current);
  await f.worker(current, 'reconstructed');
  const detection = await f.claim('detection').then((r) => r.json());
  await f.expire(detection);
  const retried = await f.claim('detection').then((r) => r.json());
  assert.equal(retried.workPath, current.workPath);
  assert.notEqual(retried.outputAbsolutePath, detection.outputAbsolutePath);
  assert.equal((await f.worker(detection, 'complete')).status, 409);
});

test('cancellation covers queued jobs, phase handoff, and crashed active workers', async (t) => {
  const f = await fixture(t);
  const queued = await f.create();
  assert.equal((await f.request(`/${queued.id}/cancel`, { method: 'POST' }).then((r) => r.json())).status, 'cancelled');
  await f.create();
  const active = await f.claim().then((r) => r.json());
  assert.equal((await f.request(`/${active.id}/cancel`, { method: 'POST' })).status, 202);
  assert.equal((await f.worker(active, 'reconstructed').then((r) => r.json())).status, 'cancelled');
  await f.create();
  const crashed = await f.claim().then((r) => r.json());
  await f.request(`/${crashed.id}/cancel`, { method: 'POST' });
  await f.expire(crashed);
  assert.equal((await f.claim()).status, 204);
  assert.equal((await f.request(`/${crashed.id}`).then((r) => r.json())).status, 'cancelled');
  await f.create();
  const reconstruction = await f.claim().then((r) => r.json());
  await f.artifact(reconstruction); await f.worker(reconstruction, 'reconstructed');
  const detection = await f.claim('detection').then((r) => r.json());
  await f.request(`/${detection.id}/cancel`, { method: 'POST' });
  assert.equal((await f.worker(detection, 'fail', { error: 'cancelled subprocess' }).then((r) => r.json())).status, 'cancelled');
});
