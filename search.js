/**
 * Meilisearch synchronisation for Felslager.
 *
 * The files on disk remain the single source of truth. Everything in the search
 * index is derived from them and may be dropped and rebuilt at any time
 * (`npm run search:reindex`).
 *
 * One unified index holds two document types so crags and routes can be found
 * by a single query:
 *
 *  - `docType: "entry"`: every catalog entry folder (`<slug>/<slug>.json`), any `kind`.
 *  - `docType: "route"`: every top-level route of an entry's topo document.
 *
 * Both document types share the filterable fields below, so one filter
 * expression works for crags and routes alike:
 *
 *  - `types`: climbing styles. Routes use `route.type`; entries combine their
 *    own `properties.type` with the types of all routes they contain.
 *  - `grades`: numeric grade ranks (index in GRADE_ORDER of `standardizedValue`).
 *    Routes hold a single rank; entries hold the distinct ranks of all contained
 *    routes, so `grades 24 TO 30` reads "has a route between 6a and 6c+".
 *  - `ancestorPaths`: every enclosing folder path (also plain folders such as
 *    `europe/austria`), used for "inside this area/region" filters.
 *  - `_geo`: entry centroid (routes inherit topo coordinates or their entry's centroid).
 *
 * Route-only: `length`, `pitchCount`, `boltAmount`. Entry-only: `routeCount`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Standardized (French) grade order. Kept identical to Felsverzeichnis `gradeOrder`. */
export const GRADE_ORDER = [
    '1a', '1b', '1c', '2a', '2b', '2c',
    '3a', '3a+', '3b', '3b+', '3c', '3c+',
    '4a', '4a+', '4b', '4b+', '4c', '4c+',
    '5a', '5a+', '5b', '5b+', '5c', '5c+',
    '6a', '6a+', '6b', '6b+', '6c', '6c+',
    '7a', '7a+', '7b', '7b+', '7c', '7c+',
    '8a', '8a+', '8b', '8b+', '8c', '8c+',
    '9a', '9a+', '9b', '9b+'
];

export const VIA_FERRATA_ORDER = [
    'A', 'A/B', 'B', 'B/C', 'C', 'C/D', 'D', 'D/E', 'E', 'E/F', 'F'
];

export const SAC_ORDER = [
    'F', 'F+', 'PD-', 'PD', 'PD+', 'AD-', 'AD', 'AD+', 'D-', 'D', 'D+', 'TD-', 'TD', 'TD+', 'ED-', 'ED', 'ED+', 'ABO'
];

export const FONT_ORDER = [
    '3', '3+', '4', '4+', '5', '5+',
    '6A', '6A+', '6B', '6B+', '6C', '6C+',
    '7A', '7A+', '7B', '7B+', '7C', '7C+',
    '8A', '8A+', '8B', '8B+', '8C', '8C+'
];

/**
 * Fixed uid of the read-only search key. Meilisearch derives the key value from
 * uid + master key, so the public key stays stable as long as the master key does.
 */
export const SEARCH_KEY_UID = '5e1f0c6a-4b7d-4f3e-9a51-fe15ea2c4001';

export const INDEX_SETTINGS = Object.freeze({
    searchableAttributes: ['name', 'breadcrumb', 'tags', 'description'],
    filterableAttributes: [
        'docType', 'kind', 'entryKind', 'types', 'grades', 'gradeMin', 'gradeMax',
        'difficultyTier', 'difficultyTiers', 'scale', 'scales',
        'length', 'pitchCount', 'boltAmount', 'routeCount', 'tags', 'rockType',
        'path', 'ancestorPaths', '_geo'
    ],
    sortableAttributes: ['name', 'gradeMin', 'gradeMax', 'difficultyTier', 'length', 'pitchCount', 'routeCount', '_geo'],
    faceting: { maxValuesPerFacet: 200 },
    pagination: { maxTotalHits: 2000 }
});

/** Reads optional Meilisearch settings. Returns `null` when search sync is disabled. */
export function loadSearchConfig(env = process.env) {
    if (!env.MEILI_URL) return null;
    const url = new URL(env.MEILI_URL);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('MEILI_URL must be an http(s) URL');
    return {
        url: url.href.replace(/\/$/, ''),
        apiKey: env.MEILI_MASTER_KEY || env.MEILI_ADMIN_KEY || '',
        index: env.MEILI_INDEX || 'fels'
    };
}

