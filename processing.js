import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import { relativePath, privateRoot, atomicJSON } from './storage-utils.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createProcessingRouter(config, auth, { captures, results }) {
  const directory = privateRoot(config, 'processingDir', 'processing');
  const router = express.Router();
  const jobDir = (id) => path.join(directory, id);
  const read = async (id) => {
    if (!uuid.test(id)) throw Object.assign(new Error('JOB_NOT_FOUND'), { status: 404 });
    try {
      const job = JSON.parse(await fs.promises.readFile(path.join(jobDir(id), 'job.json'), 'utf8'));
      // Result installation is the commit point. Repair a crash before the job status was saved.
      if (job.status === 'processing') {
        const result = await results.find(job);
        if (result && result.attempt === job.leaseToken) {
          completed(job, result);
          await save(job);
        }
      }
      return job;
    } catch (error) { if (error.code === 'ENOENT') throw Object.assign(new Error('JOB_NOT_FOUND'), { status: 404 }); throw error; }
  };
  const save = (job) => atomicJSON(path.join(jobDir(job.id), 'job.json'), job);
  const leaseMs = config.boltWorkerLeaseMs ?? 300000;
  const heartbeat = (job) => { job.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString(); };
  const requireLease = (req, job) => {
    if (job.status !== 'processing') throw Object.assign(new Error('JOB_NOT_PROCESSING'), { status: 409 });
    if (!job.leaseToken || req.headers['x-worker-lease'] !== job.leaseToken || Date.parse(job.leaseExpiresAt) <= Date.now())
      throw Object.assign(new Error('STALE_WORKER_LEASE'), { status: 409 });
    heartbeat(job);
  };
  const release = (job) => { delete job.leaseToken; delete job.leaseExpiresAt; };
  const cancelled = (job) => {
    job.status = 'cancelled'; job.stage = 'cancelled'; job.cancelRequested = false;
    job.completedAt = new Date().toISOString(); release(job);
  };
  const completed = (job, result) => {
    release(job); job.status = 'completed'; job.stage = 'completed'; job.progress = 100;
    job.completedAt = result.completedAt;
  };
  const outputDirFor = (job) => path.join(jobDir(job.id), 'outputs', job.leaseToken);
  const workDir = (job) => path.join(jobDir(job.id), 'artifacts', job.reconstructionId);

  const requireSession = async (req, res, next) => {
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers), returnHeaders: true });
      for (const cookie of session.headers.getSetCookie()) res.append('Set-Cookie', cookie);
      if (!session.response) return res.status(401).json({ code: 'AUTH_REQUIRED' });
      next();
    } catch (error) { next(error); }
  };
  const requireWorker = (req, res, next) => {
    const expected = config.boltWorkerToken || '';
    const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
    if (!expected) return res.status(503).json({ code: 'WORKER_NOT_CONFIGURED' });
    const left = Buffer.from(supplied);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right))
      return res.status(401).json({ code: 'WORKER_AUTH_REQUIRED' });
    next();
  };
  const summary = (job) => ({
    id: job.id, runBoltDetection: job.runBoltDetection, name: job.name, status: job.status,
    captureId: job.captureId,
    engine: job.engine, phase: job.phase,
    createdAt: job.createdAt,
    progress: job.progress || 0, stage: job.stage || job.status,
    ...(Number.isInteger(job.stageCurrent) ? { stageCurrent: job.stageCurrent } : {}),
    ...(Number.isInteger(job.stageTotal) ? { stageTotal: job.stageTotal } : {}),
    ...(job.cancelRequested ? { cancelRequested: true } : {}),
    ...(job.entryPath ? { entryPath: job.entryPath } : {}),
    ...(job.error ? { error: job.error } : {})
  });

  router.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.path.startsWith('/worker/')) return requireWorker(req, res, next);
    return requireSession(req, res, next);
  });

  router.post('/', express.json({ limit: '32kb' }), async (req, res) => {
    const engine = req.body?.engine ?? 'odm';
    if (!['odm', 'meshroom', 'realityscan'].includes(engine))
      return res.status(400).json({ code: 'INVALID_RECONSTRUCTION_ENGINE' });
    const captureId = req.body?.captureId;
    if (req.body?.runBoltDetection !== undefined && typeof req.body.runBoltDetection !== 'boolean')
      return res.status(400).json({ code: 'INVALID_BOLT_DETECTION_OPTION' });
    if (captureId === undefined) return res.status(400).json({ code: 'CAPTURE_REQUIRED' });
    if (req.body.entryPath !== undefined)
      return res.status(400).json({ code: 'ENTRY_PATH_DERIVED_FROM_CAPTURE' });
    const capture = await captures.metadata(captureId);
    const id = crypto.randomUUID();
    const name = typeof req.body.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 200) : capture.name;
    const job = { id, name, engine, runBoltDetection: req.body.runBoltDetection ?? true,
      entryPath: capture.entryPath, captureId: capture.id,
      phase: 'reconstruction', status: 'queued', stage: 'queued', progress: 0,
      createdAt: new Date().toISOString(), error: null };
    await fs.promises.mkdir(jobDir(id), { mode: 0o700 });
    try { await save(job); }
    catch (error) { await fs.promises.rm(jobDir(id), { recursive: true, force: true }); throw error; }
    res.status(202).json(summary(job));
  });

  router.get('/', async (req, res) => {
    const filter = req.query.entryPath === undefined ? undefined : relativePath(req.query.entryPath);
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries.filter((item) => item.isDirectory() && uuid.test(item.name))) {
      try { const job = await read(entry.name); if (filter === undefined || job.entryPath === filter) jobs.push(summary(job)); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(jobs);
  });

  router.post('/:id/cancel', async (req, res) => {
    const job = await read(req.params.id);
    if (job.status === 'cancelled') return res.json(summary(job));
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.stage = 'cancelled';
      job.completedAt = new Date().toISOString();
      await save(job);
      return res.json(summary(job));
    }
    if (job.status === 'processing') {
      job.cancelRequested = true;
      job.stage = 'cancelling';
      await save(job);
      return res.status(202).json(summary(job));
    }
    res.status(409).json({ code: 'JOB_NOT_CANCELLABLE' });
  });

  router.get('/:id', async (req, res) => res.json(summary(await read(req.params.id))));

  router.get('/:id/results', async (req, res) => {
    const job = await read(req.params.id);
    if (job.status !== 'completed') return res.status(409).json({ code: 'RESULT_NOT_READY' });
    res.json(await results.manifest(job, `${req.baseUrl}/${job.id}/results`));
  });
  router.get('/:id/results/files', async (req, res) => {
    const job = await read(req.params.id);
    if (job.status !== 'completed') return res.status(409).json({ code: 'RESULT_NOT_READY' });
    await results.download(job, req.query.path, (filename) => new Promise((resolve, reject) => {
      res.download(filename, path.basename(filename), { dotfiles: 'allow' }, (error) => error ? reject(error) : resolve());
    }));
  });

  router.delete('/:id', async (req, res) => {
    const job = await read(req.params.id);
    if (!['completed', 'failed', 'cancelled'].includes(job.status)) return res.status(409).json({ code: 'JOB_IN_USE' });
    await fs.promises.rm(jobDir(job.id), { recursive: true, force: true });
    res.sendStatus(204);
  });

  router.get('/worker/next', async (req, res) => {
    const { role, engine } = req.query;
    if (!['reconstruction', 'detection'].includes(role) ||
        (role === 'reconstruction' && !['odm', 'meshroom', 'realityscan'].includes(engine)))
      return res.status(400).json({ code: 'INVALID_WORKER_ROLE' });
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries.filter((item) => item.isDirectory() && uuid.test(item.name))) {
      const job = await read(entry.name);
      if (job.status === 'processing' && (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.now())) {
        if (job.cancelRequested) cancelled(job);
        else { job.status = 'queued'; job.stage = 'queued'; release(job); }
        await save(job);
      }
      if (job.status === 'queued' && job.phase === role &&
          (role === 'detection' || job.engine === engine)) jobs.push(job);
    }
    jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const job = jobs[0];
    if (!job) return res.status(204).end();
    if (job.phase === 'reconstruction') job.reconstructionId = crypto.randomUUID();
    job.status = 'processing'; job.stage = 'starting'; job.progress = 0;
    delete job.stageCurrent; delete job.stageTotal;
    job.startedAt = new Date().toISOString();
    job.leaseToken = crypto.randomUUID(); heartbeat(job);
    await fs.promises.mkdir(workDir(job), { recursive: true, mode: 0o700 });
    await save(job);
    res.json({ ...summary(job), leaseToken: job.leaseToken, leaseExpiresAt: job.leaseExpiresAt,
      inputPath: captures.filesPath(job.captureId), workPath: workDir(job),
      outputAbsolutePath: outputDirFor(job) });
  });

  router.get('/worker/:id', async (req, res) => {
    const job = await read(req.params.id);
    requireLease(req, job); await save(job);
    res.json({ status: job.status, phase: job.phase, cancelRequested: Boolean(job.cancelRequested) });
  });

  router.post('/worker/:id/reconstructed', express.json({ limit: '8kb' }), async (req, res) => {
    const job = await read(req.params.id);
    requireLease(req, job);
    if (job.phase !== 'reconstruction' || job.runBoltDetection === false) return res.status(409).json({ code: 'INVALID_JOB_PHASE' });
    if (job.cancelRequested) { cancelled(job); await save(job); return res.json(summary(job)); }
    try {
      const base = await fs.promises.realpath(workDir(job));
      const manifestFile = await fs.promises.realpath(path.join(base, 'artifact.json'));
      if (!manifestFile.startsWith(base + path.sep)) throw new Error('INVALID_ARTIFACT_PATH');
      const artifact = JSON.parse(await fs.promises.readFile(manifestFile, 'utf8'));
      if (artifact.version !== 1 || artifact.engine !== job.engine) throw new Error('INVALID_ARTIFACT_MANIFEST');
      if (!artifact.names || typeof artifact.names !== 'object' || Array.isArray(artifact.names) ||
          !Object.values(artifact.names).every((name) => typeof name === 'string') ||
          !['Y_UP', 'Z_UP'].includes(artifact.coordinateSystem)) throw new Error('INVALID_ARTIFACT_MANIFEST');
      for (const key of ['model', 'reconstruction', 'detectionMesh']) {
        const relative = relativePath(artifact[key]);
        const filename = await fs.promises.realpath(path.resolve(base, relative));
        if (!filename.startsWith(base + path.sep) || !(await fs.promises.stat(filename)).isFile()) throw new Error('INVALID_ARTIFACT_PATH');
      }
    } catch { return res.status(400).json({ code: 'INVALID_RECONSTRUCTION_ARTIFACT' }); }
    job.status = 'queued'; job.phase = 'detection'; job.stage = 'queued'; job.progress = 0;
    delete job.stageCurrent; delete job.stageTotal;
    release(job); await save(job);
    res.json(summary(job));
  });

  router.post('/worker/:id/cancelled', express.json({ limit: '8kb' }), async (req, res) => {
    const job = await read(req.params.id);
    requireLease(req, job);
    cancelled(job);
    await save(job);
    res.json(summary(job));
  });

  router.post('/worker/:id/progress', express.json({ limit: '8kb' }), async (req, res) => {
    const job = await read(req.params.id);
    requireLease(req, job);
    const progress = Number(req.body?.progress);
    const stages = new Set(['starting', 'preparing', 'uploading_to_odm', 'reconstructing', 'downloading', 'detecting', 'finalizing']);
    if (!Number.isFinite(progress) || progress < 0 || progress > 100 || !stages.has(req.body?.stage))
      return res.status(400).json({ code: 'INVALID_PROGRESS' });
    job.progress = Math.max(job.progress || 0, Math.round(progress));
    job.stage = job.cancelRequested ? 'cancelling' : req.body.stage;
    for (const key of ['stageCurrent', 'stageTotal']) {
      const value = Number(req.body?.[key]);
      if (Number.isInteger(value) && value >= 0) job[key] = value;
      else delete job[key];
    }
    await save(job);
    res.json(summary(job));
  });

  router.post('/worker/:id/complete', express.json({ limit: '8kb' }), async (req, res) => {
    const job = await read(req.params.id);
    requireLease(req, job);
    if (job.phase !== 'detection' && !(job.phase === 'reconstruction' && job.runBoltDetection === false)) return res.status(409).json({ code: 'INVALID_JOB_PHASE' });
    if (job.cancelRequested) {
      cancelled(job); await save(job); return res.json(summary(job));
    }
    try {
      const result = await results.importResult(job, outputDirFor(job));
      completed(job, result);
      await save(job);
      res.json(summary(job));
    } catch (error) {
      res.status(error.status || 500).json({ code: 'JOB_FINALIZATION_FAILED', message: error.message });
    }
  });

  router.post('/worker/:id/fail', express.json({ limit: '8kb' }), async (req, res) => {
    const job = await read(req.params.id);
    requireLease(req, job);
    if (job.cancelRequested) {
      job.status = 'cancelled';
      job.stage = 'cancelled';
      job.cancelRequested = false;
      release(job);
      job.completedAt = new Date().toISOString();
      await save(job);
      return res.json(summary(job));
    }
    release(job);
    job.status = 'failed';
    job.stage = 'failed';
    job.error = typeof req.body?.error === 'string' ? req.body.error.slice(0, 1000) : 'Processing failed.';
    job.completedAt = new Date().toISOString();
    await save(job);
    res.json(summary(job));
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status || 500).json({ code: error.status === 413 ? 'PAYLOAD_TOO_LARGE' : error.status ? error.message : 'PROCESSING_REQUEST_FAILED' });
  });
  return router;
}
