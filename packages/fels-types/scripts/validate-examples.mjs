import fs from 'node:fs';
import Ajv from 'ajv';

const root = new URL('..', import.meta.url);
const readJson = (name) => JSON.parse(fs.readFileSync(new URL(name, root), 'utf8'));
const ajv = new Ajv({ strict: false });

const cragSchema = readJson('schemas/crag.schema.json');
const sectorSchema = readJson('schemas/sector.schema.json');
const topoSchema = readJson('schemas/topo.schema.json');
ajv.addSchema(cragSchema);

for (const [schema, example] of [
	[cragSchema, 'examples/crag.json'],
	[sectorSchema, 'examples/sector.json'],
	[topoSchema, 'examples/example-topo.json'],
	[topoSchema, 'examples/example-3d-topo.json']
]) {
	const validate = ajv.compile(schema);
	const data = readJson(example);
	if (!validate(data)) {
		console.error(`${example} is invalid`);
		console.error(validate.errors);
		process.exitCode = 1;
	} else {
		console.log(`${example}: valid`);
	}
}
