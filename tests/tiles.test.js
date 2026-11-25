import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { mkdtemp, writeFile, rm, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTileRouter } from '../tiles.js';
import { createApp } from '../index.js';

async function fixture(t, useDefault = false, fullApp = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'felslager-tiles-'));
  const tilesDir = path.join(root, 'tiles');
  await mkdir(tilesDir);
  const content = Buffer.from('PMTiles test archive bytes');
  const archive = path.join(tilesDir, 'via-ferrata.pmtiles');
  await writeFile(archive, content);
  await mkdir(path.join(root, 'content'));
  const config = {
    dataDir: path.join(root, 'content'), databasePath: path.join(root, 'auth.sqlite'),
    tilesDir: useDefault ? undefined : tilesDir,
    secret: 'test-secret-longer-than-thirty-two-characters',
    baseURL: 'http://localhost:3001/api/auth', studioURL: 'http://localhost:5173',
    trustedOrigins: ['http://localhost:5173'], production: false,
  };
  const instance = fullApp ? createApp(config) : null;
  const app = instance?.app || express();
  if (!fullApp) app.use('/api/tiles', createTileRouter(config));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await instance?.close();
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/api/tiles/via-ferrata.pmtiles`;
  return { url, archive, content };
}

test('anonymous full reads, HEAD, CORS and cache validators', async t => {
  const { url, content } = await fixture(t, true);
  const response = await fetch(url, { headers: { Origin: 'https://www.felsverzeichnis.at' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-expose-headers'), /ETag/);
  assert.equal(response.headers.get('content-type'), 'application/vnd.pmtiles');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.match(response.headers.get('cache-control'), /max-age=3600/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(content.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const cached = await fetch(url, { headers: { 'If-None-Match': response.headers.get('etag'), 'Cache-Control': 'max-age=0' } });
  assert.equal(cached.status, 304);
});

test('byte ranges return exactly the requested bytes, including suffix and open ranges', async t => {
  const { url, content } = await fixture(t);
  for (const [range, start, end] of [
    ['bytes=0-6', 0, 6], ['bytes=8-', 8, content.length - 1],
    ['bytes=-5', content.length - 5, content.length - 1],
    ['bytes=2-99999', 2, content.length - 1],
  ]) {
    const response = await fetch(url, { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${content.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), content.subarray(start, end + 1));
  }
  const head = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=0-6' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '7');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const invalid = await fetch(url, { headers: { Range: 'bytes=99999-' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), `bytes */${content.length}`);
});

test('public preflight, read-only access, missing files and atomic replacement', async t => {
  const { url, archive } = await fixture(t);
  const options = await fetch(url, { method: 'OPTIONS', headers: {
    Origin: 'https://www.felsverzeichnis.at', 'Access-Control-Request-Headers': 'range',
  } });
  assert.equal(options.status, 204);
  assert.match(options.headers.get('access-control-allow-headers'), /Range/);
  assert.equal((await fetch(url, { method: 'PUT', body: 'overwrite' })).status, 405);
  assert.equal((await fetch(url.replace('via-ferrata', 'other'))).status, 404);
  await writeFile(`${archive}.new`, 'replacement');
  await rename(`${archive}.new`, archive);
  assert.equal(await (await fetch(url)).text(), 'replacement');
  await rm(archive);
  assert.equal((await fetch(url)).status, 404);
});


test('full application exposes tile ranges and public preflight ahead of authenticated API middleware', async t => {
  const { url } = await fixture(t, true, true);
  for (const origin of ['http://localhost:5173', 'https://www.felsverzeichnis.at']) {
    const response = await fetch(url, { headers: { Origin: origin, Range: 'bytes=0-6' } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), 'PMTiles');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('access-control-expose-headers'), /Content-Range/);
    assert.equal((await fetch(url, { method: 'OPTIONS', headers: { Origin: origin } })).status, 204);
    assert.equal((await fetch(url, { method: 'DELETE', headers: { Origin: origin } })).status, 405);
  }
});
