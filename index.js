import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { Ajv } from 'ajv';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { createAuth } from './auth.js';
import { loadConfig } from './config.js';
import { createReviewRouter } from './reviews.js';
import { createSearchIndexer } from './search.js';
import 'dotenv/config';

const require = createRequire(import.meta.url);
const felsSchema = require('@vorstieg/fels-types/schemas/fels');
const ajv = new Ajv({ schemas: [felsSchema], strict: false });
const validateFels = ajv.getSchema('https://schemas.vorstieg.com/fels-data/fels.schema.json');
const run = promisify(execFile);

// Compute a deterministic SHA-256 hash of all file contents in a folder
async function computeFolderHash(dir) {
    try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const hash = crypto.createHash('sha256');
        
        // Sort entries to ensure deterministic hash order
        entries.sort((a, b) => a.name.localeCompare(b.name));
        
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            if (entry.name === 'hash.txt' || entry.name === 'manifest.json') continue;
            
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const subHash = await computeFolderHash(fullPath);
                hash.update(subHash);
            } else {
                const fileBuffer = await fs.promises.readFile(fullPath);
                hash.update(entry.name);
                hash.update(fileBuffer);
            }
        }
        return hash.digest('hex');
    } catch (e) {
        console.error(`[Felslager] Error hashing folder ${dir}:`, e);
        return Date.now().toString(); // fallback
    }
}

// Generate missing hash.txt files across all existing folders
async function generateMissingHashes(DATA_DIR) {
    console.log('[Felslager] Checking for missing folder hashes...');
    let generated = 0;
    const scan = async (dir) => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        
        // If this directory has files (not just subdirs), it should have a hash.txt
        const hasFiles = entries.some(e => e.isFile() && e.name !== 'hash.txt' && e.name !== 'manifest.json');
        const hasHashTxt = entries.some(e => e.name === 'hash.txt');
        
        if (hasFiles && !hasHashTxt) {
            console.log(`[Felslager] Generating missing hash.txt for ${dir}`);
            const folderHash = await computeFolderHash(dir);
            await fs.promises.writeFile(path.join(dir, 'hash.txt'), folderHash);
            generated++;
        }
        
        // Recurse into subdirectories
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                await scan(path.join(dir, entry.name));
            }
        }
    };
    
    await scan(DATA_DIR);
    if (generated > 0) {
        console.log(`[Felslager] Generated ${generated} missing hashes.`);
    } else {
        console.log('[Felslager] All folders already have hashes.');
    }
}

