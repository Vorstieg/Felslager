import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    buildDocuments,
    createSearchIndexer,
    entryDocId,
    filterValue,
    geometryCenter,
    gradeRank,
    routeGradeRank,
    routeDifficultyTier,
    loadSearchConfig
} from '../search.js';

const feature = (id, name, kind, extra = {}, coordinates = [16, 48]) => ({
    type: 'Feature',
    properties: { id, name, kind, ...extra },
    geometry: { type: 'Point', coordinates }
});

async function writeJson(dir, file, value) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, file), JSON.stringify(value));
}

/** area/ -> crag (with topo) -> sector (with multi-pitch topo) */
async function fixture(t) {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'felslager-search-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const area = path.join(dataDir, 'europe', 'area');
    const crag = path.join(area, 'crag');
    const sector = path.join(crag, 'sector');
    await writeJson(area, 'area.json', feature('area', 'Hohe Wand', 'area', { type: ['trad'], rock_type: 'Limestone' }));
    await writeJson(crag, 'crag.json', {
        type: 'Feature',
        properties: { id: 'crag', name: 'Bizepswandl', kind: 'crag', type: ['sports-climbing'], tags: ['Kalk'] },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] }
    });
    await writeJson(crag, 'crag-topo.json', {
        routes: [
            { id: 'r1', name: 'Gaisersteig', type: 'sports-climbing', grade: { scale: 'uiaa', value: '6', standardizedValue: '6a' }, length: 20 },
            { id: 'r2', name: 'Ungraded', type: 'sports-climbing', grade: null }
        ]
    });
    await writeJson(sector, 'sector.json', feature('sector', 'Obere Platte', 'sector'));
    await writeJson(sector, 'sector-topo.json', {
        coordinates: [15.5, 47.5, 900],
        routes: [
            {
                id: 'mp',
                name: 'Long Line',
                type: 'multi-pitch',
                pitches: [
                    { id: 'p1', pitchNumber: 1, length: 30, grade: { scale: 'uiaa', value: '5', standardizedValue: '5a' } },
                    { id: 'p2', pitchNumber: 2, length: 25, grade: { scale: 'uiaa', value: '7', standardizedValue: '6c' } }
                ]
            }
        ]
    });
    return { dataDir };
}

test('grade ranks follow the standardized order and ignore unknown grades', () => {
    assert.equal(gradeRank('1a'), 0);
    assert.ok(gradeRank('6a+') > gradeRank('6a'));
    assert.equal(gradeRank('fb 6a'), gradeRank('6a'));
    assert.equal(gradeRank('C/D'), -1);
    assert.equal(gradeRank(undefined), -1);

    // Discipline-aware route grade ranks
    assert.equal(routeGradeRank({ standardizedValue: 'C/D' }, 'via-ferrata'), 5);
    assert.equal(routeGradeRank({ standardizedValue: 'A' }, 'via-ferrata'), 0);
    assert.equal(routeGradeRank({ standardizedValue: 'AD' }, 'alpine-tour'), 6);
    assert.equal(routeGradeRank({ standardizedValue: 'PD' }, 'alpine-tour'), 3);
    assert.equal(routeGradeRank({ standardizedValue: '6A' }, 'bouldering'), 6);

    // Difficulty tiers (0..5)
    assert.equal(routeDifficultyTier({ standardizedValue: 'A' }, 'via-ferrata'), 0);
    assert.equal(routeDifficultyTier({ standardizedValue: 'C/D' }, 'via-ferrata'), 3);
    assert.equal(routeDifficultyTier({ standardizedValue: 'PD' }, 'alpine-tour'), 0);
    assert.equal(routeDifficultyTier({ standardizedValue: 'AD' }, 'alpine-tour'), 1);
    assert.equal(routeDifficultyTier({ standardizedValue: '6a' }, 'sports-climbing'), 2);
});

