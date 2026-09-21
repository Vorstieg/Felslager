# Fels data formats

This package defines the core schemas used by Felsstudio and Felsverzeichnis.

## File layout

The data is structured as GeoJSON Feature files. The architecture uses a unified `Fels` document format for all catalog levels (country, region, area, crag, sector).

For a crag with ID `example-crag`:

```text
example-crag/
  example-crag.json
  example-crag-topo.json
  main-wall/
    main-wall.json
    main-wall-topo.json
```

- `<slug>.json` identifies the catalog entry (crag, sector, etc.) and contains its metadata.
- `<slug>-topo.json` contains route and topo data. Topo data can also be embedded directly in the Fels properties.

## Fels Document (`fels.json`)

This is a GeoJSON `Feature`. Its top-level `geometry` may be a `Point`, `Polygon`, or `MultiPolygon`. 
The `properties` object contains the entry's metadata.

- `id`: stable slug used in filenames and URLs.
- `name`: display name.
- `kind`: catalog entry classification (`country`, `region`, `area`, `crag`, or `sector`).
- `type`: climbing disciplines available at the crag, such as `sports-climbing`, `bouldering`, and `trad`.
- `tags`: free-form classifications.
- `security`, `rock_type`, `description_de`, and `description_en`: descriptive metadata.
- `equipment`: list of equipment available.
- `assets.images` and `assets.models`: image and 3D model asset references.
- `topo`: optional embedded topo document or external reference (`site`, `link`).
- `date` and `updated`: ISO calendar dates.

```json
{
	"type": "Feature",
	"properties": {
		"id": "lausbubenwande",
		"name": "Lausbubenwände",
		"kind": "crag",
		"type": ["sports-climbing", "bouldering", "trad"],
		"tags": [],
		"security": "Gut",
		"rock_type": "Limestone",
		"description_de": "Die Lausbubenwände sind nur 5 Minuten vom Efeugrat entfernt.",
		"description_en": "The Lausbubenwände are only 5 minutes away from the Efeugrat.",
		"equipment": [],
		"assets": { "images": [] },
		"date": "2026-07-10",
		"updated": "2026-07-29"
	},
	"geometry": {
		"type": "Point",
		"coordinates": [16.272240073630343, 48.080403726320185]
	}
}
```

## Topo Document (`topo.json`)

This is a custom JSON document that contains a `routes` array and optional 2D drawing layers, 3D route geometry, or both.

- `routes`: route metadata and geometry.
- `paths`: shared GeoJSON LineString feature collection. Stored once even when several routes use it.
- `routes[].pathRefs`: references to paths in the same document. Each reference stores the route-specific `role` and optional `label`.
- `pitches`: multi-pitch route segments, ordered from bottom to top.
- `fixPoints`: bolts, belays, trees, and other topo symbols.
- `lineOverlays`: rock, approach, descent, or fixed-rope linework.
- `textLabels`: movable 2D/3D annotations.

### 2D and 3D Support

Topo documents natively support both 2D and 3D coordinates simultaneously:

- `routes[].points2D`, `pitches[].points2D`, `lineOverlays[].points2D`: Normalized `[x, y]` coordinates mapping to the unit square (0 to 1).
- `routes[].points3D`, `pitches[].points3D`, `lineOverlays[].points3D`: Local `[x, y, z]` 3D coordinates relative to a 3D model.
- `routes[].orientation3D`: A route orientation vector.
- `fixPoints[].position2D` and `fixPoints[].position3D`: 2D and 3D symbol coordinates.
- `coordinates`: A strict 3-element GeoJSON position array `[longitude, latitude, elevation]` for the geographic location of the topo itself.

```json
{
	"routes": [
		{
			"id": "route-1",
			"name": "First Route",
			"pathRefs": [{ "pathId": "path-approach", "role": "approach", "label": "Common approach" }],
			"type": "sports-climbing",
			"grade": {
				"scale": "uiaa",
				"value": "5+",
				"standardizedValue": "5b"
			},
			"points2D": [
				[0.25, 0.9],
				[0.28, 0.55],
				[0.32, 0.2]
			],
			"points3D": [
				[12.4, 3.2, -1.0],
				[12.5, 8.1, -1.1]
			]
		}
	],
	"fixPoints": [
		{
			"id": "symbol-1",
			"type": "bolt",
			"position2D": [0.32, 0.2],
			"position3D": [12.4, 3.2, -1.0]
		}
	],
	"lineOverlays": [
		{
			"id": "overlay-1",
			"lineStyle": "approach",
			"points2D": [
				[0.5, 0.9],
				[0.55, 0.95]
			]
		}
	]
}
```
