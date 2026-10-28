import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import { relativePath, privateRoot, atomicJSON } from './storage-utils.js';
import { createPrefect, processingState } from './prefect.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createProcessingRouter(config, auth, { captures, results }) {
  const directory = privateRoot(config, 'processingDir', 'processing');
  const router = express.Router();
  const jobDir = (id) => path.join(directory, id);
  const prefect = createPrefect(config);
  const read = async (id) => {
    if (!uuid.test(id)) throw Object.assign(new Error('JOB_NOT_FOUND'), { status: 404 });
    let job;
    try { job = JSON.parse(await fs.promises.readFile(path.join(jobDir(id), 'job.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw Object.assign(new Error('JOB_NOT_FOUND'), { status: 404 }); throw error; }
    const result = await results.find(job);
    if (result) {
      const source = job.sourceProcessingId ? await read(job.sourceProcessingId) : job;
      const canRerunPlacement = !!job.runBoltDetection && fs.existsSync(path.join(workDir(source), 'artifact.json'))
        && fs.existsSync(path.join(jobDir(source.id), 'results', 'generated', 'detections.json'));
      return { ...job, status: 'completed', stage: 'completed', progress: 100, canRerunPlacement };
    }
    const state = await processingState(config, job);
    const stage = state.cancelRequested ? 'cancelling' : ['failed', 'cancelled'].includes(state.status) ? state.status : job.stage;
    return { ...job, ...state, stage };
  };
  const save = (job) => atomicJSON(path.join(jobDir(job.id), 'job.json'), job);
  const outputDirFor = (job) => path.join(jobDir(job.id), 'outputs', job.flowRunId);
  const workDir = (job) => path.join(jobDir(job.id), 'artifacts', job.flowRunId);
  const requireRun = (req, job) => {
    if (!job.flowRunId || req.headers['x-processing-run'] !== job.flowRunId || job.status !== 'processing' || job.cancelRequested)
      throw Object.assign(new Error('PROCESSING_RUN_INACTIVE'), { status: 409 });
  };

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
    id: job.id, sourceProcessingId: job.sourceProcessingId, canRerunPlacement: !!job.canRerunPlacement, runBoltDetection: job.runBoltDetection, name: job.name, status: job.status,
    captureId: job.captureId,
    engine: job.engine, boltPlacementMethod: job.boltPlacementMethod ?? 'triangle', phase: job.phase, flowRunId: job.flowRunId,
    createdAt: job.createdAt,
    progress: job.progress || 0, stage: job.stage || job.status,
    ...(Number.isInteger(job.stageCurrent) ? { stageCurrent: job.stageCurrent } : {}),
    ...(Number.isInteger(job.stageTotal) ? { stageTotal: job.stageTotal } : {}),
    ...(job.stage === 'reconstructing' && job.operation ? { operation: job.operation,
      operationProgress: job.operationProgress, operationElapsedSeconds: job.operationElapsedSeconds,
      operationRemainingSeconds: job.operationRemainingSeconds } : {}),
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
    const boltPlacementMethod = req.body?.boltPlacementMethod === undefined ? 'triangle' : req.body.boltPlacementMethod;
    if (!['triangle', 'vertex', 'multiview'].includes(boltPlacementMethod))
      return res.status(400).json({ code: 'INVALID_BOLT_PLACEMENT_METHOD' });
    const captureId = req.body?.captureId;
    if (req.body?.runBoltDetection !== undefined && typeof req.body.runBoltDetection !== 'boolean')
      return res.status(400).json({ code: 'INVALID_BOLT_DETECTION_OPTION' });
    if (captureId === undefined) return res.status(400).json({ code: 'CAPTURE_REQUIRED' });
    if (req.body.entryPath !== undefined)
      return res.status(400).json({ code: 'ENTRY_PATH_DERIVED_FROM_CAPTURE' });
    const capture = await captures.metadata(captureId);
    const id = crypto.randomUUID();
    const name = typeof req.body.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 200) : capture.name;
    const job = { id, name, engine, boltPlacementMethod, runBoltDetection: req.body.runBoltDetection ?? true,
      entryPath: capture.entryPath, captureId: capture.id,
      phase: 'reconstruction', status: 'queued', stage: 'queued', progress: 0,
      createdAt: new Date().toISOString(), error: null };
    await fs.promises.mkdir(jobDir(id), { mode: 0o700 });
    let run;
    try {
      run = await prefect.create(job);
      job.flowRunId = run.id;
      await save(job);
      await prefect.state(run.id, 'SCHEDULED');
    } catch (error) {
      if (run) await prefect.state(run.id, 'CANCELLED').catch(() => {});
      await fs.promises.rm(jobDir(id), { recursive: true, force: true });
      throw error;
    }
    res.status(202).json(summary(job));
  });

  router.post('/:id/placement', express.json({ limit: '8kb' }), async (req, res) => {
    const method = req.body?.boltPlacementMethod;
    if (!['triangle', 'vertex', 'multiview'].includes(method))
      return res.status(400).json({ code: 'INVALID_BOLT_PLACEMENT_METHOD' });
    const source = await read(req.params.id);
    if (source.status !== 'completed' || !source.canRerunPlacement)
      return res.status(409).json({ code: 'PLACEMENT_SOURCE_UNAVAILABLE' });
    const job = { id: crypto.randomUUID(), captureId: source.captureId, entryPath: source.entryPath,
      name: source.name, engine: source.engine, runBoltDetection: true, boltPlacementMethod: method,
      sourceProcessingId: source.sourceProcessingId || source.id,
      phase: 'placement', status: 'queued', stage: 'queued', progress: 0,
      createdAt: new Date().toISOString(), error: null };
    await fs.promises.mkdir(jobDir(job.id), { mode: 0o700 });
    let run;
    try {
      run = await prefect.create(job);
      job.flowRunId = run.id;
      await save(job);
      await prefect.state(run.id, 'SCHEDULED');
    } catch (error) {
      if (run) await prefect.state(run.id, 'CANCELLED').catch(() => {});
      await fs.promises.rm(jobDir(job.id), { recursive: true, force: true });
      throw error;
    }
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
    if (['queued', 'processing'].includes(job.status)) {
      await prefect.state(job.flowRunId, job.status === 'queued' ? 'CANCELLED' : 'CANCELLING');
      return res.status(job.status === 'queued' ? 200 : 202).json(summary(await read(job.id)));
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
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries.filter(item => item.isDirectory() && uuid.test(item.name))) {
      const dependent = JSON.parse(await fs.promises.readFile(path.join(jobDir(entry.name), 'job.json'), 'utf8'));
      if (dependent.sourceProcessingId === job.id)
        return res.status(409).json({ code: 'PLACEMENT_SOURCE_IN_USE' });
    }
    await fs.promises.rm(jobDir(job.id), { recursive: true, force: true });
    res.sendStatus(204);
  });

  router.get('/worker/:id', async (req, res) => {
    const job = await read(req.params.id);
    requireRun(req, job);
    await fs.promises.mkdir(workDir(job), { recursive: true, mode: 0o700 });
    const source = job.sourceProcessingId ? await read(job.sourceProcessingId) : null;
    res.json({ ...summary(job), ...(source ? {
      sourceWorkPath: workDir(source),
      detectionsPath: path.join(jobDir(source.id), 'results', 'generated', 'detections.json')
    } : {}), inputPath: captures.filesPath(job.captureId),
      workPath: workDir(job), outputAbsolutePath: outputDirFor(job) });
  });

  router.post('/worker/:id/progress', express.json({ limit: '8kb' }), async (req, res) => {
    const job = await read(req.params.id);
    requireRun(req, job);
    const progress = Number(req.body?.progress);
    const stages = new Set(['starting', 'preparing', 'uploading_to_odm', 'reconstructing', 'downloading', 'detecting', 'positioning', 'finalizing']);
    if (!Number.isFinite(progress) || progress < 0 || progress > 100 || !stages.has(req.body?.stage))
      return res.status(400).json({ code: 'INVALID_PROGRESS' });
    job.progress = Math.max(job.progress || 0, Math.round(progress));
    job.stage = req.body.stage;
    if (req.body.stage === 'detecting') job.phase = 'detection';
    for (const key of ['stageCurrent', 'stageTotal']) {
      const value = Number(req.body?.[key]);
      if (Number.isInteger(value) && value >= 0) job[key] = value;
      else delete job[key];
    }
    for (const key of ['operation', 'operationProgress', 'operationElapsedSeconds', 'operationRemainingSeconds']) {
      const value = req.body?.[key];
      const valid = req.body.stage === 'reconstructing' && (key === 'operation'
        ? typeof value === 'string' && value.length > 0 && value.length <= 120
        : Number.isFinite(value) && value >= 0 && (key !== 'operationProgress' || value <= 100));
      if (valid) job[key] = value;
      else delete job[key];
    }
    await save(job);
    res.json(summary(job));
  });

  router.post('/worker/:id/complete', express.json({ limit: '8kb' }), async (req, res) => {
    const job = await read(req.params.id);
    requireRun(req, job);
    try {
      await results.importResult(job, outputDirFor(job));
      res.json(summary(await read(job.id)));
    } catch (error) {
      res.status(error.status || 500).json({ code: 'JOB_FINALIZATION_FAILED', message: error.message });
    }
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status || 500).json({ code: error.status === 413 ? 'PAYLOAD_TOO_LARGE' : error.status ? error.message : 'PROCESSING_REQUEST_FAILED' });
  });
  return router;
}