test('geometry centers use points and polygon outer rings without the closing vertex', () => {
    assert.deepEqual(geometryCenter({ type: 'Point', coordinates: [16, 48, 500] }), { lat: 48, lng: 16 });
    assert.deepEqual(
        geometryCenter({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] }),
        { lat: 1, lng: 1 }
    );
    assert.equal(geometryCenter(null), null);
});

test('search configuration is optional', () => {
    assert.equal(loadSearchConfig({}), null);
    assert.deepEqual(loadSearchConfig({ MEILI_URL: 'http://127.0.0.1:7700/', MEILI_MASTER_KEY: 'k' }), {
        url: 'http://127.0.0.1:7700',
        apiKey: 'k',
        index: 'fels'
    });
    assert.throws(() => loadSearchConfig({ MEILI_URL: 'ftp://x' }));
    assert.equal(filterValue('a"b\\c'), '"a\\"b\\\\c"');
});

test('documents index entries and routes with shared filter fields and aggregates', async (t) => {
    const { dataDir } = await fixture(t);
    const docs = await buildDocuments(dataDir);
    const byName = Object.fromEntries(docs.map((d) => [d.name, d]));
    assert.deepEqual(docs.map((d) => d.docType).sort(), ['entry', 'entry', 'entry', 'route', 'route', 'route']);

    const area = byName['Hohe Wand'];
    assert.equal(area.kind, 'area');
    assert.equal(area.path, 'europe/area');
    assert.deepEqual(area.ancestorPaths, ['europe'], 'plain folders count as ancestors');
    assert.equal(area.routeCount, 3);
    assert.deepEqual(area.types.sort(), ['multi-pitch', 'sports-climbing', 'trad']);
    assert.deepEqual(area.grades, [gradeRank('6a'), gradeRank('6c')]);
    assert.equal(area.gradeMin, gradeRank('6a'));
    assert.equal(area.gradeMax, gradeRank('6c'));

    const crag = byName.Bizepswandl;
    assert.deepEqual(crag._geo, { lat: 1, lng: 1 });
    assert.deepEqual(crag.breadcrumb, ['Hohe Wand']);
    assert.equal(crag.rockType, 'Limestone');
    assert.equal(crag.routeCount, 3);

    const route = byName.Gaisersteig;
    assert.equal(route.id.startsWith('route-'), true);
    assert.equal(route.routeId, 'r1');
    assert.equal(route.path, 'europe/area/crag');
    assert.deepEqual(route.ancestorPaths, ['europe', 'europe/area', 'europe/area/crag']);
    assert.deepEqual(route.breadcrumb, ['Hohe Wand', 'Bizepswandl']);
    assert.deepEqual(route.grades, [gradeRank('6a')]);
    assert.equal(route.length, 20);
    assert.equal(route.pitchCount, 1);
    assert.deepEqual(route._geo, { lat: 1, lng: 1 });

    assert.deepEqual(byName.Ungraded.grades, []);
    assert.equal('gradeMin' in byName.Ungraded, false);

    const multi = byName['Long Line'];
    assert.equal(multi.grade.standardizedValue, '6c', 'hardest pitch grades the route');
    assert.equal(multi.length, 55, 'pitch lengths are summed');
    assert.equal(multi.pitchCount, 2);
    assert.deepEqual(multi._geo, { lat: 47.5, lng: 15.5 }, 'topo coordinates win over entry centroid');
});

test('subtrees can be indexed in isolation with their ancestor context', async (t) => {
    const { dataDir } = await fixture(t);
    const docs = await buildDocuments(dataDir, 'europe/area/crag/sector');
    assert.deepEqual(docs.map((d) => d.name).sort(), ['Long Line', 'Obere Platte']);
    const sector = docs.find((d) => d.docType === 'entry');
    assert.equal(sector.id, entryDocId('europe/area/crag/sector'));
    assert.deepEqual(sector.breadcrumb, ['Hohe Wand', 'Bizepswandl']);
    assert.deepEqual(await buildDocuments(dataDir, 'europe/missing'), []);
});

