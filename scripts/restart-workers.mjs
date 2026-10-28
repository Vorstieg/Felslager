#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const help = `Update and restart running Felslager workers.

Usage: node scripts/restart-workers.mjs [options] [detection odm meshroom realityscan]

Default: update application source on the installed images, then recreate workers.
  --restart-only       Recreate workers without building images
  --full-build         Build from the repository Dockerfile (also updates dependencies)
  --project NAME       Compose project name (default: felslager)
  --help               Show this help

Compose files and environment-file paths are discovered from container labels.
The default update retains installed dependencies; use --full-build after changing
pyproject.toml, uv.lock, Dockerfile, presets or model weights. Only running workers
are selected. The API, Prefect server, engines and stored data are left running.
`;

export function parseArgs(args) {
  const options = { project: 'felslager', mode: 'source', workers: [], help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--project') {
      const value = args[++index];
      if (!value || value.startsWith('-')) throw new Error('--project requires a name');
      options.project = value;
    } else if (['--restart-only', '--full-build'].includes(arg)) {
      if (options.mode !== 'source') throw new Error('Choose only one build mode');
      options.mode = arg === '--restart-only' ? 'restart' : 'full';
    } else if (['detection', 'odm', 'meshroom', 'realityscan'].includes(arg)) {
      if (!options.workers.includes(arg)) options.workers.push(arg);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function composeArgs(container, project) {
  const labels = container.Config.Labels;
  const directory = labels['com.docker.compose.project.working_dir'];
  const files = labels['com.docker.compose.project.config_files'];
  if (!directory || !files) throw new Error('Container is missing Compose configuration labels');
  const args = ['compose', '--project-name', project, '--project-directory', directory];
  const envFiles = labels['com.docker.compose.project.environment_file'];
  for (const file of envFiles?.split(',').filter(Boolean) || []) args.push('--env-file', path.resolve(directory, file));
  for (const file of files.split(',').filter(Boolean)) args.push('-f', path.resolve(directory, file));
  return args;
}

const capture = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (args) => execFileSync('docker', args, { stdio: 'inherit' });

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return console.log(help);
  const ids = capture(['ps', '--filter', `label=com.docker.compose.project=${options.project}`, '--format', '{{.ID}}']).split(/\s+/).filter(Boolean);
  if (!ids.length) throw new Error(`No running containers found for project ${options.project}`);
  const containers = JSON.parse(capture(['inspect', ...ids]));
  const workers = containers.filter(container => {
    const service = container.Config.Labels['com.docker.compose.service'];
    return /^worker-(detection|odm|meshroom|realityscan)$/.test(service) &&
      (!options.workers.length || options.workers.includes(service.slice(7)));
  });
  for (const requested of options.workers) {
    if (!workers.some(c => c.Config.Labels['com.docker.compose.service'] === `worker-${requested}`))
      throw new Error(`Worker ${requested} is not running in project ${options.project}`);
  }
  if (!workers.length) throw new Error('No running Felslager workers found');
  const compose = composeArgs(workers[0], options.project);
  for (const container of workers) {
    if (JSON.stringify(composeArgs(container, options.project)) !== JSON.stringify(compose))
      throw new Error('Workers have different Compose configurations; restart them separately');
  }
  const services = workers.map(c => c.Config.Labels['com.docker.compose.service']);
  console.log(`Updating: ${services.join(', ')} (${options.mode})`);
  if (options.mode === 'full') run([...compose, 'build', ...services]);
  if (options.mode === 'source') {
    const localContext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../workers/processing');
    if (!existsSync(path.join(localContext, 'felslager_processing'))) throw new Error(`Missing worker source: ${localContext}`);
    const temporary = mkdtempSync(path.join(tmpdir(), 'felslager-worker-update-'));
    try {
      // Use immutable image IDs so each worker keeps its engine-specific setup.
      for (const [index, container] of workers.entries()) {
        const dockerfile = path.join(temporary, `worker-${index}.Dockerfile`);
        writeFileSync(dockerfile, `FROM ${container.Image}\nCOPY --chown=worker:worker felslager_processing /app/felslager_processing\n`);
        run(['build', '-f', dockerfile, '-t', container.Config.Image, localContext]);
      }
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  // Build every selected image successfully before replacing any container.
  run([...compose, 'up', '-d', '--no-build', '--no-deps', '--force-recreate', ...services]);
  const deadline = Date.now() + 60000;
  const pending = new Set(services);
  while (pending.size && Date.now() < deadline) {
    for (const service of pending) {
      const id = capture([...compose, 'ps', '-q', service]);
      if (!id) continue;
      const [container] = JSON.parse(capture(['inspect', id]));
      if (!container.State.Running) throw new Error(`${service} stopped. Check: docker logs ${id}`);
      const logs = execFileSync('docker', ['logs', '--since', container.State.StartedAt, id], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (logs.includes('is being served and polling for scheduled runs')) {
        console.log(`${service}: ready`);
        pending.delete(service);
      }
    }
    if (pending.size) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (pending.size) throw new Error(`Startup not confirmed within 60 seconds: ${[...pending].join(', ')}. Check worker logs.`);
  console.log('All selected workers are ready.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.stderr?.toString().trim() || error.message);
    process.exitCode = 1;
  });
}