// ---------------------------------------------------------------------------
// Document building (pure, file-system only)
// ---------------------------------------------------------------------------

export function gradeRank(standardizedValue) {
    if (typeof standardizedValue !== 'string') return -1;
    return GRADE_ORDER.indexOf(standardizedValue.replace(/^fb\s*/i, '').trim().toLowerCase());
}

export function getDisciplineScale(routeType, grade) {
    const scale = (grade?.scale || '').toLowerCase();
    if (scale === 'via-ferrata' || routeType === 'via-ferrata') return 'via-ferrata';
    if (scale === 'sac' || routeType === 'alpine-tour') return 'sac';
    if (routeType === 'bouldering' || scale === 'font') return 'font';
    if (scale === 'uiaa') return 'uiaa';
    return 'french';
}

export function routeGradeRank(grade, routeType) {
    if (!grade) return -1;
    const std = (grade.standardizedValue || grade.value || '').trim();
    if (!std) return -1;
    const scale = getDisciplineScale(routeType, grade);

    if (scale === 'via-ferrata') {
        return VIA_FERRATA_ORDER.indexOf(std.toUpperCase());
    }
    if (scale === 'sac') {
        const idx = SAC_ORDER.indexOf(std.toUpperCase());
        if (idx >= 0) return idx;
    }
    if (scale === 'font') {
        const clean = std.replace(/^fb\s*/i, '').toUpperCase();
        return FONT_ORDER.indexOf(clean);
    }
    return GRADE_ORDER.indexOf(std.replace(/^fb\s*/i, '').toLowerCase());
}

export function routeDifficultyTier(grade, routeType) {
    if (!grade) return null;
    const std = (grade.standardizedValue || grade.value || '').trim();
    if (!std) return null;
    const scale = getDisciplineScale(routeType, grade);

    if (scale === 'via-ferrata') {
        const u = std.toUpperCase();
        if (u === 'A') return 0;
        if (u === 'A/B' || u === 'B') return 1;
        if (u === 'B/C' || u === 'C') return 2;
        if (u === 'C/D' || u === 'D') return 3;
        if (u === 'D/E' || u === 'E') return 4;
        if (u === 'E/F' || u === 'F') return 5;
    }
    if (scale === 'sac') {
        const u = std.toUpperCase();
        if (u.startsWith('F') || u.startsWith('PD')) return 0;
        if (u.startsWith('AD')) return 1;
        if (u.startsWith('D')) return 2;
        if (u.startsWith('TD')) return 3;
        if (u.startsWith('ED')) return 4;
        if (u === 'ABO') return 5;
    }
    if (scale === 'font') {
        const clean = std.replace(/^fb\s*/i, '').toUpperCase();
        if (['3', '3+', '4', '4+'].includes(clean)) return 0;
        if (['5', '5+'].includes(clean)) return 1;
        if (['6A', '6A+', '6B', '6B+'].includes(clean)) return 2;
        if (['6C', '6C+', '7A', '7A+'].includes(clean)) return 3;
        if (['7B', '7B+', '7C', '7C+', '8A'].includes(clean)) return 4;
        if (['8A+', '8B', '8B+', '8C', '8C+'].includes(clean)) return 5;
    }
    // UIAA roman numerals
    const u = std.toUpperCase();
    if (['I', 'II', 'III', 'IV-', 'IV'].includes(u)) return 0;
    if (['IV+', 'V-', 'V', 'V+'].includes(u)) return 1;
    if (['VI-', 'VI', 'VI+'].includes(u)) return 2;
    if (['VII-', 'VII', 'VII+'].includes(u)) return 3;
    if (['VIII-', 'VIII', 'VIII+'].includes(u)) return 4;
    if (['IX-', 'IX', 'IX+', 'X-', 'X', 'X+', 'XI-', 'XI', 'XI+'].includes(u)) return 5;

    // French rock grades
    const clean = std.toLowerCase();
    if (clean.startsWith('1') || clean.startsWith('2') || clean.startsWith('3') || clean.startsWith('4')) return 0;
    if (clean.startsWith('5')) return 1;
    if (clean.startsWith('6a') || clean.startsWith('6b') || clean === '6') return 2;
    if (clean.startsWith('6c') || clean.startsWith('7a')) return 3;
    if (clean.startsWith('7b') || clean.startsWith('7c') || clean.startsWith('8a')) return 4;
    if (clean.startsWith('8b') || clean.startsWith('8c') || clean.startsWith('9')) return 5;
    return null;
}

