import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { createUser } from '../auth.js';
import { createApp } from '../index.js';
import { validateReviewPackage } from '../reviews.js';

const origin = 'http://localhost:5173';
function document() {
  return {
    version: 1,
    draft: {
      id: 'local', name: 'Test wall', placed: true, lastEditor: '3d', activeNodeId: 'wall',
      workspace: { clientId: 'wall', entry: { properties: { id: 'wall' } }, path: '', childEntries: [], dirtyPaths: ['wall/wall.json'], removedPaths: [], images: [], pendingImages: [] },
      media: { wall: { crops: {} } }, contexts: { wall: { glbBlob: null } }
    },
    assets: [{ keys: ['contexts', 'wall', 'glbBlob'], path: 'assets/0', type: 'model/gltf-binary' }],
    actions: [{ action: 'write', path: 'wall/wall.json' }, { action: 'write', path: 'wall/wall.glb' }]
  };
}
async function archive(value = document(), assetPath = 'assets/0') {
  const zip = new JSZip();
  zip.file('review.json', JSON.stringify(value));
  zip.file(assetPath, Buffer.from('model bytes'));
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function fixture(t, { hiddenStorage = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'felslager-review-'));
  const dataDir = path.join(directory, 'content');
  await mkdir(dataDir);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const config = { dataDir, databasePath: path.join(directory, hiddenStorage ? '.private' : 'private', 'auth.sqlite'), secret: 'test-secret-with-at-least-thirty-two-characters', baseURL: `${url}/api/auth`, studioURL: origin, trustedOrigins: [origin], production: false, trustProxy: false };
  let service = createApp(config);
  server.on('request', (req, res) => service.app(req, res));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); service.close(); await rm(directory, { recursive: true, force: true }); });
  const request = (route, init = {}) => fetch(url + route, { ...init, headers: { Origin: origin, ...init.headers } });
  const password = 'Correct horse battery staple!';
  await createUser(config, { email: 'reviewer@example.test', name: 'Reviewer', password });
  const login = await request('/api/auth/sign-in/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reviewer@example.test', password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  return { request, cookie, directory, restart() { service.close(); service = createApp(config); } };
}

