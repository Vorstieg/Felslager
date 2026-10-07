// Auto-generated types from JSON schemas
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
          coordinates: [Position, Position, Position, Position, ...Position[]][][];
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
    equipment?: {
        name: string;
        type?: string;
        amount?: number;
        sizes?: string;
        optional?: boolean;
        [k: string]: unknown;
    }[];
    assets?: {};
    tags?: string[];
    topo?: {
        link?: string;
        [k: string]: unknown;
    };
    geometry?: PointOrAreaGeometry;
    date?: string;
    updated?: string;
    [k: string]: unknown;
}
export type Route = ClimbingLine & {
    name?: string;
    type?: string;
    description?: string;
    tags?: string[];
    orientation3D?: Point3D;
    boltAmount?: number;
    pitches?: Pitch[];
    variants?: Variant[];
    fixPoints?: (string | number)[];
    assets?: {};
    pathRefs?: PathRef[];
    [k: string]: unknown;
};
export type Grade = {
    scale: string;
    value: string;
    standardizedValue: string;
} | null;
/**
 * @minItems 2
 * @maxItems 2
 */
export type Point2D = [number, number];
/**
 * @minItems 2
 */
export type Path2D = [Point2D, Point2D, ...Point2D[]];
/**
 * @minItems 2
 */
export type Path3D = [Point3D, Point3D, ...Point3D[]];
/**
 * @minItems 3
 * @maxItems 3
 */
export type Point3D = [number, number, number];
export type Pitch = ClimbingLine & {
    pitchNumber: number;
    [k: string]: unknown;
};
export type Variant = ClimbingLine & {
    name?: string;
    [k: string]: unknown;
};

/**
 * Route metadata and optional 2D/3D topo geometry.
 */
export interface FelsTopoDocument {
    id?: string;
    description?: string;
    tags?: string[];
    image2D?: string | null;
    backgroundFit?: 'contain' | 'cover';

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
    outlines?: Outline[];
    textLabels?: TextLabel[];
    [k: string]: unknown;
}
export interface ClimbingLine {
    id: string | number;
    grade?: Grade;
    length?: number;
    lineStyle?: string;
    curve?: Curve;
    labelOffset2D?: Point2D;
    points2D?: Path2D;
    points3D?: Path3D;
    [k: string]: unknown;
}
export interface Curve {
    enabled?: boolean;
    tension?: number;
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
    properties?: {
        name?: string;
        role?: string;
        label?: string;
        routeType?: string;
        [k: string]: unknown;
    };
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
    scaleX2D?: number;
    scaleY2D?: number;
    [k: string]: unknown;
}
export interface Outline {
    id: string | number;
    points2D?: Path2D;
    lineStyle?: string;
    shape?: {
        type?: string;
        preset?: string;
        semantic?: {};
        start2D?: Point2D;
        end2D?: Point2D;
        center2D?: Point2D;
        radius2D?: number;
        segments?: number;
        fromCenter?: boolean;
        square?: boolean;
        [k: string]: unknown;
    } | null;
    curve?: Curve;
    fillColor?: string | null;
    fillOpacity?: number;
    closed?: boolean;
    [k: string]: unknown;
}
export interface TextLabel {
    id: string | number;
    text: string;
    position2D?: Point2D;
    position3D?: Point3D;
    rotation2D?: number;
    fontSize2D?: number;
    color?: string;
    fontWeight?: string | number;
    textAlign2D?: 'left' | 'center' | 'right';
    [k: string]: unknown;
}