const hashId = (prefix, value) =>
    `${prefix}-${crypto.createHash('sha1').update(value).digest('hex')}`;
export const entryDocId = (entryPath) => hashId('entry', entryPath);
export const routeDocId = (entryPath, routeId) => hashId('route', `${entryPath}\n${routeId}`);

/** Mean of outer-ring vertices (or the point itself) as Meilisearch `_geo`. */
export function geometryCenter(geometry) {
    if (!geometry?.coordinates) return null;
    let ring;
    if (geometry.type === 'Point') ring = [geometry.coordinates];
    else if (geometry.type === 'Polygon') ring = geometry.coordinates[0];
    else if (geometry.type === 'MultiPolygon') ring = geometry.coordinates.flatMap((polygon) => polygon[0] ?? []);
    if (!Array.isArray(ring) || !ring.length) return null;
    if (ring.length > 1) {
        const [a, b] = [ring[0], ring.at(-1)];
        if (a[0] === b[0] && a[1] === b[1]) ring = ring.slice(0, -1);
    }
    const valid = ring.filter((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]));
    if (!valid.length) return null;
    const lng = valid.reduce((s, p) => s + p[0], 0) / valid.length;
    const lat = valid.reduce((s, p) => s + p[1], 0) / valid.length;
    return { lat, lng };
}

function routeGrade(route) {
    if (route.grade?.standardizedValue || route.grade?.value) return route.grade;
    // Multi-pitch routes may only grade their pitches: use the hardest one.
    let hardest = null;
    for (const pitch of route.pitches ?? [])
        if (routeGradeRank(pitch.grade, route.type) > routeGradeRank(hardest, route.type)) hardest = pitch.grade;
    return hardest;
}

function routeLength(route) {
    const own = Number(route.length);
    if (route.length !== undefined && route.length !== null && Number.isFinite(own)) return own;
    const lengths = (route.pitches ?? []).map((p) => Number(p.length)).filter((n) => Number.isFinite(n) && n > 0);
    return lengths.length ? lengths.reduce((a, b) => a + b, 0) : null;
}

/** All proper folder prefixes of a relative path: 'a/b/c' -> ['a', 'a/b']. */
export const folderPrefixes = (rel) =>
    rel.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));

const strings = (value) =>
    (Array.isArray(value) ? value : [value]).filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());

async function readJson(file) {
    try {
        return JSON.parse(await fs.promises.readFile(file, 'utf-8'));
    } catch {
        return null;
    }
}

/** Reads `<dir>/<slug>.json` if the folder is a catalog entry. */
export async function readEntry(absDir) {
    const slug = path.basename(absDir);
    const data = await readJson(path.join(absDir, `${slug}.json`));
    const properties = data?.properties;
    if (!properties || typeof properties.name !== 'string' || !properties.name.trim()) return null;
    return { slug, properties, geometry: data.geometry || properties.geometry || null };
}

async function readTopo(absDir, entry) {
    const file = await readJson(path.join(absDir, `${entry.slug}-topo.json`));
    if (Array.isArray(file?.routes)) return file;
    if (Array.isArray(entry.properties.topo?.routes)) return entry.properties.topo;
    return null;
}

/** Builds the indexable route documents of a single topo. */
function buildRouteDocs(topo, ctx) {
    const docs = [];
    const coords = Array.isArray(topo.coordinates) && topo.coordinates.length >= 2
        ? { lng: topo.coordinates[0], lat: topo.coordinates[1] }
        : null;
    for (const route of topo.routes) {
        if (!route || route.id === undefined || route.id === null) continue;
        const routeId = String(route.id);
        const name = typeof route.name === 'string' && route.name.trim() ? route.name.trim() : routeId;
        const grade = routeGrade(route);
        const rank = routeGradeRank(grade, route.type);
        const tier = routeDifficultyTier(grade, route.type);
        const scale = getDisciplineScale(route.type, grade);
        const length = routeLength(route);
        const doc = {
            id: routeDocId(ctx.path, routeId),
            docType: 'route',
            kind: 'route',
            routeId,
            name,
            path: ctx.path,
            entryId: ctx.slug,
            entryName: ctx.name,
            entryKind: ctx.kind,
            ancestorPaths: [...folderPrefixes(ctx.path), ctx.path],
            breadcrumb: [...ctx.breadcrumb, ctx.name],
            types: strings(route.type),
            scale,
            tags: strings(route.tags),
            description: strings(route.description),
            grades: rank >= 0 ? [rank] : [],
            pitchCount: Array.isArray(route.pitches) && route.pitches.length ? route.pitches.length : 1
        };
        if (tier !== null) doc.difficultyTier = tier;
        if (grade) {
            doc.grade = {
                scale: grade.scale || scale,
                value: grade.value || grade.standardizedValue,
                standardizedValue: grade.standardizedValue || grade.value
            };
        }
        if (rank >= 0) Object.assign(doc, { gradeMin: rank, gradeMax: rank });
        if (length !== null) doc.length = length;
        if (Number.isFinite(route.boltAmount)) doc.boltAmount = route.boltAmount;
        if (ctx.rockType) doc.rockType = ctx.rockType;
        const geo = coords || ctx.geo;
        if (geo) doc._geo = geo;
        docs.push(doc);
    }
    return docs;
}

