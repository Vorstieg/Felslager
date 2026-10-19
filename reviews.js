import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fromNodeHeaders } from 'better-auth/node';
import JSZip from 'jszip';

const MAX_BYTES = 500 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Read inbox metadata; the editor owns draft and asset validation. Archives stay opaque on disk. */
export async function validateReviewPackage(bytes) {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const manifest = zip.file('review.json');
    const expandedBytes = Object.values(zip.files).reduce((total, entry) => total + (entry.dir ? 0 : entry._data.uncompressedSize), 0);
    if (!manifest || expandedBytes > MAX_BYTES || manifest._data.uncompressedSize > 10 * 1024 * 1024) {
      throw new Error('Invalid archive');
    }
    const document = JSON.parse(await manifest.async('string'));
    if (document?.version !== 1 || typeof document.draft?.name !== 'string' || !document.draft.name.trim() || document.draft.name.length > 500 || !Array.isArray(document.assets) || !Array.isArray(document.actions)) {
      throw new Error('Invalid manifest');
    }
    for (const action of document.actions) {
      if (!action || !['write', 'move', 'delete'].includes(action.action) || typeof action.path !== 'string' || (action.destination !== undefined && typeof action.destination !== 'string') || (action.action === 'move' && action.destination === undefined)) {
        throw new Error('Invalid action summary');
      }
    }
    return { name: document.draft.name, actions: document.actions };
  } catch {
    throw Object.assign(new Error('INVALID_REVIEW_PACKAGE'), { status: 400 });
  }
}

export function createReviewRouter(config, auth) {
  const root = path.resolve(config.reviewDir || path.join(path.dirname(config.databasePath), 'reviews'));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = fs.realpathSync(root);
  for (const protectedRoot of [fs.realpathSync(config.dataDir), fs.realpathSync(fileURLToPath(new URL('.', import.meta.url)))]) {
    if (directory === protectedRoot || directory.startsWith(protectedRoot + path.sep)) throw new Error('Review storage must be outside content and deployment checkout');
  }
  const router = express.Router();
  router.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    if (req.method === 'POST' && req.path === '/') return next();
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers), returnHeaders: true });
    for (const cookie of session.headers.getSetCookie()) res.append('Set-Cookie', cookie);
    if (!session.response) return res.status(401).json({ code: 'AUTH_REQUIRED' });
    next();
  });
  const read = async (id) => {
    if (!uuid.test(id)) throw Object.assign(new Error('REVIEW_NOT_FOUND'), { status: 404 });
    try { return JSON.parse(await fs.promises.readFile(path.join(directory, id, 'metadata.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw Object.assign(new Error('REVIEW_NOT_FOUND'), { status: 404 }); throw error; }
  };
  router.post('/', express.raw({ type: 'application/zip', limit: '500mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) return res.status(415).json({ code: 'ZIP_REQUIRED' });
    const summary = await validateReviewPackage(req.body);
    const id = crypto.randomUUID();
    const staging = path.join(directory, `.upload-${id}`);
    const metadata = { id, ...summary, created: new Date().toISOString() };
    await fs.promises.mkdir(staging, { mode: 0o700 });
    try {
      await fs.promises.writeFile(path.join(staging, 'archive.zip'), req.body, { mode: 0o600, flag: 'wx' });
      await fs.promises.writeFile(path.join(staging, 'metadata.json'), JSON.stringify(metadata), { mode: 0o600, flag: 'wx' });
      await fs.promises.rename(staging, path.join(directory, id));
    } catch (error) { await fs.promises.rm(staging, { recursive: true, force: true }); throw error; }
    res.status(201).json(metadata);
  });
  router.get('/', async (req, res) => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const reviews = await Promise.all(entries.filter((entry) => entry.isDirectory() && uuid.test(entry.name)).map((entry) => read(entry.name).catch((error) => { if (error.status === 404) return null; throw error; })));
    res.json(reviews.filter(Boolean).sort((a, b) => b.created.localeCompare(a.created)));
  });
  router.get('/:id', async (req, res) => res.json(await read(req.params.id)));
  router.get('/:id/archive', async (req, res) => {
    await read(req.params.id);
    res.type('application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="review.zip"');
    // Resolve only the fixed filename against the private root: ancestors such as .local are valid storage locations.
    res.sendFile('archive.zip', { root: path.join(directory, req.params.id), dotfiles: 'deny' });
  });
  router.delete('/:id', async (req, res) => {
    if (!uuid.test(req.params.id)) return res.status(404).json({ code: 'REVIEW_NOT_FOUND' });
    // Missing reviews are already deleted, so cleanup retries also succeed.
    await fs.promises.rm(path.join(directory, req.params.id), { recursive: true, force: true });
    res.sendStatus(204);
  });
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status || 500).json({ code: error.status === 413 ? 'PAYLOAD_TOO_LARGE' : error.status ? error.message : 'REVIEW_REQUEST_FAILED' });
  });
  return router;
}
