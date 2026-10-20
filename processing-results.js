import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJSON, fail, regularTree, relativePath, safePath } from './storage-utils.js';

// Completed outputs are owned by the API. Workers only write lease directories.
export function createProcessingResults(config) {
  const jobs = path.resolve(config.processingDir || path.join(path.dirname(config.databasePath), 'processing'));
  const rootFor = (job) => path.join(jobs, job.id, 'results');
  const find = async (job) => {
    try { return JSON.parse(await fs.promises.readFile(path.join(rootFor(job), 'result.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const locate = async (job) => {
    const record = await find(job);
    if (!record) fail('RESULT_NOT_FOUND', 404);
    return { root: rootFor(job), record };
  };
  return {
    find,
    importResult: async (job, output) => {
      const root = rootFor(job);
      const existing = await find(job);
      if (existing) {
        if (existing.attempt !== job.leaseToken) fail('RESULT_ALREADY_EXISTS', 409);
        return existing;
      }
      const files = await regularTree(output);
      if (!files.includes('model.glb') || !files.includes('project.json')) fail('INVALID_RESULT', 422);
      const project = JSON.parse(await fs.promises.readFile(path.join(output, 'project.json'), 'utf8'));
      if (!Array.isArray(project.hits) || !project.cameras || !['Y_UP', 'Z_UP'].includes(project.coordinateSystem)) fail('INVALID_RESULT', 422);
      const staging = path.join(jobs, job.id, `.result-${crypto.randomUUID()}`);
      try {
        await fs.promises.cp(output, path.join(staging, 'generated'), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
        const record = { attempt: job.leaseToken, completedAt: new Date().toISOString() };
        await atomicJSON(path.join(staging, 'result.json'), record);
        await fs.promises.rename(staging, root);
        return record;
      } finally { await fs.promises.rm(staging, { recursive: true, force: true }); }
    },
    manifest: async (job, baseURL) => {
      const { root, record } = await locate(job);
      const files = await regularTree(path.join(root, 'generated'));
      return { processingId: job.id, entryPath: job.entryPath, captureId: job.captureId,
        engine: job.engine, runBoltDetection: job.runBoltDetection,
        createdAt: record.completedAt,
        files: files.map((name) => ({ path: name, url: `${baseURL}/files?path=${encodeURIComponent(name)}` })) };
    },
    download: async (job, name, handler) => {
      name = relativePath(name);
      const { root } = await locate(job);
      const filename = await safePath(path.join(root, 'generated'), name);
      try {
        if (!(await fs.promises.stat(filename)).isFile()) fail('RESULT_FILE_NOT_FOUND', 404);
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail('RESULT_FILE_NOT_FOUND', 404);
        throw error;
      }
      return handler(filename);
    },
  };
}