/** Aggregated statistics of everything below an entry. */
const emptyStats = () => ({
    grades: new Set(),
    difficultyTiers: new Set(),
    types: new Set(),
    scales: new Set(),
    routeCount: 0
});
function mergeStats(target, source) {
    for (const g of source.grades) target.grades.add(g);
    for (const d of source.difficultyTiers) target.difficultyTiers.add(d);
    for (const t of source.types) target.types.add(t);
    for (const s of source.scales) target.scales.add(s);
    target.routeCount += source.routeCount;
}
function statsFields(stats, ownTypes = []) {
    const grades = [...stats.grades].sort((a, b) => a - b);
    const difficultyTiers = [...stats.difficultyTiers].sort((a, b) => a - b);
    const fields = {
        types: [...new Set([...strings(ownTypes), ...stats.types])],
        grades,
        difficultyTiers,
        scales: [...stats.scales],
        routeCount: stats.routeCount
    };
    if (grades.length) Object.assign(fields, { gradeMin: grades[0], gradeMax: grades.at(-1) });
    return fields;
}

/**
 * Reads the chain of entries from the data root down to (excluding) `relPath`.
 * Returns the ancestor context needed to index a subtree in isolation.
 */
export async function readAncestorContext(dataDir, relPath) {
    const parts = relPath.split('/').filter(Boolean);
    const ancestors = [];
    for (let i = 1; i < parts.length; i++) {
        const ancestorPath = parts.slice(0, i).join('/');
        const entry = await readEntry(path.join(dataDir, ancestorPath));
        if (entry) ancestors.push({ path: ancestorPath, entry });
    }
    return ancestors;
}

/**
 * Crawls a folder subtree and returns all entry and route documents.
 * @param {string} dataDir absolute data root
 * @param {string} relPath folder relative to dataDir ('' for everything)
 * @param {{path: string, entry: object}[]} [ancestors] entries above relPath
 */
export async function buildDocuments(dataDir, relPath = '', ancestors = null) {
    ancestors ??= await readAncestorContext(dataDir, relPath);
    const docs = [];
    const base = {
        breadcrumb: ancestors.map((a) => a.entry.properties.name),
        rockType: ancestors.map((a) => a.entry.properties.rock_type).filter(Boolean).at(-1)
    };

    async function crawl(rel, inherited) {
        const abs = path.join(dataDir, rel);
        let dirents;
        try {
            dirents = await fs.promises.readdir(abs, { withFileTypes: true });
        } catch {
            return emptyStats();
        }
        const entry = rel ? await readEntry(abs) : null;
        const stats = emptyStats();
        let childContext = inherited;
        let entryDoc = null;
        if (entry) {
            const p = entry.properties;
            const ctx = {
                path: rel,
                slug: entry.slug,
                name: p.name.trim(),
                kind: p.kind,
                breadcrumb: inherited.breadcrumb,
                rockType: p.rock_type || inherited.rockType,
                geo: geometryCenter(entry.geometry)
            };
            const topo = await readTopo(abs, entry);
            if (topo) {
                const routeDocs = buildRouteDocs(topo, ctx);
                for (const r of routeDocs) {
                    r.grades.forEach((g) => stats.grades.add(g));
                    r.types.forEach((t) => stats.types.add(t));
                    if (r.difficultyTier !== undefined) stats.difficultyTiers.add(r.difficultyTier);
                    if (r.scale) stats.scales.add(r.scale);
                }
                stats.routeCount += routeDocs.length;
                docs.push(...routeDocs);
            }
            entryDoc = {
                id: entryDocId(rel),
                docType: 'entry',
                kind: p.kind || 'crag',
                entryId: entry.slug,
                name: ctx.name,
                path: rel,
                ancestorPaths: folderPrefixes(rel),
                breadcrumb: inherited.breadcrumb,
                tags: strings(p.tags),
                description: strings([p.description_de, p.description_en]),
                ...(ctx.rockType ? { rockType: ctx.rockType } : {}),
                ...(ctx.geo ? { _geo: ctx.geo } : {}),
                ...(p.updated ? { updated: p.updated } : {})
            };
            docs.push(entryDoc);
            childContext = {
                breadcrumb: [...inherited.breadcrumb, ctx.name],
                rockType: ctx.rockType
            };
        }
        for (const d of dirents) {
            if (!d.isDirectory() || d.isSymbolicLink() || d.name.startsWith('.')) continue;
            mergeStats(stats, await crawl(rel ? `${rel}/${d.name}` : d.name, childContext));
        }
        if (entryDoc) Object.assign(entryDoc, statsFields(stats, entry.properties.type));
        return stats;
    }

    await crawl(relPath, base);
    return docs;
}

