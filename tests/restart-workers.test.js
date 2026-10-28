import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs, composeArgs } from '../scripts/restart-workers.mjs';

const script = fileURLToPath(new URL('../scripts/restart-workers.mjs', import.meta.url));
const container = {
  Image: 'sha256:immutable-installed-image',
  Config: { Image: 'felslager-worker-detection:latest', Labels: {
    'com.docker.compose.service': 'worker-detection',
    'com.docker.compose.project.working_dir': '/project with spaces/workers',
    'com.docker.compose.project.config_files': 'compose.yaml,/config/override.yaml',
    'com.docker.compose.project.environment_file': '../.env,/config/workers.env'
  } }, State: { Running: true, StartedAt: '2026-10-27T00:00:00Z' }
};

test('parses selected workers and rejects ambiguous modes', () => {
  assert.deepEqual(parseArgs(['--project', 'custom', 'odm', 'odm', 'detection']), {
    project: 'custom', mode: 'source', workers: ['odm', 'detection'], help: false
  });
  assert.throws(() => parseArgs(['--restart-only', '--full-build']));
  assert.throws(() => parseArgs(['--project']));
  assert.throws(() => parseArgs(['unknown']));
});

test('preserves ordered Compose overrides and environment files as separate arguments', () => {
  assert.deepEqual(composeArgs(container, 'felslager'), [
    'compose', '--project-name', 'felslager', '--project-directory', '/project with spaces/workers',
    '--env-file', '/project with spaces/.env', '--env-file', '/config/workers.env',
    '-f', '/project with spaces/workers/compose.yaml', '-f', '/config/override.yaml'
  ]);
  assert.throws(() => composeArgs({ Config: { Labels: {} } }, 'felslager'));
});

function fakeDocker(t, { failBuild = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'fels-worker-script-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = path.join(directory, 'calls.jsonl');
  const docker = `#!/usr/bin/python3
import sys, json
from pathlib import Path
args = sys.argv[1:]
record = {'args': args}
if args[0] == 'build': record['dockerfile'] = Path(args[args.index('-f') + 1]).read_text()
with open(${JSON.stringify(log)}, 'a') as output: output.write(json.dumps(record) + '\\n')
if args[0] == 'ps': print('container-id')
elif args[0] == 'inspect': print(${JSON.stringify(JSON.stringify([container]))})
elif args[0] == 'logs': print('Your flow is being served and polling for scheduled runs!')
elif args[0] == 'compose' and 'ps' in args: print('container-id')
elif args[0] == 'build' and ${failBuild ? 'True' : 'False'}: sys.exit(7)
`;
  writeFileSync(path.join(directory, 'docker'), docker, { mode: 0o755 });
  return { env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` },
    calls: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

test('source update uses immutable installed image and recreates only selected workers', t => {
  const fake = fakeDocker(t);
  const output = execFileSync(process.execPath, [script, 'detection'], { env: fake.env, encoding: 'utf8' });
  const calls = fake.calls();
  const build = calls.find(call => call.args[0] === 'build');
  assert.match(build.dockerfile, /^FROM sha256:immutable-installed-image\n/);
  assert.match(build.dockerfile, /COPY --chown=worker:worker felslager_processing/);
  const restart = calls.find(call => call.args.includes('up'));
  assert.deepEqual(restart.args.slice(-6), ['up', '-d', '--no-build', '--no-deps', '--force-recreate', 'worker-detection']);
  assert.match(output, /worker-detection: ready/);
});

test('restart-only skips image builds', t => {
  const fake = fakeDocker(t);
  execFileSync(process.execPath, [script, '--restart-only'], { env: fake.env });
  assert.equal(fake.calls().some(call => call.args[0] === 'build' || call.args.includes('build')), false);
});

test('a failed build leaves the running containers untouched', t => {
  const fake = fakeDocker(t, { failBuild: true });
  const result = spawnSync(process.execPath, [script], { env: fake.env });
  assert.equal(result.status, 1);
  assert.equal(fake.calls().some(call => call.args.includes('up')), false);
});

test('a requested worker that is not running fails before any update', t => {
  const fake = fakeDocker(t);
  const result = spawnSync(process.execPath, [script, 'odm'], { env: fake.env });
  assert.equal(result.status, 1);
  assert.match(result.stderr.toString(), /Worker odm is not running/);
  assert.equal(fake.calls().some(call => call.args.includes('up') || call.args[0] === 'build'), false);
});
