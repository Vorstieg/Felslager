import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fromNodeHeaders } from 'better-auth/node';
import { privateRoot, relativePath, safePath, regularTree, fail } from './storage-utils.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff']);
const extension = (file) => path.posix.extname(file.path).toLowerCase();
export function createCaptureLibrary(config) {
  const directory = privateRoot(config, 'captureDir', 'captures');
  const locations = new Map();
  const captureFolder = /^(.+)--([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  // Capture folders encode their name and ID; ancestors are the Fels entry path.
  const scan = (parent) => {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const folder = path.join(parent, entry.name);
      const match = captureFolder.exec(entry.name);
      if (match && fs.existsSync(path.join(folder, 'files'))) locations.set(match[2], folder);
      else scan(folder);
    }
  };
  scan(directory);
  const captureDir = (id) => {
    if (typeof id !== 'string' || !uuid.test(id) || !locations.has(id)) fail('CAPTURE_NOT_FOUND', 404);
    return locations.get(id);
  };
  const filesPath = (id) => path.join(captureDir(id), 'files');
  const metadata = async (id) => {
    const folder = captureDir(id);
    return { id, name: captureFolder.exec(path.basename(folder))[1],
      entryPath: path.relative(directory, path.dirname(folder)).split(path.sep).join('/'),
      createdAt: (await fs.promises.stat(folder)).birthtime.toISOString() };
  };
  const read = async (id) => {
    const capture = await metadata(id);
    const files = await Promise.all((await regularTree(filesPath(id))).map(async (relative) => ({
      path: relative, bytes: (await fs.promises.stat(path.join(filesPath(id), relative))).size,
    })));
    return { ...capture, files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      imageCount: files.filter((file) => imageExtensions.has(extension(file))).length };
  };
  const references = async (id) => {
    const jobs = config.processingDir || path.join(path.dirname(config.databasePath), 'processing');
    let entries;
    try { entries = await fs.promises.readdir(jobs, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const matches = [];
    for (const entry of entries.filter((e) => e.isDirectory() && uuid.test(e.name))) {
      const job = JSON.parse(await fs.promises.readFile(path.join(jobs, entry.name, 'job.json'), 'utf8'));
      if (job.captureId === id && !['completed', 'failed', 'cancelled'].includes(job.status)) matches.push(job.id);
    }
    return matches;
  };
  const describe = async (capture) => ({ ...capture, activeJobIds: await references(capture.id) });

  return {
    directory, filesPath, metadata,
    list: async (entryPath) => {
      const filter = entryPath === undefined ? undefined : relativePath(entryPath);
      const captures = await Promise.all([...locations.keys()].map(async (id) => {
        let capture;
        try { capture = await read(id); }
        catch (error) { if (error.status === 404) return null; throw error; }
        if (filter !== undefined && capture.entryPath !== filter) return null;
        const { files, ...summary } = await describe(capture);
        return { ...summary, uploadedCount: files.length };
      }));
      return captures.filter(Boolean);
    },
    get: async (id) => describe(await read(id)),
    create: async (body = {}) => {
      if (!body || typeof body !== 'object') fail('INVALID_CAPTURE');
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200) fail('INVALID_CAPTURE_NAME');
      const name = body.name.trim();
      if (name.includes('/') || name.startsWith('.') || Buffer.byteLength(name) > 200) fail('INVALID_CAPTURE_NAME');
      relativePath(name);
      const id = crypto.randomUUID();
      const entryPath = relativePath(body.entryPath);
      const folder = await safePath(directory, `${entryPath}/${name}--${id}`);
      await fs.promises.mkdir(path.join(folder, 'files'), { recursive: true, mode: 0o700 });
      locations.set(id, folder);
      return read(id);
    },
    upload: async (id, relative, input) => {
      const capture = await read(id);
      relative = relativePath(relative);
      if (capture.files.some((file) => file.path === relative)) fail('DUPLICATE_FILE_PATH', 409);
      if (capture.files.length >= 10000) fail('TOO_MANY_FILES', 409);
      const target = await safePath(filesPath(id), relative);
      const temporary = path.join(captureDir(id), `.${crypto.randomUUID()}.upload`);
      let bytes = 0;
      const counter = new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > (config.captureMaxFileBytes ?? 20 * 1024 ** 3) ||
            capture.totalBytes + bytes > (config.captureMaxDatasetBytes ?? 100 * 1024 ** 3))
          return callback(Object.assign(new Error('CAPTURE_SIZE_LIMIT'), { status: 413 }));
        callback(null, chunk);
      } });
      const abort = () => counter.destroy(new Error('Upload aborted'));
      const inputError = (error) => counter.destroy(error);
      try {
        input.once('aborted', abort);
        input.once('error', inputError);
        const transfer = pipeline(counter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        if (input.destroyed) abort();
        else input.pipe(counter);
        await transfer;
        if (!bytes) fail('NO_FILE_DATA');
        await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.promises.rename(temporary, target);
        return { path: relative, bytes };
      } finally {
        input.unpipe(counter);
        input.removeListener('aborted', abort);
        input.removeListener('error', inputError);
        input.resume();
        await fs.promises.rm(temporary, { force: true });
      }
    },
    remove: async (id) => {
      captureDir(id);
      if ((await references(id)).length) fail('CAPTURE_IN_USE', 409);
      const trash = path.join(directory, `.deleted-${id}`);
      await fs.promises.rename(captureDir(id), trash);
      locations.delete(id);
      await fs.promises.rm(trash, { recursive: true, force: true });
    },
    download: async (id, relative, handler) => {
      const filename = await safePath(filesPath(id), relative);
      try {
        if (!(await fs.promises.stat(filename)).isFile()) fail('CAPTURE_FILE_NOT_FOUND', 404);
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail('CAPTURE_FILE_NOT_FOUND', 404);
        throw error;
      }
      return handler(filename);
    },
  };
}

export function createCapturesRouter(library, auth) {
  const router = express.Router();
  router.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers), returnHeaders: true });
    for (const cookie of session.headers.getSetCookie()) res.append('Set-Cookie', cookie);
    if (!session.response) return res.status(401).json({ code: 'AUTH_REQUIRED' });
    next();
  });
  router.get('/', async (req, res) => res.json(await library.list(req.query.entryPath)));
  router.post('/', express.json({ limit: '8kb' }), async (req, res) => res.status(201).json(await library.create(req.body)));
  router.get('/:id', async (req, res) => res.json(await library.get(req.params.id)));
  router.put('/:id/files', async (req, res) => {
    res.status(201).json(await library.upload(req.params.id, req.query.path, req));
  });
  router.get('/:id/files', async (req, res) => {
    await library.download(req.params.id, req.query.path, (filename) => new Promise((resolve, reject) => {
      res.download(filename, path.basename(filename), { dotfiles: 'allow' }, (error) => error ? reject(error) : resolve());
    }));
  });
  router.delete('/:id', async (req, res) => { await library.remove(req.params.id); res.sendStatus(204); });
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status || 500).json({ code: error.status ? error.message : 'CAPTURE_REQUEST_FAILED' });
  });
  return router;
}
