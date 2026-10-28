# Restart Felslager workers

From the Felslager repository:

```sh
node scripts/restart-workers.mjs
```

This discovers running workers in the `felslager` Docker Compose project, updates
application source on their existing images, recreates the containers, and waits
up to 60 seconds for their Prefect runners to start polling. It reuses the
containers' Compose overrides and environment-file paths, including local GPU
and storage configuration. Run it with the same Docker access used for Compose.

```sh
# Update only detection:
node scripts/restart-workers.mjs detection

# Recreate workers without updating their images:
node scripts/restart-workers.mjs --restart-only

# Rebuild dependencies, system packages, presets and model weights too:
node scripts/restart-workers.mjs --full-build

# A different Compose project:
node scripts/restart-workers.mjs --project my-felslager detection odm
```

The default is a source-only update: installed Python dependencies, engine setup,
presets and model weights remain in the images. Use `--full-build` when those
change; the configured installers, weights and build dependencies must be
available. All selected images must build successfully before any containers are
replaced. Source updates do not delete older modules from the base image; use a
full build after removing or renaming Python modules.

Run this between processing jobs: recreating a worker stops its active processes.
The script selects only currently running workers. It leaves Prefect, NodeODM,
the Felslager API and persistent data running. Restart the API separately after
API code changes. It reads environment files through Compose without printing
their contents.
