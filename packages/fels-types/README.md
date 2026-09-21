# @vorstieg/fels-data

Shared data contracts for Felsstudio and Felsverzeichnis.

The package contains:

- JSON Schemas for `crag.json`, `sector.json`, and `<crag>-topo.json`.
- TypeScript declarations that can be consumed by JavaScript or TypeScript projects.
- Minimal examples for each file format.
- A detailed format guide in [`docs/data-formats.md`](docs/data-formats.md).

## Install

```sh
npm install @vorstieg/fels-data
```

The package is published to GitHub Packages. Consumers must configure the `@vorstieg` registry.

## Use the schemas

```js
import topoSchema from '@vorstieg/fels-data/schemas/topo';
```

## Use the types from JavaScript

The application remains JavaScript. JSDoc imports the declarations for editor completion and
optional static checking without adding TypeScript source files:

```js
/** @typedef {import('@vorstieg/fels-data/types').TopoDocument} TopoDocument */

/** @type {TopoDocument} */
const topo = { routes: [] };
```

Felsstudio uses this pattern at its topo and JSON API boundaries. The declarations do not add
runtime code; use the JSON Schemas when runtime validation is required.

For TypeScript consumers:

```ts
import type { CragFeature, SectorFeature, TopoDocument } from '@vorstieg/fels-data/types';
```

`crag.json` and `sector.json` are GeoJSON Features. Their coordinates use `[longitude, latitude]`.
Topo geometry uses normalized 2D coordinates: `[x, y]`, with both values between `0` and `1`.

The schemas intentionally allow additional properties. This keeps older readers compatible as
metadata evolves while making the shared/core fields explicit.

## Development

```sh
npm run validate
```
