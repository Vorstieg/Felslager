// One UI/API contract for all processing stages.
export const processingOptions = {
  version: 1,
  preparing: {
    videoFrameIntervalSeconds: { type: 'number', default: 1, minimum: 0.1, maximum: 60, label: 'Video sampling interval', unit: 'seconds', description: 'Extract one frame per interval. Smaller intervals increase processing time.' },
    videoStartSeconds: { type: 'number', default: 0, minimum: 0, maximum: 86400, label: 'Video start', unit: 'seconds', description: 'Start extracting each video at this time.' },
    videoEndSeconds: { type: 'number', default: null, minimum: 0, maximum: 86400, nullable: true, label: 'Video end', unit: 'seconds', description: 'Stop extracting each video at this time; empty uses the whole video.' },
    excludedPaths: { type: 'array', default: [], label: 'Excluded files', advanced: true, description: 'Capture-relative file paths to skip during preparation.' }
  },
  reconstructing: {
    maxMeshVertices: { type: 'integer', default: null, nullable: true, minimum: 10000, maximum: 5000000, engines: ['odm'], advanced: true, label: 'Maximum mesh vertices', description: 'Override the quality preset mesh limit for ODM; empty uses the preset.' },
    textureResolution: { type: 'integer', enum: [1024, 2048, 4096, 8192, 16384], default: null, nullable: true, engines: ['meshroom'], advanced: true, label: 'Texture resolution', unit: 'pixels', description: 'Texture atlas side length for Meshroom; empty uses the engine template.' },
    quality: { type: 'string', enum: ['preview', 'standard', 'detailed'], default: 'standard', label: 'Reconstruction quality', description: 'Higher quality increases processing time and memory use. Results vary by engine.' }
  },
  detecting: {
    confidence: { type: 'number', default: 0.25, minimum: 0.01, maximum: 1, label: 'Minimum confidence', description: 'Lower values find more candidates, including more false detections.' },
    tileOverlap: { type: 'number', default: 0.2, minimum: 0, maximum: 0.5, advanced: true, label: 'Tile overlap', description: 'Fraction shared between image tiles. More overlap increases inference time.' },
    suppressionIoU: { type: 'number', default: 0.5, minimum: 0.01, maximum: 1, advanced: true, label: 'Duplicate suppression', description: 'Overlap threshold for suppressing duplicate boxes. Lower values suppress more boxes.' }
  },
  positioning: {
    method: { type: 'string', enum: ['triangle', 'vertex'], default: 'triangle', label: 'Placement method', description: 'Triangle intersects the surface; vertex snaps to a nearby mesh vertex.', advancedValues: ['vertex'] }
  }
};

const invalid = (code = 'INVALID_PROCESSING_OPTIONS') => { throw Object.assign(new Error(code), { status: 400 }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function resolveProcessingOptions(input, { source, fromStep = 'preparing', engine } = {}) {
  if (input !== undefined && !object(input)) invalid();
  const options = {};
  const steps = Object.keys(processingOptions).filter(key => key !== 'version');
  if (Object.keys(input ?? {}).some(key => !steps.includes(key))) invalid();
  for (const step of steps) {
    const supplied = input?.[step];
    if (supplied !== undefined && !object(supplied)) invalid();
    const fields = processingOptions[step];
    if (Object.keys(supplied ?? {}).some(key => !Object.hasOwn(fields, key))) invalid();
    options[step] = {};
    for (const [key, field] of Object.entries(fields)) {
      const value = supplied?.[key] !== undefined ? supplied[key] : source?.[step]?.[key] ?? structuredClone(field.default);
      if (!(value === null && field.nullable)) {
        if (field.type === 'number' || field.type === 'integer') {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < field.minimum || value > field.maximum || (field.type === 'integer' && !Number.isInteger(value))) invalid();
        } else if (field.enum && !field.enum.includes(value)) invalid();
        else if (field.type === 'array' && (!Array.isArray(value) || value.length > 10000 || value.some(p => typeof p !== 'string' || !p || p.length > 1024 || p.startsWith('/') || p.includes('\\') || p.split('/').some(s => !s || s === '.' || s === '..')))) invalid();
      }
      if (field.enum && value !== null && !field.enum.includes(value)) invalid();
      if (engine && field.engines && value !== null && !field.engines.includes(engine)) invalid('UNSUPPORTED_ENGINE_OPTION');
      options[step][key] = value;
    }
  }
  if (options.preparing.videoEndSeconds !== null && options.preparing.videoEndSeconds <= options.preparing.videoStartSeconds) invalid();
  if (source) for (const step of steps.slice(0, steps.indexOf(fromStep))) {
    if (JSON.stringify(options[step]) !== JSON.stringify(source[step])) invalid('INCOMPATIBLE_RUN_OPTION');
  }
  return options;
}
