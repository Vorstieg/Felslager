import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { Readable } from 'node:stream';
import { createCaptureLibrary, createCapturesRouter } from '../capture-library.js';
import { createProcessingRouter } from '../processing.js';
import { createProcessingResults } from '../processing-results.js';

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'fels-captures-'));
  const config = { dataDir: path.join(directory, 'content'), databasePath: path.join(directory, 'auth.sqlite'),
    captureDir: path.join(directory, 'captures'), processingDir: path.join(directory, 'jobs'),
    boltWorkerToken: 'worker-secret', captureMaxDatasetBytes: 100, ...overrides };
  await mkdir(config.dataDir);
  const library = createCaptureLibrary(config);
  const auth = { api: { getSession: async ({ headers }) => ({ headers: new Headers(),
    response: headers.get('x-no-session') ? null : { user: {} } }) } };
  const app = express();
  app.use('/api/captures', createCapturesRouter(library, auth));
  app.use('/api/processing', createProcessingRouter(config, auth, { captures: library, results: createProcessingResults(config) }));
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve(s));
    s.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const request = (route, { body, rawBody, ...options } = {}) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    ...options, headers: { 'Content-Type': 'application/json', ...options.headers },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const create = async () => {
    const response = await request('/api/captures', { method: 'POST', body: { name: 'Drone survey', entryPath: 'wall' } });
    assert.equal(response.status, 201); return response.json();
  };
  const upload = (id, name, bytes = 'image') => request(`/api/captures/${id}/files?path=${encodeURIComponent(name)}`, { method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' }, rawBody: bytes });
  const ready = async () => {
    const capture = await create();
    for (const name of ['nested/a.jpg', 'b.tiff']) assert.equal((await upload(capture.id, name)).status, 201);
    return library.get(capture.id);
  };
  return { directory, config, library, request, create, upload, ready };
}

test('originals stay private, retain their bytes, and filenames cannot be replaced', async (t) => {
  const f = await fixture(t);
  const capture = await f.create();
  const bytes = Buffer.from([0, 255, 4, 8]);
  const uploaded = await f.upload(capture.id, 'flight/a.jpg', bytes);
  assert.equal(uploaded.status, 201);
  assert.deepEqual(await uploaded.json(), { path: 'flight/a.jpg', bytes: 4 });
  const downloaded = await f.request(`/api/captures/${capture.id}/files?path=flight%2Fa.jpg`);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  assert.equal((await f.upload(capture.id, 'flight/a.jpg')).status, 409);
  assert.equal((await f.upload(capture.id, 'b.tiff')).status, 201);
  const detail = await f.library.get(capture.id);
  assert.equal(detail.totalBytes, 9);
  assert.equal((await f.request(`/api/captures/${capture.id}/files?path=notes.txt`, { method: 'PUT',
    headers: { 'Content-Type': 'text/plain' }, rawBody: 'notes' })).status, 201);
  assert.equal((await f.upload(capture.id, 'README')).status, 201);
  assert.deepEqual(await readdir(f.config.dataDir), []);
  assert.deepEqual(await readdir(path.dirname(f.library.filesPath(capture.id))), ['files']);
  await writeFile(path.join(f.library.filesPath(capture.id), 'external.dat'), 'outside upload');
  const restarted = createCaptureLibrary(f.config);
  const restored = await restarted.get(capture.id);
  assert.equal(restored.name, capture.name);
  assert.equal(restored.entryPath, capture.entryPath);
  assert.equal(restored.files.length, 5);
  assert.ok(restored.files.some((file) => file.path === 'external.dat' && file.bytes === 14));
  const listing = await (await f.request('/api/captures')).json();
  assert.equal(listing[0].uploadedCount, 5);
  assert.equal(listing[0].files, undefined);
});

test('multiple jobs reuse a survey without copies; live references prevent deletion across restarts', async (t) => {
  const f = await fixture(t);
  const job = (captureId, engine = 'odm') => f.request('/api/processing', { method: 'POST',
    body: { captureId, engine } });
  assert.equal((await job('../outside')).status, 404);
  const capture = await f.ready();
  const firstResponse = await job(capture.id);
  assert.equal(firstResponse.status, 202);
  const first = await firstResponse.json();
  const second = await (await job(capture.id, 'meshroom')).json();
  assert.equal(first.status, 'queued');
  assert.deepEqual(await readdir(path.join(f.config.processingDir, first.id)), ['job.json']);
  const claim = await (await f.request('/api/processing/worker/next?role=reconstruction&engine=odm', {
    headers: { Authorization: 'Bearer worker-secret' },
  })).json();
  assert.equal(claim.inputPath, f.library.filesPath(capture.id));
  assert.equal(await readFile(path.join(claim.inputPath, 'nested/a.jpg'), 'utf8'), 'image');
  const restarted = createCaptureLibrary(f.config);
  await assert.rejects(restarted.remove(capture.id), /CAPTURE_IN_USE/);
  assert.equal((await f.request(`/api/captures/${capture.id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await f.request(`/api/processing/worker/${first.id}/fail`, { method: 'POST',
    headers: { Authorization: 'Bearer worker-secret', 'X-Worker-Lease': claim.leaseToken }, body: {},
  })).status, 200);
  assert.equal((await f.request(`/api/captures/${capture.id}`, { method: 'DELETE' })).status, 409);
  await f.request(`/api/processing/${second.id}/cancel`, { method: 'POST' });
  assert.equal((await f.request(`/api/captures/${capture.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await f.request(`/api/captures/${capture.id}`)).status, 404);
});

test('uploads reject traversal, invalid paths, over-budget streams and unknown datasets without registering files', async (t) => {
  const f = await fixture(t, { captureMaxDatasetBytes: 8 });
  const capture = await f.create();
  for (const name of ['../a.jpg', '/a.jpg', 'a/../a.jpg', 'a\\b.jpg', '.hidden/a.jpg', 'a//b.jpg'])
    assert.equal((await f.upload(capture.id, name)).status, 400, name);
  assert.equal((await f.upload(capture.id, 'a.jpg', '12345')).status, 201);
  assert.equal((await f.upload(capture.id, 'b.jpg', '12345')).status, 413);
  const detail = await f.library.get(capture.id);
  assert.equal(detail.totalBytes, 5);
  assert.equal(detail.files.length, 1);
  assert.deepEqual(await readdir(f.library.filesPath(capture.id)), ['a.jpg']);
  assert.equal((await f.upload(capture.id, 'b.jpg', '123')).status, 201);
  assert.equal((await f.upload(crypto.randomUUID(), 'a.jpg')).status, 404);
});

test('capture endpoints require sessions and roots cannot overlap other storage, including symlink aliases', async (t) => {
  const f = await fixture(t);
  const capture = await f.ready();
  for (const [route, method] of [['', 'GET'], ['', 'POST'], [`/${capture.id}`, 'GET'],
    [`/${capture.id}/files?path=b.tiff`, 'GET'], [`/${capture.id}/files`, 'PUT'],
    [`/${capture.id}`, 'DELETE']]) {
    assert.equal((await f.request('/api/captures' + route, { method, headers: { 'X-No-Session': '1' } })).status, 401);
  }
  for (const captureDir of [f.config.dataDir, path.join(f.config.dataDir, 'captures'), f.config.processingDir,
    path.join(f.config.processingDir, 'captures'), f.directory])
    assert.throws(() => createCaptureLibrary({ ...f.config, captureDir }), /must not overlap/);
  const alias = path.join(f.directory, 'alias');
  await symlink(f.config.dataDir, alias);
  assert.throws(() => createCaptureLibrary({ ...f.config, captureDir: alias }), /must not overlap/);
});

test('interrupted streams leave no registered images and can be retried', async (t) => {
  const f = await fixture(t);
  const capture = await f.create();
  const broken = Readable.from((async function* () {
    yield Buffer.from('partial');
    throw new Error('connection lost');
  })());
  await assert.rejects(f.library.upload(capture.id, 'a.jpg', broken), /connection lost/);
  assert.equal((await f.library.get(capture.id)).totalBytes, 0);
  assert.deepEqual(await readdir(path.dirname(f.library.filesPath(capture.id))), ['files']);
  assert.equal((await f.upload(capture.id, 'a.jpg')).status, 201);
});

test('a slow capture transfer does not block another capture', async (t) => {
  const f = await fixture(t);
  const first = await f.create(), second = await f.create();
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const transferring = new Promise((resolve) => { started = resolve; });
  const stream = Readable.from((async function* () { yield 'first'; started(); await gate; yield 'last'; })());
  const upload = f.library.upload(first.id, 'video.mp4', stream);
  await transferring;
  try {
    const response = await f.request(`/api/captures/${second.id}/files?path=photo.jpg`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, rawBody: 'photo', signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 201);
    assert.equal((await f.request(`/api/captures/${second.id}`, { signal: AbortSignal.timeout(2000) })).status, 200);
  } finally { release(); await upload; }
});
