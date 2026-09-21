const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const basicAuth = require('express-basic-auth');
const crypto = require('crypto');
const sharp = require('sharp');
const Ajv = require('ajv');
const felsSchema = require('@vorstieg/fels-types/schemas/fels');
require('dotenv').config();

const ajv = new Ajv({ schemas: [felsSchema], strict: false });
const validateFels = ajv.getSchema('https://schemas.vorstieg.com/fels-data/fels.schema.json');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(cors({
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'MOVE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Destination', 'Accept']
}));
app.use(express.json({ limit: '50mb' }));

const authMiddleware = basicAuth({
    users: { [process.env.API_USER || 'admin']: process.env.API_PASSWORD || 'BenjaminIstToll' },
    challenge: true,
    unauthorizedResponse: 'Unauthorized'
});

// Compute a deterministic SHA-256 hash of all file contents in a folder
async function computeFolderHash(dir) {
    try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const hash = crypto.createHash('sha256');
        
        // Sort entries to ensure deterministic hash order
        entries.sort((a, b) => a.name.localeCompare(b.name));
        
        for (const entry of entries) {
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
async function generateMissingHashes() {
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
async function rebuildManifest() {
    try {
        console.log('[Felslager] Rebuilding manifest.json and fels-layer.json...');
        const manifest = [];
        const felsLayer = [];
        const scan = async (dir) => {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            
            for (let entry of entries) {
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

app.use('/api/fs', express.raw({ type: '*/*', limit: '500mb' }), async (req, res) => {
    // req.path contains the path relative to /api/fs
    const relativePath = req.path ? decodeURIComponent(req.path) : '/';
    // Normalize and prevent directory traversal
    const safeRelativePath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
    const targetPath = path.join(DATA_DIR, safeRelativePath);

    // Ensure they don't break out of the DATA_DIR directory
    if (!targetPath.startsWith(DATA_DIR)) {
        return res.status(403).send('Forbidden');
    }

    if (req.method === 'GET') {
        try {
            const stats = await fs.promises.stat(targetPath);
            if (stats.isDirectory()) {
                const getFiles = async (dir, baseRoute = '') => {
                    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                    let results = [];
                    for (let entry of entries) {
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
    } else if (req.method === 'PUT') {
        // Authenticate manually within this middleware flow
        authMiddleware(req, res, async () => {
            try {
                await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
                
                if (Buffer.isBuffer(req.body)) {
                    const ext = path.extname(targetPath).toLowerCase();
                    const isImage = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
                    
                    if (isImage) {
                        try {
                            const format = ext === '.png' ? 'png' : (ext === '.webp' ? 'webp' : 'jpeg');
                            const optimizedBuffer = await sharp(req.body)
                                .rotate()
                                .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
                                .toFormat(format, { quality: 80 })
                                .toBuffer();
                            await fs.promises.writeFile(targetPath, optimizedBuffer);
                        } catch (imgErr) {
                            console.error(`[Felslager] Failed to optimize image ${targetPath}:`, imgErr);
                            await fs.promises.writeFile(targetPath, req.body);
                        }
                    } else {
                        await fs.promises.writeFile(targetPath, req.body);
                    }
                } else if (typeof req.body === 'object' && Object.keys(req.body).length > 0) {
                    const ext = path.extname(targetPath).toLowerCase();
                    if (ext === '.json') {
                        const fileSlug = path.basename(targetPath, '.json');
                        const dirSlug = path.basename(path.dirname(targetPath));
                        
                        if (fileSlug === dirSlug) {
                            const valid = validateFels(req.body);
                            if (!valid) {
                                return res.status(400).json({ error: 'Invalid JSON schema', details: validateFels.errors });
                            }
                        }
                    }
                    await fs.promises.writeFile(targetPath, JSON.stringify(req.body, null, 2));
                } else {
                    return res.status(400).send('No content provided');
                }

                // Update hash.txt in the target directory with real folder hash
                const folderPath = path.dirname(targetPath);
                const hashPath = path.join(folderPath, 'hash.txt');
                const folderHash = await computeFolderHash(folderPath);
                await fs.promises.writeFile(hashPath, folderHash);
                
                // Rebuild manifest after a modification
                rebuildManifest().catch(console.error);
                
                // Perform automated 3D model compression if a .glb file was uploaded
                if (targetPath.toLowerCase().endsWith('.glb') && !targetPath.toLowerCase().endsWith('-low.glb')) {
                    console.log(`[Felslager] Generating low-res 3D model for: ${targetPath}`);
                    const { exec } = require('child_process');
                    const util = require('util');
                    const execPromise = util.promisify(exec);
                    
                    try {
                        const ext = path.extname(targetPath);
                        const base = path.basename(targetPath, ext);
                        const dir = path.dirname(targetPath);
                        const lowResPath = path.join(dir, `${base}-low${ext}`);
                        
                        await execPromise(`npx -y @gltf-transform/cli resize "${targetPath}" "${lowResPath}" --width 512 --height 512`);
                        await execPromise(`npx -y @gltf-transform/cli optimize "${lowResPath}" "${lowResPath}" --texture-compress webp`);
                        console.log(`[Felslager] Successfully generated low-res model: ${lowResPath}`);
                    } catch (optError) {
                        console.error('[Felslager] Failed to optimize GLB model:', optError);
                    }
                }
                
                return res.status(200).send('File saved successfully');
            } catch (e) {
                return res.status(500).send(e.toString());
            }
        });
    } else if (req.method === 'DELETE') {
        authMiddleware(req, res, async () => {
            try {
                const stats = await fs.promises.stat(targetPath);
                if (stats.isDirectory()) {
                    await fs.promises.rm(targetPath, { recursive: true, force: true });
                } else {
                    await fs.promises.unlink(targetPath);
                    // Update hash.txt after a file is deleted
                    const folderPath = path.dirname(targetPath);
                    const hashPath = path.join(folderPath, 'hash.txt');
                    const folderHash = await computeFolderHash(folderPath);
                    await fs.promises.writeFile(hashPath, folderHash);
                }
                
                // Rebuild manifest after a modification
                rebuildManifest().catch(console.error);
                
                return res.status(200).send('Deleted successfully');
            } catch (e) {
                return res.status(500).send(e.toString());
            }
        });
    } else if (req.method === 'MOVE') {
        authMiddleware(req, res, async () => {
            try {
                const destHeader = req.headers['destination'];
                if (!destHeader) return res.status(400).send('Destination header required');
                
                const destRelativePath = decodeURIComponent(destHeader);
                const safeDestPath = path.normalize(destRelativePath).replace(/^(\.\.(\/|\\|$))+/, '');
                const targetDestPath = path.join(DATA_DIR, safeDestPath);
                
                if (!targetDestPath.startsWith(DATA_DIR)) {
                    return res.status(403).send('Forbidden');
                }

                if (!fs.existsSync(targetPath)) {
                    return res.status(404).send('Not Found');
                }

                await fs.promises.mkdir(path.dirname(targetDestPath), { recursive: true });
                await fs.promises.rename(targetPath, targetDestPath);
                
                const oldFolder = path.dirname(targetPath);
                const newFolder = path.dirname(targetDestPath);
                
                if (fs.existsSync(oldFolder)) {
                    await fs.promises.writeFile(path.join(oldFolder, 'hash.txt'), await computeFolderHash(oldFolder));
                }
                if (oldFolder !== newFolder && fs.existsSync(newFolder)) {
                    await fs.promises.writeFile(path.join(newFolder, 'hash.txt'), await computeFolderHash(newFolder));
                }
                
                rebuildManifest().catch(console.error);
                return res.status(200).send('Moved successfully');
            } catch (e) {
                return res.status(500).send(e.toString());
            }
        });
    } else {
        return res.status(405).send('Method Not Allowed');
    }
});

app.listen(PORT, () => {
    console.log(`Felslager API running on port ${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
    
    // Generate missing hashes and rebuild manifest on startup
    generateMissingHashes().then(() => {
        return rebuildManifest();
    }).catch(console.error);
});
