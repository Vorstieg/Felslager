/**
 * Topo Migration Script
 * 
 * This script migrates Fels and Topo JSON data to the unified schema architecture.
 * Actions performed:
 * 1. Strips out deprecated `crag_id`, `sector_id`, `editorMode`, `rock`, and `path` properties.
 * 2. Merges the standalone `altitude` into the 3rd slot of the `coordinates` array.
 * 3. Renames the `outlines` array to `lineOverlays`.
 * 4. Iterates through `lineOverlays` and deletes `lineStyle: "variant"` (fallback to default).
 * 5. Iterates through `routes` and renames `points`/`orientation` to `points3D`/`orientation3D`.
 * 6. Iterates through `pitches` and strips the redundant `type: "pitch"` discriminator.
 * 7. Iterates through `fixPoints` and renames `position` to `position3D`.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');

function walkDir(dir, callback) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            walkDir(fullPath, callback);
        } else if (fullPath.endsWith('.json')) {
            callback(fullPath);
        }
    }
}

let migratedCount = 0;

console.log(`Starting Topo migration in ${DATA_DIR}...`);

function migrateTopo(topo) {
    let modified = false;

    // 1. Remove obsolete properties
    if ('crag_id' in topo) { delete topo.crag_id; modified = true; }
    if ('sector_id' in topo) { delete topo.sector_id; modified = true; }
    if ('editorMode' in topo) { delete topo.editorMode; modified = true; }
    if ('rock' in topo) { delete topo.rock; modified = true; }

    // 2. Migrate altitude to coordinates[2]
    if (topo.altitude !== undefined) {
        if (!topo.coordinates) topo.coordinates = [0, 0];
        if (Array.isArray(topo.coordinates)) {
            while (topo.coordinates.length < 2) topo.coordinates.push(0);
            topo.coordinates[2] = topo.altitude;
            delete topo.altitude;
            modified = true;
        }
    }

    // 3. Rename outlines to lineOverlays and fix 'variant' lineStyle
    if (topo.outlines !== undefined) {
        topo.lineOverlays = topo.outlines;
        delete topo.outlines;
        modified = true;
    }
    if (Array.isArray(topo.lineOverlays)) {
        for (const overlay of topo.lineOverlays) {
            if (overlay.lineStyle === 'variant') {
                // Fallback to default styling since variant is now strictly for routes
                delete overlay.lineStyle; 
                modified = true;
            }
        }
    }

    // 4. Rename route 3D properties and clean up pitches
    if (Array.isArray(topo.routes)) {
        for (const route of topo.routes) {
            if (route.points !== undefined) {
                route.points3D = route.points;
                delete route.points;
                modified = true;
            }
            if (route.orientation !== undefined) {
                route.orientation3D = route.orientation;
                delete route.orientation;
                modified = true;
            }
            if (Array.isArray(route.pitches)) {
                for (const pitch of route.pitches) {
                    if (pitch.type === 'pitch') {
                        delete pitch.type;
                        modified = true;
                    }
                }
            }
        }
    }

    // 5. Rename fixPoint 3D properties
    if (Array.isArray(topo.fixPoints)) {
        for (const fp of topo.fixPoints) {
            if (fp.position !== undefined) {
                fp.position3D = fp.position;
                delete fp.position;
                modified = true;
            }
        }
    }

    return modified;
}

walkDir(DATA_DIR, (filePath) => {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content);
        let modified = false;

        // Check if it's a Fels
        if (data.properties) {
            if ('path' in data.properties) {
                delete data.properties.path;
                modified = true;
            }
            // Check if it contains a topo
            if (data.properties.topo) {
                if (migrateTopo(data.properties.topo)) {
                    modified = true;
                }
            }
        }
        
        // Check if the file is a TopoDocument directly (fallback)
        if (data.routes) {
            if (migrateTopo(data)) {
                modified = true;
            }
        }

        if (modified) {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
            console.log(`Migrated: ${filePath}`);
            migratedCount++;
        }
    } catch (err) {
        console.error(`Error processing ${filePath}:`, err.message);
    }
});

console.log(`Migration complete. Modified ${migratedCount} files.`);