test('anonymous immutable submissions, private inbox, authenticated access, and persistence', async (t) => {
  const f = await fixture(t);
  const bytes = await archive();
  const submit = () => f.request('/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: bytes });
  const response = await submit();
  assert.equal(response.status, 201);
  const review = await response.json();
  assert.equal('status' in review, false);
  assert.deepEqual(await readdir(path.join(f.directory, 'content')), []);
  for (const route of ['/api/reviews', `/api/reviews/${review.id}`, `/api/reviews/${review.id}/archive`]) assert.equal((await f.request(route)).status, 401);
  assert.equal((await f.request('/api/reviews', { headers: { Cookie: f.cookie } })).status, 200);
  const download = await f.request(`/api/reviews/${review.id}/archive`, { headers: { Cookie: f.cookie } });
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal((await f.request('/api/fs/reviews', { headers: { Cookie: f.cookie } })).status, 404);
  const another = await (await submit()).json();
  assert.notEqual(another.id, review.id);
  f.restart();
  const persisted = await (await f.request(`/api/reviews/${review.id}`, { headers: { Cookie: f.cookie } })).json();
  assert.equal(persisted.name, review.name);
  assert.deepEqual(await readFile(path.join(f.directory, 'private', 'reviews', review.id, 'archive.zip')), bytes);
  const denied = await f.request('/api/reviews', { method: 'POST', headers: { Origin: 'https://untrusted.test', 'Content-Type': 'application/zip' }, body: bytes });
  assert.equal(denied.status, 403);
});

test('reject unreadable archives, invalid inbox metadata, and unsupported versions', async () => {
  for (const value of [null, [], {}, { ...document(), version: 2 },
    { ...document(), draft: null }, { ...document(), draft: { name: ' ' } },
    { ...document(), assets: null }, { ...document(), actions: [null] },
    { ...document(), actions: [{ action: 'move', path: 'wall' }] },
    { ...document(), actions: [{ action: 'write', path: {} }] }
  ]) {
    await assert.rejects(validateReviewPackage(await archive(value)), { message: 'INVALID_REVIEW_PACKAGE', status: 400 });
  }
  await assert.rejects(validateReviewPackage(Buffer.from('broken archive')), { status: 400 });
  const missing = new JSZip();
  missing.file('other.json', '{}');
  await assert.rejects(validateReviewPackage(await missing.generateAsync({ type: 'nodebuffer' })), { status: 400 });
  const malformed = new JSZip();
  malformed.file('review.json', '{');
  await assert.rejects(validateReviewPackage(await malformed.generateAsync({ type: 'nodebuffer' })), { status: 400 });
});

test('reject oversized expanded archives and manifests', async () => {
  // Advertise expanded sizes without allocating oversized test buffers.
  for (const [entryName, size] of [['assets/0', 501 * 1024 * 1024], ['review.json', 11 * 1024 * 1024]]) {
    const oversized = await archive();
    const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    for (let offset = oversized.indexOf(signature); offset !== -1; offset = oversized.indexOf(signature, offset + 4)) {
      const nameLength = oversized.readUInt16LE(offset + 28);
      if (oversized.subarray(offset + 46, offset + 46 + nameLength).toString() === entryName) oversized.writeUInt32LE(size, offset + 24);
    }
    await assert.rejects(validateReviewPackage(oversized), { status: 400 });
  }
});

test('stores editor data without validating workspace paths, IDs, or asset references', async (t) => {
  const f = await fixture(t);
  const value = document();
  value.draft = { name: 'Opaque draft', workspace: { sourcePath: '../private' } };
  value.assets = [{ path: 'missing', keys: ['unknown'] }];
  const bytes = await archive(value, 'extra-file');
  const response = await f.request('/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: bytes });
  assert.equal(response.status, 201);
  const review = await response.json();
  assert.equal(review.name, 'Opaque draft');
  assert.deepEqual(review.actions, value.actions);
  const download = await f.request(`/api/reviews/${review.id}/archive`, { headers: { Cookie: f.cookie } });
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.deepEqual(await readdir(path.join(f.directory, 'content')), []);
});

test('supports leading production paths and an empty root for moves across top-level folders', async () => {
  const value = document();
  value.draft.workspace.dirtyPaths = ['/wall/wall.json'];
  value.draft.workspace = { clientId: 'root', id: '', entry: null, path: '', childEntries: [value.draft.workspace], dirtyPaths: [], removedPaths: [], images: [] };
  assert.equal((await validateReviewPackage(await archive(value))).name, 'Test wall');
});

test('archive downloads work when private storage has a hidden ancestor directory', async (t) => {
  const f = await fixture(t, { hiddenStorage: true });
  const bytes = await archive();
  const submitted = await f.request('/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: bytes });
  assert.equal(submitted.status, 201);
  const review = await submitted.json();
  const route = `/api/reviews/${review.id}/archive`;
  assert.equal((await f.request(route)).status, 401);
  const response = await f.request(route, { headers: { Cookie: f.cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/zip/);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.deepEqual(await readFile(path.join(f.directory, '.private', 'reviews', review.id, 'archive.zip')), bytes);
});


test('deleting a pending review removes its archive and metadata and requires authentication', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: await archive() });
  const review = await response.json();
  const route = `/api/reviews/${review.id}`;
  const headers = { Cookie: f.cookie };
  assert.equal((await f.request(route, { method: 'DELETE' })).status, 401);
  assert.equal((await f.request(route, { method: 'DELETE', headers: { ...headers, Origin: 'https://untrusted.test' } })).status, 403);
  assert.equal((await f.request('/api/reviews/not-a-uuid', { method: 'DELETE', headers })).status, 404);
  assert.equal((await f.request(route, { method: 'DELETE', headers })).status, 204);
  assert.equal((await f.request(route, { method: 'DELETE', headers })).status, 204);
  assert.deepEqual(await readdir(path.join(f.directory, 'private', 'reviews')), []);
  assert.equal((await f.request(route, { headers })).status, 404);
  assert.equal((await f.request(`${route}/archive`, { headers })).status, 404);
  assert.deepEqual(await (await f.request('/api/reviews', { headers })).json(), []);
  f.restart();
  assert.deepEqual(await (await f.request('/api/reviews', { headers })).json(), []);
});
