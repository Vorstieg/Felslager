const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const crypto = require('crypto');

const DATA_DIR = '/home/vorstieg/fels-data';

async function processDirectory(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    let modified = false;

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
            const childModified = await processDirectory(fullPath);
            if (childModified) modified = true;
        } else {
            const ext = path.extname(entry.name).toLowerCase();
            const isImage = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
            
            if (isImage) {
                try {
                    const metadata = await sharp(fullPath).metadata();
                    // Only resize if it's larger than 1920 in either dimension
                    if (metadata.width > 1920 || metadata.height > 1920) {
                        console.log(`Resizing: ${fullPath} (${metadata.width}x${metadata.height})`);
                        
                        const format = ext === '.png' ? 'png' : (ext === '.webp' ? 'webp' : 'jpeg');
                        const tempPath = fullPath + '.tmp';
                        
                        await sharp(fullPath)
                            .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
                            .toFormat(format, { quality: 80 })
                            .toFile(tempPath);
                            
                        await fs.promises.rename(tempPath, fullPath);
                        modified = true;
                    }
                } catch (e) {
                    console.error(`Failed to process ${fullPath}:`, e.message);
                }
            }
        }
    }
    
    return modified;
}

async function computeFolderHash(dir) {
    try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const hash = crypto.createHash('sha256');
        
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
        return Date.now().toString();
    }
}

async function updateHashes(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    let hasFiles = false;
    
    for (const entry of entries) {
        if (entry.isDirectory()) {
            await updateHashes(path.join(dir, entry.name));
        } else if (entry.name !== 'hash.txt' && entry.name !== 'manifest.json') {
            hasFiles = true;
        }
    }
    
    if (hasFiles) {
        const folderHash = await computeFolderHash(dir);
        await fs.promises.writeFile(path.join(dir, 'hash.txt'), folderHash);
    }
}

async function main() {
    console.log('Starting image optimization pass...');
    const modified = await processDirectory(DATA_DIR);
    
    if (modified) {
        console.log('Images were modified. Updating folder hashes...');
        await updateHashes(DATA_DIR);
        console.log('Done! Please restart the backend server so it can rebuild the manifest if needed.');
    } else {
        console.log('No images needed resizing.');
    }
}

main().catch(console.error);
