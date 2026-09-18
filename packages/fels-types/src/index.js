import felsSchema from '../schemas/fels.schema.json' with { type: 'json' };
import topoSchema from '../schemas/topo.schema.json' with { type: 'json' };

/** Shared JSON Schemas for Felsstudio and Felsverzeichnis data files. */
export const schemas = Object.freeze({ fels: felsSchema, topo: topoSchema });

/** Package version of the shared data contract. */
export const dataFormatVersion = '0.1.2';

export { felsSchema, topoSchema };
