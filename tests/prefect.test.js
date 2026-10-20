import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCaptureLibrary } from '../capture-library.js';
import { createProcessingResults } from '../processing-results.js';
import { createProcessingRouter } from '../processing.js';
import { prefectServer } from './helpers/prefect.js';

async function fixture(t, overrides = {}) {
  const prefect = await prefectServer(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'fels-prefect-'));
  const config = { dataDir: path.join(directory, 'content'), processingDir: path.join(directory, 'jobs'),
    databasePath: path.join(directory, 'auth.sqlite'), boltWorkerToken: 'worker', prefectApiUrl: prefect.url, ...overrides };
  await mkdir(config.dataDir);
  const captures = createCaptureLibrary(config);
  const source = await captures.create({ name: 'Survey', entryPath: 'wall' });
  const app = express();
  app.use(createProcessingRouter(config, { api: { getSession: async () => ({ headers: new Headers(), response: { user: {} } }) } },
    { captures, results: createProcessingResults(config) }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const request = (route, body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const start = async (engine = 'odm') => {
    const response = await request('/', { captureId: source.id, engine });
    assert.equal(response.status, 202); return response.json();
  };
  return { prefect, config, captures, source, request, start };
}

test('submission schedules the chosen Prefect deployment after recording its run ID', async t => {
  const f = await fixture(t);
  for (const engine of ['odm', 'meshroom', 'realityscan']) {
    const job = await f.start(engine), run = f.prefect.runs.get(job.flowRunId);
    assert.equal(run.deployment, `reconstruct-${engine}`);
    assert.equal(run.state.type, 'SCHEDULED');
    assert.deepEqual(run.parameters, { job_id: job.id });
    const saved = JSON.parse(await readFile(path.join(f.config.processingDir, job.id, 'job.json')));
    assert.equal(saved.flowRunId, run.id);
    assert.equal(saved.leaseToken, undefined);
  }
});

test('status, cancellation and crashes come from Prefect and inactive runs cannot write', async t => {
  const f = await fixture(t), job = await f.start();
  const headers = { Authorization: 'Bearer worker', 'X-Processing-Run': job.flowRunId };
  assert.equal((await f.request(`/worker/${job.id}`)).status, 401);
  assert.equal((await f.request(`/worker/${job.id}`, undefined, headers)).status, 409);
  f.prefect.state(job.flowRunId, 'RUNNING');
  assert.equal((await f.request(`/worker/${job.id}`, undefined, headers)).status, 200);
  assert.equal((await f.request(`/worker/${job.id}/progress`, { stage: 'reconstructing', progress: 30 }, headers)).status, 200);
  assert.equal((await f.request(`/worker/${job.id}/progress`, { stage: 'unknown', progress: 30 }, headers)).status, 400);
  const cancel = await f.request(`/${job.id}/cancel`, {});
  assert.equal(cancel.status, 202);
  assert.equal(f.prefect.runs.get(job.flowRunId).state.type, 'CANCELLING');
  assert.equal((await f.request(`/worker/${job.id}/complete`, {}, headers)).status, 409);
  f.prefect.state(job.flowRunId, 'CANCELLED');
  assert.equal((await (await f.request(`/${job.id}`)).json()).status, 'cancelled');
  const crashed = await f.start();
  f.prefect.state(crashed.flowRunId, 'CRASHED', 'Worker crashed');
  const status = await (await f.request(`/${crashed.id}`)).json();
  assert.equal(status.status, 'failed'); assert.equal(status.stage, 'failed');
  assert.equal(status.error, 'Worker crashed');
});

test('unavailable Prefect rejects admission without leaving a local queue entry', async t => {
  const f = await fixture(t, { prefectApiUrl: 'http://127.0.0.1:1/api' });
  assert.equal((await f.request('/', { captureId: f.source.id })).status, 503);
  assert.deepEqual(await readdir(f.config.processingDir), []);
});


test('RealityScan operation progress is exposed and cleared on stage changes', async t => {
  const f = await fixture(t), job = await f.start('realityscan');
  f.prefect.state(job.flowRunId, 'RUNNING');
  const headers = { Authorization: 'Bearer worker', 'X-Processing-Run': job.flowRunId };
  const details = { operation: 'Texturing', operationProgress: 42,
    operationElapsedSeconds: 12, operationRemainingSeconds: 18 };
  assert.equal((await f.request(`/worker/${job.id}/progress`,
    { stage: 'reconstructing', progress: 64, ...details }, headers)).status, 200);
  const status = await (await f.request(`/${job.id}`)).json();
  for (const [key, value] of Object.entries(details)) assert.equal(status[key], value);
  await f.request(`/worker/${job.id}/progress`, { stage: 'detecting', progress: 78 }, headers);
  const next = await (await f.request(`/${job.id}`)).json();
  assert.equal(next.operation, undefined);
  assert.equal(next.operationRemainingSeconds, undefined);
});
