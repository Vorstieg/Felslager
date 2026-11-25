#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Use the same dotenv configuration as npm start, including the default tiles directory.
tiles_dir="$(cd "${project_dir}" && node --input-type=module -e '
  import "dotenv/config";
  import path from "node:path";
  import { loadConfig } from "./config.js";
  const config = loadConfig();
  console.log(config.tilesDir || path.join(path.dirname(config.databasePath), "tiles"));
')"
mkdir -p "${tiles_dir}"
tiles_dir="$(cd "${tiles_dir}" && pwd)"
work_dir="$(mktemp -d "${tiles_dir}/.via-ferrata-XXXXXXXX")"
trap 'rm -rf "${work_dir}"' EXIT

if [[ $# -gt 1 ]]; then
  echo "Usage: npm run build:via-ferrata -- [input.osm.pbf]" >&2
  exit 1
fi
if [[ $# -eq 1 ]]; then
  cp -- "$1" "${work_dir}/input.osm.pbf"
else
  echo "Downloading Austria OSM data from Geofabrik..."
  curl --fail --location --silent --show-error --retry 3 --connect-timeout 20 \
    https://download.geofabrik.de/europe/austria-latest.osm.pbf \
    -o "${work_dir}/input.osm.pbf"
fi

docker run --rm --user "$(id -u):$(id -g)" \
  -v "${work_dir}:/data" \
  -v "${project_dir}/scripts:/scripts:ro" \
  "${TILEMAKER_IMAGE:-ghcr.io/systemed/tilemaker@sha256:d32505d7827907089c2dd07517524276946d8930b4b82e93cf5c25ec989bbe41}" \
  --input /data/input.osm.pbf --output /data/via-ferrata.pmtiles \
  --config /scripts/via-ferrata-tilemaker.json \
  --process /scripts/via-ferrata-process.lua

# Validate before atomically replacing the archive; failed builds preserve live tiles.
node --input-type=module - "${work_dir}/via-ferrata.pmtiles" <<'JS'
import { open } from 'node:fs/promises';
const file = await open(process.argv[2], 'r');
try {
  const header = Buffer.alloc(127);
  const { bytesRead } = await file.read(header, 0, 127, 0);
  if (bytesRead !== 127 || header.toString('ascii', 0, 7) !== 'PMTiles' ||
      header[7] !== 3 || header.readBigUInt64LE(72) === 0n ||
      header.readInt32LE(102) >= header.readInt32LE(110) ||
      header.readInt32LE(106) >= header.readInt32LE(114)) {
    throw new Error('Tilemaker did not produce a nonempty PMTiles v3 archive with valid bounds');
  }
} finally {
  await file.close();
}
JS
mv -f -- "${work_dir}/via-ferrata.pmtiles" "${tiles_dir}/via-ferrata.pmtiles"
echo "Published ${tiles_dir}/via-ferrata.pmtiles"
