/**
 * Full search re-index from disk.
 *
 * Rebuilds the Meilisearch index from the JSON/topo files in DATA_DIR into a
 * temporary index and swaps it in atomically, then prints the public read-only
 * search key for Felsverzeichnis (PUBLIC_MEILI_SEARCH_KEY).
 *
 * Usage: npm run search:reindex
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
try {
    await import('dotenv/config');
} catch {
    // Optional in container environments where env vars are already set
}
import { createSearchIndexer, loadSearchConfig } from '../search.js';

const searchConfig = loadSearchConfig(process.env);
if (!searchConfig) {
    console.error('MEILI_URL is not set. Configure MEILI_URL and MEILI_MASTER_KEY (see .env.example).');
    process.exit(1);
}
const dataDir = fs.realpathSync(
    path.resolve(process.env.DATA_DIR || fileURLToPath(new URL('../data', import.meta.url)))
);
const indexer = createSearchIndexer({ searchConfig, dataDir });
try {
    console.log(`Re-indexing ${dataDir} into ${searchConfig.url} (index "${searchConfig.index}")...`);
    await indexer.reindexAll();
    const key = await indexer.ensureSearchKey();
    console.log('\nFelsverzeichnis configuration:');
    console.log(`  PUBLIC_MEILI_URL=${searchConfig.url}`);
    console.log(`  PUBLIC_MEILI_INDEX=${searchConfig.index}`);
    console.log(`  PUBLIC_MEILI_SEARCH_KEY=${key}`);
} catch (e) {
    console.error(`Re-index failed: ${e.message}`);
    process.exit(1);
}