// ---------------------------------------------------------------------------
// Meilisearch REST client (no SDK dependency)
// ---------------------------------------------------------------------------

export class MeiliError extends Error {
    constructor(status, body) {
        super(body?.message || `Meilisearch request failed with ${status}`);
        this.status = status;
        this.code = body?.code;
    }
}

export function createMeiliClient({ url, apiKey }, fetcher = globalThis.fetch) {
    async function request(method, route, body) {
        const res = await fetcher(url + route, {
            method,
            headers: {
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(30_000)
        });
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        if (!res.ok) throw new MeiliError(res.status, json);
        return json;
    }
    async function waitForTask(task, timeoutMs = 120_000) {
        const uid = task?.taskUid ?? task?.uid;
        const deadline = Date.now() + timeoutMs;
        for (let delay = 25; ; delay = Math.min(delay * 2, 500)) {
            const current = await request('GET', `/tasks/${uid}`);
            if (current.status === 'succeeded') return current;
            if (current.status === 'failed' || current.status === 'canceled')
                throw new MeiliError(500, current.error ?? { message: `Task ${uid} ${current.status}` });
            if (Date.now() > deadline) throw new Error(`Timed out waiting for Meilisearch task ${uid}`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    const run = async (method, route, body) => waitForTask(await request(method, route, body));
    return { request, waitForTask, run };
}

/** Quotes a value for a Meilisearch filter expression. */
export const filterValue = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// ---------------------------------------------------------------------------
// Indexer
// ---------------------------------------------------------------------------

const BATCH_SIZE = 1000;

/**
 * Creates the search indexer. With `searchConfig === null` every method is a
 * no-op so Felslager keeps working without Meilisearch.
 */
export function createSearchIndexer({ searchConfig, dataDir, logger = console, fetch: fetcher }) {
    let queue = Promise.resolve();
    const enqueue = (label, op) => {
        const next = queue.then(op).catch((e) => {
            logger.warn(`[Felslager] Search ${label} failed: ${e.message}`);
        });
        queue = next;
        return next;
    };
    if (!searchConfig) {
        return {
            enabled: false,
            reindexAll: async () => null,
            scheduleReindex: () => Promise.resolve(),
            scheduleSync: () => Promise.resolve(),
            ensureSearchKey: async () => null,
            idle: () => Promise.resolve()
        };
    }
    const client = createMeiliClient(searchConfig, fetcher);
    const index = searchConfig.index;

    async function addDocuments(uid, docs) {
        for (let i = 0; i < docs.length; i += BATCH_SIZE)
            await client.run('POST', `/indexes/${uid}/documents?primaryKey=id`, docs.slice(i, i + BATCH_SIZE));
    }

    async function indexExists(uid) {
        try {
            await client.request('GET', `/indexes/${uid}`);
            return true;
        } catch (e) {
            if (e.status === 404) return false;
            throw e;
        }
    }

    async function ensureIndex(uid) {
        if (!(await indexExists(uid))) await client.run('POST', '/indexes', { uid, primaryKey: 'id' });
    }

    /** Rebuilds everything into a temporary index and swaps it in atomically. */
    async function reindexAll() {
        const started = Date.now();
        const docs = await buildDocuments(dataDir, '', []);
        const tmp = `${index}_rebuild`;
        if (await indexExists(tmp)) await client.run('DELETE', `/indexes/${tmp}`);
        await client.run('POST', '/indexes', { uid: tmp, primaryKey: 'id' });
        await client.run('PATCH', `/indexes/${tmp}/settings`, INDEX_SETTINGS);
        await addDocuments(tmp, docs);
        await ensureIndex(index);
        await client.run('POST', '/swap-indexes', [{ indexes: [index, tmp] }]);
        await client.run('DELETE', `/indexes/${tmp}`);
        const counts = {
            entries: docs.filter((d) => d.docType === 'entry').length,
            routes: docs.filter((d) => d.docType === 'route').length
        };
        logger.log(
            `[Felslager] Search index "${index}" rebuilt: ${counts.entries} entries, ${counts.routes} routes (${Date.now() - started} ms).`
        );
        return counts;
    }

    /** Recomputes aggregate fields of an ancestor entry from the routes already indexed below it. */
    async function refreshAggregates(ancestor) {
        const result = await client.request('POST', `/indexes/${index}/search`, {
            q: '',
            limit: 0,
            filter: `ancestorPaths = ${filterValue(ancestor.path)} AND docType = "route"`,
            facets: ['grades', 'types', 'difficultyTier', 'scale']
        });
        const dist = result.facetDistribution ?? {};
        const stats = {
            grades: new Set(Object.keys(dist.grades ?? {}).map(Number)),
            difficultyTiers: new Set(Object.keys(dist.difficultyTier ?? {}).map(Number)),
            types: new Set(Object.keys(dist.types ?? {})),
            scales: new Set(Object.keys(dist.scale ?? {})),
            routeCount: result.estimatedTotalHits ?? result.totalHits ?? 0
        };
        const fields = statsFields(stats, ancestor.entry.properties.type);
        if (!fields.grades.length) Object.assign(fields, { gradeMin: null, gradeMax: null });
        await client.run('PUT', `/indexes/${index}/documents?primaryKey=id`, [
            { id: entryDocId(ancestor.path), ...fields }
        ]);
    }

    /** Re-indexes the folder subtrees that contain the given changed folders. */
    async function syncDirs(relDirs) {
        if (!(await indexExists(index))) return reindexAll();
        const normalized = [...new Set(relDirs.map((d) => d.split(path.sep).join('/').replace(/^\/+|\/+$/g, '')))];
        // Changing the data root itself requires a full rebuild.
        if (normalized.some((d) => !d)) return reindexAll();
        // Drop scopes already covered by an enclosing scope.
        const scopes = normalized.filter((d) => !normalized.some((o) => o !== d && d.startsWith(o + '/')));
        const ancestorsToRefresh = new Map();
        for (const scope of scopes) {
            const ancestors = await readAncestorContext(dataDir, scope);
            await client.run('POST', `/indexes/${index}/documents/delete`, {
                filter: `path = ${filterValue(scope)} OR ancestorPaths = ${filterValue(scope)}`
            });
            const docs = await buildDocuments(dataDir, scope, ancestors);
            await addDocuments(index, docs);
            for (const ancestor of ancestors) ancestorsToRefresh.set(ancestor.path, ancestor);
        }
        // Deepest first is not required (facets read routes), but keeps logs readable.
        for (const ancestor of [...ancestorsToRefresh.values()].reverse()) await refreshAggregates(ancestor);
        logger.log(`[Felslager] Search index synced: ${scopes.join(', ')}`);
    }

    /** Ensures a read-only key restricted to searching this index and returns its value. */
    async function ensureSearchKey() {
        const body = {
            uid: SEARCH_KEY_UID,
            name: `felsverzeichnis-search-${index}`,
            description: 'Read-only search key for Felsverzeichnis (public).',
            actions: ['search'],
            indexes: [index],
            expiresAt: null
        };
        try {
            return (await client.request('GET', `/keys/${SEARCH_KEY_UID}`)).key;
        } catch (e) {
            if (e.status !== 404) throw e;
            return (await client.request('POST', '/keys', body)).key;
        }
    }

    return {
        enabled: true,
        reindexAll,
        ensureSearchKey,
        scheduleReindex: () => enqueue('reindex', reindexAll),
        scheduleSync: (relDirs) => (relDirs.length ? enqueue('sync', () => syncDirs(relDirs)) : Promise.resolve()),
        idle: () => queue
    };
}