test('a missing search configuration disables sync without failing', async () => {
    const indexer = createSearchIndexer({ searchConfig: null, dataDir: '/nonexistent' });
    assert.equal(indexer.enabled, false);
    await indexer.scheduleSync(['a']);
    await indexer.scheduleReindex();
    assert.equal(await indexer.reindexAll(), null);
});

test('an unreachable Meilisearch never throws from scheduled work', async (t) => {
    const { dataDir } = await fixture(t);
    const warnings = [];
    const indexer = createSearchIndexer({
        searchConfig: { url: 'http://127.0.0.1:9', apiKey: '', index: 'fels' },
        dataDir,
        logger: { log() {}, warn: (m) => warnings.push(m) },
        fetch: async () => {
            throw new Error('connect ECONNREFUSED');
        }
    });
    await indexer.scheduleReindex();
    await indexer.scheduleSync(['europe/area']);
    assert.equal(warnings.length, 2);
});

// Runs against a real Meilisearch when MEILI_TEST_URL is set, e.g.
// MEILI_TEST_URL=http://127.0.0.1:7700 MEILI_TEST_KEY=... npm test
test('full re-index, incremental sync and aggregate refresh against Meilisearch', { skip: !process.env.MEILI_TEST_URL }, async (t) => {
    const { dataDir } = await fixture(t);
    const searchConfig = {
        url: process.env.MEILI_TEST_URL,
        apiKey: process.env.MEILI_TEST_KEY || '',
        index: `fels_test_${process.pid}`
    };
    const indexer = createSearchIndexer({ searchConfig, dataDir, logger: { log() {}, warn: console.warn } });
    const headers = { 'Content-Type': 'application/json', ...(searchConfig.apiKey ? { Authorization: `Bearer ${searchConfig.apiKey}` } : {}) };
    const search = async (body) =>
        (await fetch(`${searchConfig.url}/indexes/${searchConfig.index}/search`, { method: 'POST', headers, body: JSON.stringify(body) })).json();
    t.after(() => fetch(`${searchConfig.url}/indexes/${searchConfig.index}`, { method: 'DELETE', headers }));

    assert.deepEqual(await indexer.reindexAll(), { entries: 3, routes: 3 });
    const typo = await search({ q: 'gaisersteg', filter: 'docType = "route"' });
    assert.equal(typo.hits[0]?.name, 'Gaisersteig');
    const ranged = await search({ q: '', filter: `docType = "entry" AND grades ${gradeRank('6b')} TO ${gradeRank('7a')}` });
    assert.deepEqual(ranged.hits.map((h) => h.name).sort(), ['Bizepswandl', 'Hohe Wand', 'Obere Platte']);

    // Edit a topo: replace routes in the sector, then sync just that folder.
    await writeJson(path.join(dataDir, 'europe/area/crag/sector'), 'sector-topo.json', {
        routes: [{ id: 'new', name: 'Neue Linie', type: 'bouldering', grade: { scale: 'font', value: '7a', standardizedValue: '7a' } }]
    });
    await indexer.scheduleSync(['europe/area/crag/sector']);
    assert.equal((await search({ q: 'Long Line', filter: 'docType = "route"' })).hits.length, 0);
    assert.equal((await search({ q: 'Neue Linie' })).hits[0]?.routeId, 'new');
    const area = (await search({ q: 'Hohe Wand', filter: 'docType = "entry"' })).hits[0];
    assert.ok(area.types.includes('bouldering'), 'ancestor aggregates are refreshed');
    assert.ok(area.scales.includes('font'));
    assert.ok(area.grades.includes(routeGradeRank({ standardizedValue: '7a' }, 'bouldering')));
    assert.equal(area.gradeMax, gradeRank('6a'));

    // Delete a folder: its entry and routes disappear.
    await rm(path.join(dataDir, 'europe/area/crag/sector'), { recursive: true });
    await indexer.scheduleSync(['europe/area/crag/sector']);
    assert.equal((await search({ q: 'Obere Platte' })).hits.length, 0);
    const crag = (await search({ q: 'Bizepswandl', filter: 'docType = "entry"' })).hits[0];
    assert.equal(crag.routeCount, 2);
});
