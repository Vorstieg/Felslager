// Auto-generated types from JSON schemas
export type Position = [longitude: number, latitude: number, elevation?: number];
export type Point2D = [x: number, y: number];
export type Point3D = [x: number, y: number, z: number];
export type Path2D = Point2D[];
export type Path3D = Point3D[];
export interface GeoJSONGeometry {
	type: 'Point' | 'Polygon' | 'MultiPolygon';
	coordinates: unknown;
}
export type EntryKind = 'country' | 'region' | 'area' | 'crag' | 'sector';
export type PointOrAreaGeometry =
    | {
          type: 'Point';
          coordinates: Position;
      }
    | {
          type: 'Polygon';
          coordinates: [Position, Position, Position, Position, ...Position[]][];
      }
    | {
          type: 'MultiPolygon';
          coordinates: unknown[];
      };
/**
 * @minItems 2
 * @maxItems 3
 */
export type Position = [number, number, ...number[]];

/**
 * A Fels entry (crag, sector, area, etc.) stored as a GeoJSON Feature.
 */
export interface FelsEntry {
    type: 'Feature';
    properties: FelsProperties;
    geometry: PointOrAreaGeometry;
    [k: string]: unknown;
}
export interface FelsProperties {
    id: string;
    name: string;
    kind: EntryKind;
    type?: string[];
    security?: string;
    rock_type?: string;
    description_de?: string;
    description_en?: string;
    equipment?: unknown[];
    assets?: {};
    tags?: string[];
    topo?: {};
    geometry?: PointOrAreaGeometry;
    date?: string;
    updated?: string;
    [k: string]: unknown;
}
export type Grade = {
    scale: string;
    value: string;
    standardizedValue: string;
} | null;
/**
 * @minItems 2
 */
export type Path3D = [Point3D, Point3D, ...Point3D[]];
/**
 * @minItems 3
 * @maxItems 3
 */
export type Point3D = [number, number, number];
/**
 * @minItems 2
 */
export type Path2D = [Point2D, Point2D, ...Point2D[]];
/**
 * @minItems 2
 * @maxItems 2
 */
export type Point2D = [number, number];

/**
 * Route metadata and optional 2D/3D topo geometry.
 */
export interface FelsTopoDocument {
    id?: string;
    description?: string;
    tags?: string[];
    image2D?: string | null;
    imageAspectRatio?: number;
    date?: string;
    updated?: string;
    author?: string;
    /**
     * @minItems 3
     * @maxItems 3
     */
    coordinates?: [number, number, number];
    routes: Route[];
    paths?: PathCollection;
    fixPoints?: FixPoint[];
    lineOverlays?: LineOverlay[];
    textLabels?: TextLabel[];
    [k: string]: unknown;
}
export interface Route {
    id: string | number;
    name?: string;
    type?: string;
    grade?: Grade;
    description?: string;
    tags?: string[];
    points3D?: Path3D;
    orientation3D?: Point3D;
    boltAmount?: number;
    length?: number;
    lineStyle?: string;
    points2D?: Path2D;
    pitches?: Pitch[];
    variants?: Variant[];
    fixPoints?: (string | number)[];
    assets?: {};
    pathRefs?: PathRef[];
    [k: string]: unknown;
}
export interface Pitch {
    id: string | number;
    pitchNumber: number;
    grade?: Grade;
    lineStyle?: string;
    points2D?: Path2D;
    points3D?: Path3D;
    [k: string]: unknown;
}
export interface Variant {
    id: string | number;
    points2D?: Path2D;
    points3D?: Path3D;
    lineStyle?: string;
    [k: string]: unknown;
}
export interface PathRef {
    pathId: string | number;
    role?: string;
    label?: string;
    [k: string]: unknown;
}
export interface PathCollection {
    type: 'FeatureCollection';
    features: PathFeature[];
    [k: string]: unknown;
}
export interface PathFeature {
    type: 'Feature';
    id?: string | number;
    properties?: {};
    geometry: {
        type: 'LineString';
        /**
         * @minItems 2
         */
        coordinates: [Point3D, Point3D, ...Point3D[]];
        [k: string]: unknown;
    };
    [k: string]: unknown;
}
export interface FixPoint {
    id: string | number;
    type: string;
    position2D?: Point2D;
    position3D?: Point3D;
    rotation2D?: number;
    scale2D?: number;
    [k: string]: unknown;
}
export interface LineOverlay {
    id: string | number;
    lineStyle?: 'rock' | 'approach' | 'descent' | 'fixedRope';
    points2D?: Path2D;
    points3D?: Path3D;
    [k: string]: unknown;
}
export interface TextLabel {
    id: string | number;
    text: string;
    position2D?: Point2D;
    position3D?: Point3D;
    fontSize2D?: number;
    color?: string;
    fontWeight?: string | number;
    textAlign2D?: 'left' | 'center' | 'right';
    [k: string]: unknown;
}