// Function to rebuild the global manifest.json
async function rebuildManifest(DATA_DIR) {
    try {
        console.log('[Felslager] Rebuilding manifest.json and fels-layer.json...');
        const manifest = [];
        const felsLayer = [];
        const scan = async (dir) => {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            
            for (let entry of entries) {
                if (entry.isSymbolicLink()) continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await scan(fullPath);
                } else if (entry.name.endsWith('.json') && entry.name !== 'manifest.json') {
                    const fileSlug = entry.name.replace('.json', '');
                    const dirSlug = path.basename(dir);
                    
                    if (fileSlug === dirSlug) {
                        try {
                            const content = await fs.promises.readFile(fullPath, 'utf-8');
                            const data = JSON.parse(content);
                            const name = data.properties?.name || data.name;
                            const geometry = data.geometry || data.properties?.geometry;
                            
                            if (name && geometry) {
                                const relativePath = path.relative(DATA_DIR, dir).replace(/\\/g, '/');
                                const fileHashPath = path.join(dir, 'hash.txt');
                                let hash = null;
                                if (fs.existsSync(fileHashPath)) {
                                    hash = await fs.promises.readFile(fileHashPath, 'utf-8');
                                }
                                
                                const isPolygon = geometry.type === 'Polygon' || geometry.type === 'MultiPolygon';

                                manifest.push({
                                    id: fileSlug,
                                    name,
                                    path: relativePath,
                                    geometry,
                                    type: data.properties?.type || data.type,
                                    hash: hash ? hash.trim() : null
                                });
                                
                                felsLayer.push({
                                    type: "Feature",
                                    geometry: geometry,
                                    properties: {
                                        id: fileSlug,
                                        name: name,
                                        path: relativePath,
                                        kind: data.properties?.kind,
                                        type: data.properties?.type || data.type || [],
                                        hash: hash ? hash.trim() : null,
                                        minzoom: isPolygon ? 16 : 0
                                    }
                                });
                            }
                        } catch (e) {
                            console.error(`[Felslager] Error parsing JSON for manifest: ${fullPath}`, e.message);
                        }
                    }
                }
            }
        };
        await scan(DATA_DIR);
        await fs.promises.writeFile(path.join(DATA_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
        await fs.promises.writeFile(path.join(DATA_DIR, 'fels-layer.json'), JSON.stringify({
            type: "FeatureCollection",
            features: felsLayer
        }, null, 2));
        console.log(`[Felslager] Rebuilt manifest.json and fels-layer.json with ${manifest.length} entries.`);
    } catch (e) {
        console.error('[Felslager] Error rebuilding manifest:', e);
    }
}

export function createApp(config, { optimizeGlb, searchFetch } = {}) {
    const service = createAuth(config);
    const { auth } = service;
    const searchIndexer = createSearchIndexer({
        searchConfig: config.search ?? null,
        dataDir: fs.realpathSync(config.dataDir),
        fetch: searchFetch
    });
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy || false);
    app.use((req, res, next) => {
        const publicRead = req.path.startsWith('/api/fs') && ['GET', 'HEAD'].includes(req.method);
        const origin = req.headers.origin;
        res.vary('Origin');
        if (publicRead) res.setHeader('Access-Control-Allow-Origin', '*');
        else if (config.trustedOrigins.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
        if (req.method === 'OPTIONS') {
            if (!config.trustedOrigins.includes(origin))
                return res.status(403).json({ code: 'ORIGIN_NOT_ALLOWED' });
            res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,DELETE,MOVE,POST');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Destination,Accept');
            return res.sendStatus(204);
        }
        if (!['GET', 'HEAD'].includes(req.method) && !config.trustedOrigins.includes(origin))
            return res.status(403).json({ code: 'ORIGIN_NOT_ALLOWED' });
        next();
    });
    const authMethods = {
        '/sign-in/email': 'POST',
        '/sign-out': 'POST',
        '/get-session': 'GET'
    };
    app.use('/api/auth', (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        if (authMethods[req.path] !== req.method) return res.sendStatus(404);
        next();
    });
    app.all('/api/auth/{*path}', toNodeHandler(auth));
    app.use('/api/reviews', createReviewRouter(config, auth));
    const DATA_DIR = fs.realpathSync(config.dataDir);
    const contained = (p) => p === DATA_DIR || p.startsWith(DATA_DIR + path.sep);
    async function safe(raw, forbidRoot = false) {
        let decoded;
        try {
            decoded = decodeURIComponent(raw);
        } catch {
            throw Object.assign(new Error('INVALID_PATH'), { status: 400 });
        }
        if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..'))
            throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
        const target = path.resolve(DATA_DIR, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
        if (!contained(target) || (forbidRoot && target === DATA_DIR))
            throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
        let current = DATA_DIR;
        for (const part of path.relative(DATA_DIR, target).split(path.sep).filter(Boolean)) {
            current = path.join(current, part);
            try {
                const stat = await fs.promises.lstat(current);
                if (stat.isSymbolicLink()) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
            } catch (e) {
                if (e.code === 'ENOENT') break;
                throw e;
            }
        }
        return target;
    }
    app.use('/api/fs', async (req, res, next) => {
        // Files are user-controlled and share an origin with authentication.
        // Sandbox document navigation as well as preventing MIME sniffing.
        res.setHeader(
            'Content-Security-Policy',
            "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'"
        );
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (['GET', 'HEAD'].includes(req.method)) return next();
        if (!['PUT', 'DELETE', 'MOVE'].includes(req.method))
            return res.status(405).json({ code: 'METHOD_NOT_ALLOWED' });
        const session = await auth.api.getSession({
            headers: fromNodeHeaders(req.headers),
            returnHeaders: true
        });
        for (const cookie of session.headers.getSetCookie()) res.append('Set-Cookie', cookie);
        if (!session.response) return res.status(401).json({ code: 'AUTH_REQUIRED' });
        next();
    });
    app.use('/api/fs', async (req, res, next) => {
        try {
            req.target = await safe(req.path, !['GET', 'HEAD'].includes(req.method));
            if (req.method === 'MOVE') {
                if (typeof req.headers.destination !== 'string' || !req.headers.destination)
                    return res.status(400).json({ code: 'DESTINATION_REQUIRED' });
                req.destination = await safe(req.headers.destination, true);
            }
            next();
        } catch (e) {
            res.status(e.status || 403).json({ code: e.message });
        }
    });
    app.use('/api/fs', express.raw({ type: '*/*', limit: '500mb' }), async (req, res) => {
        const targetPath = req.target;
        if (['GET', 'HEAD'].includes(req.method)) {
            try {
                const stats = await fs.promises.stat(targetPath);
                if (stats.isDirectory()) {
                    const getFiles = async (dir, baseRoute = '') => {
                        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                        let results = [];
                        for (let entry of entries) {
                            if (entry.isSymbolicLink()) continue;
                            const relativeEntryPath = path.join(baseRoute, entry.name).replace(/\\/g, '/');
                            if (entry.isDirectory()) {
                                results.push({ name: entry.name, path: relativeEntryPath, type: 'dir' });
                                if (req.query.recursive === 'true') {
                                    results.push(...await getFiles(path.join(dir, entry.name), relativeEntryPath));
                                }
                            } else {
                                results.push({ name: entry.name, path: relativeEntryPath, type: 'file' });
                            }
                        }
                        return results;
                    };
                    const result = await getFiles(targetPath);
                    return res.json(result);
                } else {
                    // Serve the file
                    if (targetPath.toLowerCase().endsWith('.glb')) {
                        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                    }
                    return res.sendFile(targetPath);
                }
            } catch (e) {
                return res.status(404).send('Not Found');
            }
        }
        try {
            const searchDirs = [];
            const isJson = (p) => path.extname(p).toLowerCase() === '.json';
            if (req.method === 'PUT') {
                if (!Buffer.isBuffer(req.body) || !req.body.length) {
                    return res.status(400).json({ code: 'NO_CONTENT' });
                }
                const ext = path.extname(targetPath).toLowerCase();
                let content = req.body;
                if (ext === '.json') {
                    let json;
                    try {
                        json = JSON.parse(content.toString());
                    } catch {
                        return res.status(400).json({ code: 'INVALID_JSON' });
                    }
                    if (
                        path.basename(targetPath, '.json') === path.basename(path.dirname(targetPath)) &&
                        !validateFels(json)
                    ) {
                        return res.status(400).json({
                            error: 'Invalid JSON schema',
                            code: 'INVALID_SCHEMA',
                            details: validateFels.errors
                        });
                    }
                    content = JSON.stringify(json, null, 2);
                }
                await fs.promises.mkdir(path.dirname(targetPath), {
                    recursive: true
                });
                if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
                    try {
                        content = await sharp(content)
                            .rotate()
                            .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
                            .toFormat(ext === '.png' ? 'png' : ext === '.webp' ? 'webp' : 'jpeg', {
                                quality: 80
                            })
                            .toBuffer();
                    } catch {
                        /* Preserve original image upload behavior. */
                    }
                }
                await fs.promises.writeFile(targetPath, content);
                if (ext === '.glb' && !targetPath.toLowerCase().endsWith('-low.glb')) {
                    try {
                        if (optimizeGlb) await optimizeGlb(targetPath);
                        else {
                            const low = targetPath.slice(0, -4) + '-low.glb',
                                cli = fileURLToPath(
                                    new URL('./node_modules/.bin/gltf-transform', import.meta.url)
                                );
                            await run(cli, ['resize', targetPath, low, '--width', '512', '--height', '512']);
                            await run(cli, ['optimize', low, low, '--texture-compress', 'webp']);
                        }
                    } catch {
                        /* The original remains valid if compression fails. */
                    }
                }
                await fs.promises.writeFile(
                    path.join(path.dirname(targetPath), 'hash.txt'),
                    await computeFolderHash(path.dirname(targetPath))
                );
                if (ext === '.json') searchDirs.push(path.dirname(targetPath));
            } else if (req.method === 'DELETE') {
                const stat = await fs.promises.stat(targetPath);
                await fs.promises.rm(targetPath, { recursive: stat.isDirectory() });
                if (!stat.isDirectory())
                    await fs.promises.writeFile(
                        path.join(path.dirname(targetPath), 'hash.txt'),
                        await computeFolderHash(path.dirname(targetPath))
                    );
                if (stat.isDirectory()) searchDirs.push(targetPath);
                else if (isJson(targetPath)) searchDirs.push(path.dirname(targetPath));
            } else if (req.method === 'MOVE') {
                const isDirectory = (await fs.promises.stat(targetPath)).isDirectory();
                await fs.promises.mkdir(path.dirname(req.destination), {
                    recursive: true
                });
                await fs.promises.rename(targetPath, req.destination);
                for (const folder of new Set([path.dirname(targetPath), path.dirname(req.destination)]))
                    if (fs.existsSync(folder))
                        await fs.promises.writeFile(
                            path.join(folder, 'hash.txt'),
                            await computeFolderHash(folder)
                        );
                if (isDirectory) searchDirs.push(targetPath, req.destination);
                else if (isJson(targetPath) || isJson(req.destination))
                    searchDirs.push(path.dirname(targetPath), path.dirname(req.destination));
            }
            await rebuildManifest(DATA_DIR);
            void searchIndexer.scheduleSync(searchDirs.map((dir) => path.relative(DATA_DIR, dir)));
            res.status(200).send(
                req.method === 'PUT'
                    ? 'File saved successfully'
                    : req.method === 'DELETE'
                      ? 'Deleted successfully'
                      : 'Moved successfully'
            );
        } catch (e) {
            res.status(e.code === 'ENOENT' ? 404 : 500).json({
                code: e.code === 'ENOENT' ? 'NOT_FOUND' : 'OPERATION_FAILED'
            });
        }
    });
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        res.status(error.status || 500).json({
            code: error.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR'
        });
    });
    return {
        ...service,
        app,
        search: searchIndexer,
        initialize: async () => {
            await generateMissingHashes(DATA_DIR);
            await rebuildManifest(DATA_DIR);
            void searchIndexer.scheduleReindex();
        }
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const config = loadConfig();
    const service = createApp(config);
    await service.initialize();
    if (service.search.enabled)
        service.search
            .ensureSearchKey()
            .then((key) => console.log(`[Felslager] Public Meilisearch search key: ${key}`))
            .catch((e) => console.warn(`[Felslager] Could not ensure Meilisearch search key: ${e.message}`));
    else console.log('[Felslager] MEILI_URL not set: search sync disabled.');
    const server = service.app.listen(config.port, () =>
        console.log(`Felslager listening on ${config.port}`)
    );
    for (const signal of ['SIGINT', 'SIGTERM'])
        process.on(signal, () =>
            server.close(() => {
                service.close();
                process.exit(0);
            })
        );
}
