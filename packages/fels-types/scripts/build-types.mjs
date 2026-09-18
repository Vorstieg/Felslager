import { compileFromFile } from 'json-schema-to-typescript';
import fs from 'fs/promises';
import path from 'path';

async function generate() {
  console.log('Generating types from schemas...');
  
  let types = `// Auto-generated types from JSON schemas
export type Position = [longitude: number, latitude: number, elevation?: number];
export type Point2D = [x: number, y: number];
export type Point3D = [x: number, y: number, z: number];
export type Path2D = Point2D[];
export type Path3D = Point3D[];
export interface GeoJSONGeometry {
	type: 'Point' | 'Polygon' | 'MultiPolygon';
	coordinates: unknown;
}
`;

  const customResolver = {
    order: 1,
    canRead: /^https:\/\/schemas\.vorstieg\.com\/fels-data\//i,
    read: async (file) => {
      const filename = file.url.split('/').pop();
      return fs.readFile(path.join('schemas', filename));
    }
  };

  const options = {
    additionalProperties: false,
    bannerComment: '',
    declareExternallyReferenced: true,
    style: { singleQuote: true, tabWidth: 4 },
    $refOptions: {
      resolve: {
        vorstieg: customResolver
      }
    }
  };

  try {
    const felsTypes = await compileFromFile('schemas/fels.schema.json', options);
    const topoTypes = await compileFromFile('schemas/topo.schema.json', options);
    
    types += felsTypes;
    types += topoTypes;
    
    await fs.writeFile('types/index.d.ts', types);
    console.log('Types generated successfully.');
  } catch (error) {
    console.error('Error generating types:', error);
    process.exit(1);
  }
}

generate();
