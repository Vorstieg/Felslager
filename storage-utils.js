// Shared filesystem helpers for private captures and processing results.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const fail = (code, status = 400) => { throw Object.assign(new Error(code), { status }); };
export const within = (parent, child) => child === parent || child.startsWith(parent + '/');
export function relativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1000 || /[\\\x00-\x1f\x7f]/.test(value) ||
      value.split('/').some((part) => !part || part.startsWith('.') || part.length > 200)) fail('INVALID_PATH');
  return value;
}
export function privateRoot(config, setting, fallback) {
  const root = path.resolve(config[setting] || path.join(path.dirname(config.databasePath), fallback));
  const protectedPaths = [config.dataDir, fileURLToPath(new URL('.', import.meta.url)), config.databasePath,
    config.reviewDir || path.join(path.dirname(config.databasePath), 'reviews'),
    ...(setting === 'processingDir' ? [config.captureDir || path.join(path.dirname(config.databasePath), 'captures')] :
      [config.processingDir || path.join(path.dirname(config.databasePath), 'processing')])];
  const check = (candidate) => {
    for (const p of protectedPaths) {
      const resolved = fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p);
      if (within(resolved, candidate) || within(candidate, resolved)) throw new Error('Private storage must not overlap content, checkout, auth, reviews, processing or other private storage');
    }
  };
  check(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const resolved = fs.realpathSync(root); check(resolved); return resolved;
}
export async function safePath(root, relative) {
  relativePath(relative);
  let current = root;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    try {
      if ((await fs.promises.lstat(current)).isSymbolicLink()) fail('SYMLINK_FORBIDDEN', 403);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return current;
}
export async function atomicJSON(filename, document) {
  const temporary = path.join(path.dirname(filename), `.${crypto.randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(document), { mode: 0o600, flag: 'wx' });
    await fs.promises.rename(temporary, filename);
  } finally { await fs.promises.rm(temporary, { force: true }); }
}
export async function regularTree(directory) {
  if (!(await fs.promises.lstat(directory)).isDirectory()) fail('INVALID_ARTIFACT', 422);
  const files = [];
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    relativePath(entry.name);
    if (entry.isDirectory()) files.push(...(await regularTree(path.join(directory, entry.name))).map((p) => `${entry.name}/${p}`));
    else if (entry.isFile()) files.push(entry.name);
    else fail('INVALID_ARTIFACT', 422);
  }
  return files.sort();
}
