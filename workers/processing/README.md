# Felslager reconstruction and detection workers

This project contains reconstruction adapters, camera projection and YOLO bolt
inference. It has no labeling or training workflow. Reconstruction and detection
run separately as Prefect deployments. Felslager owns private captures, progress
and result downloads; Prefect owns scheduling and execution state.

## Prefect execution

Each engine serves `Felslager reconstruction/reconstruct-<engine>`; the detector
serves `Felslager detection/detection`. The reconstruction flow prepares captures,
reconstructs and exports artifacts, then either packages its result or invokes the
detection deployment as a child flow. Prefect displays their relationship, tasks
and logs. Each runner executes one flow subprocess at a time. No Docker socket,
custom queue, worker polling loop, leases or heartbeat threads are used.

Start and cancel jobs through Felslager or inspect their runs in Prefect. The API
maps Prefect run states to application statuses. Workers check that the root run
is active before working and finalizing; cancellation stops subprocess groups or
the NodeODM task. Automatic task/flow retries and caching are disabled because
external engine side effects are not replay safe. Start a new job after a failure.
Results are not stored in Prefect; they remain private Felslager artifacts.

Only job IDs and the root run ID are flow parameters. Credentials and private
filesystem paths are obtained from the authenticated worker API at execution.
No capture snapshots are introduced; preparation reads the current capture files.

Prepared photos and telemetry link to the read-only capture mount. Meshroom and
RealityScan link their flattened input names directly to the image targets; video
frames are generated in job storage. All workers must see captures and job storage
at identical absolute paths. Keep captures available for later detection runs.
RealityScan sidecars stay in its writable input folder.

Meshes move from engine scratch into the common handoff, and staged editor files
move into worker output without another full directory copy. Felslager installs
an independent immutable result. Scratch is retained for manual cleanup after
the run finishes. Preserve captures, job metadata and final results.

| Role | Dependencies | Output |
| --- | --- | --- |
| Reconstruction: ODM | Base Python + separate NodeODM service | Private textured mesh and calibrated camera artifacts |
| Reconstruction: Meshroom | Base Python + Meshroom installation | Same handoff artifacts |
| Reconstruction: RealityScan | Base Python + licensed RealityScan/Wine installation | Same handoff artifacts |
| Detection | Base Python + `detection` extra (PyTorch, YOLO) + v3 weights | Private GLB, project JSON and crops, downloadable by Felsstudio |

Captures accept files without sealing or file type restrictions. Workers read the
current capture directory when preparing each run. They prepare photos/video frames
and retain SRT telemetry. With `runBoltDetection: false`, reconstruction exports the
model and empty-hit editor project itself; no detector is needed. Otherwise the
reconstruction flow invokes detection. Both paths create private immutable downloads;
Felsstudio owns subsequent editing and publication. See the
[capture API](../../SOURCE_LIBRARY.md).

Placement settings, restart prerequisites and result diagnostics are documented
in the [capture and processing API](../../SOURCE_LIBRARY.md#processing).

## Local processes

Run commands from this directory. Copy `.env.example` to `.env`, configure the
API URL and shared service token, and mount private job storage at the API's
absolute `PROCESSING_DIR` path, plus read-only captures at `CAPTURE_DIR`. Install
FFmpeg on the worker host for video frame extraction; all container targets include it. Workers do not need access
to public content.

```sh
uv sync --locked
# In a separate terminal, using the same environment:
uv run --no-sync prefect server start
# Set PREFECT_API_URL=http://127.0.0.1:4200/api in the worker .env.
uv run --no-sync python -m felslager_processing --role reconstruction --engine odm
# In the detection worker's own environment/process:
git lfs pull
uv sync --locked --extra detection
uv run --no-sync python -m felslager_processing --role detection
```

Use `--engine meshroom` or `--engine realityscan` in a separate reconstruction
process for those engines. Install only the base dependencies in reconstruction
containers. The checked-in v3 model is 20,320,261 bytes (19.4 MiB), tracked with
Git LFS. No v1 model is required. LFS weights must be hydrated before a detection
image build; that build rejects an LFS pointer. Model weights are copied only into
the detection image. Datasets, original photos, generated outputs and installed
engine binaries stay outside Git.

Variables: `FELSLAGER_JOBS_URL`, `BOLT_WORKER_TOKEN`, `NODEODM_URL`,
`PREFECT_API_URL` (required, includes `/api`),
`BOLT_MODEL_PATH`, `MESHROOM_HOME`, `REALITYSCAN_CLI`, `REALITYSCAN_MODEL_PARAMS` and
`REALITYSCAN_REGISTRATION_PARAMS`. See [worker protocol](#worker-protocol).
Run regressions with `uv run --extra detection --group dev pytest`. Worker integration
tests use an isolated temporary Prefect server and do not contact your deployment.

## Deployment setup

Compose runs a persistent Prefect server, the detection and reconstruction workers,
and NodeODM when selected. Felslager itself runs on the host using the [API setup](../../README.md#setup):

```sh
npm ci
npm run create-user
npm start
```

Copy `.env.example` to `.env` before setup and set independent `BETTER_AUTH_SECRET`
and `BOLT_WORKER_TOKEN` secrets. Set explicit absolute `PROCESSING_DIR` and
`CAPTURE_DIR` paths. Create both directories before starting the API or Compose,
outside the checkout, public content, auth database and review storage. The host
API user and container workers (UID 1000) must have read/write access to processing
and read access to captures; the API also needs write access to captures. Private
directories and files created by the API use owner-only permissions, so run the
host API as UID 1000 to match the workers.

Workers connect to `FELSLAGER_JOBS_URL`, defaulting to
`http://host.docker.internal:3001/api/processing`. Compose maps that hostname to
the host gateway on Linux. The host API must be reachable from the Docker bridge;
a loopback-only listener cannot be reached through this gateway. If the API uses
a different port, update `FELSLAGER_JOBS_URL` too. Use the same `BOLT_WORKER_TOKEN`
for the host API and workers. Auth secrets and frontend settings stay with the API.

Workers bind-mount `PROCESSING_DIR` read-write and `CAPTURE_DIR` read-only at the
same absolute paths used by the host API. Authentication, reviews and published
content stay on the host and are not mounted into workers. Back up the host data
paths separately from Docker engine-state volumes.

Prefect run history, NodeODM task data and RealityScan login/Wine state use named volumes. To
place those on another disk, set `FELSLAGER_STORAGE_DIR`, create its
`realityscan-state` and `nodeodm-data` directories owned by UID 1000, plus a
`prefect-data` directory for the Prefect server, and add
`-f compose.storage.yaml` after `-f compose.yaml` before first creating the volumes.
Choose `PROCESSING_DIR` and `CAPTURE_DIR` directly to put shared data on another
disk. Do not use `docker compose --env-file ../.env down --volumes` unless deliberately deleting
persistent engine state.

Existing deployments with a containerized API need a separate migration: stop
the old API, preserve its volumes, and move its auth, reviews, content, captures
and processing data to the configured host paths before starting the host API.
Removing the service from Compose does not stop an existing API container.

## Containers

Build and start from the `workers/` directory with Docker Compose 2.30+ and
BuildKit. Pass `--env-file ../.env` to load the host API configuration from the
repository root. The Compose files live in `workers/`.
The deployment setup below covers secrets, users, persistence
and host API setup. Felslager runs on the host with `npm start`; Compose contains
workers, engine services and a Prefect server. Set `FELSLAGER_JOBS_URL` to the host API
(default `http://host.docker.internal:3001/api/processing`) and use the same
`BOLT_WORKER_TOKEN` as the API. Configure explicit absolute `PROCESSING_DIR` and
`CAPTURE_DIR` paths in root `.env`; they are bind-mounted at identical container
paths, with captures read-only. Pre-create the directories and run the API as
UID 1000 to match worker access to owner-only private files.
Engine profiles and the optional `detection` profile can be combined; disabled
engines are neither built nor started. Runners serve Prefect deployments against the internal
`http://prefect-server:4200/api` URL and wait for its health check before starting. The host API also connects to Prefect
using root `.env` `PREFECT_API_URL=http://127.0.0.1:4200/api`.

```sh
# Host API already running; detector + ODM runner + NodeODM:
docker compose --env-file ../.env --profile odm --profile detection up --build -d
# Host API already running; detector + Meshroom runner:
docker compose --env-file ../.env --profile meshroom --profile detection up --build -d
# Host API already running; detector + RealityScan runner:
docker compose --env-file ../.env --profile realityscan --profile detection up --build -d
```

Omit `--profile detection` for reconstruction-only jobs. With no profiles, no
worker services are selected; only Prefect starts. For example,
`--profile realityscan up --build -d` starts Prefect and the RealityScan deployment runner.

Open the Prefect dashboard at **http://127.0.0.1:4200**. Set `PREFECT_PORT` in
the root `.env` to change the host port. The dashboard/API bind to localhost and
are intended for local administration. Flow logs can contain private filenames;
use an SSH tunnel when administering a remote host. The `prefect-data` volume
retains the SQLite database and run history. The server and Python SDK are both
pinned to Prefect 3.8.8. Back up this volume with engine state; the optional storage
override also supports a dedicated `prefect-data` directory.

All adapters return one typed output contract and use the same exporter to produce
`reconstruction/model.glb`, `cameras.json` and `prepared-images/`, described by
`artifact.json` in the work directory. Detection consumes this common bundle.
See [the handoff format](#common-reconstruction-output).

The image targets `reconstruction`, `detection`, `meshroom` and `realityscan` share
base Python layers. Only detection installs PyTorch and weights. Engine installers
are not downloaded automatically or included in the detection build target.
NodeODM runs in its own container with persistent task storage and no host port.
The CPU NodeODM image is pinned to 3.5.6; select and validate another explicit
version if upgrading.

Detection uses CPU by default. For GPU inference, add
`-f compose.yaml -f compose.gpu.yaml` before `--profile`. Meshroom and RealityScan
request NVIDIA GPUs independently. Install compatible NVIDIA host drivers and
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
GPU jobs on one host compete for VRAM; size worker counts accordingly.

### Meshroom

Extract the official Meshroom 2025.1 Linux bundle outside this checkout and set
root `.env` `MESHROOM_INSTALL_DIR` to that directory. Compose mounts it read-only
at `/opt/meshroom`; the folder must contain executable `meshroom_batch`. Its
standard dense pipeline requires NVIDIA/CUDA. The image supplies Ubuntu 22.04
runtime libraries, while the engine installation stays out of the image. Test
`docker compose --env-file ../.env --profile meshroom run --rm --entrypoint /opt/meshroom/meshroom_batch worker-meshroom --help`
before submitting jobs. A different engine release may require different system
libraries. See [official Meshroom installation](https://meshroom-manual.readthedocs.io/en/latest/first-steps/install/getting-meshroom/platforms/index.html).

### RealityScan

Download the licensed **Linux .deb** from Epic into a dedicated directory outside
Git, and set root `.env` `REALITYSCAN_INSTALLER_DIR` to that directory. BuildKit
mounts this directory only while installing the package into the RealityScan
image; provide one installer and no unrelated files. This installs RealityScan's
bundled Wine runtime instead of reusing a host Wine installation. Rebuild after
changing the installer.

The image follows [Epic's Ubuntu 22.04 Docker guidance](https://dev.epicgames.com/documentation/realityscan/docker-deployment),
including Vulkan and X11 libraries. GPU passthrough must support Vulkan as well
as CUDA. `VIDEO_GID` and `RENDER_GID` must match the host device group IDs
(`stat -c '%g' /dev/dri/card* /dev/dri/renderD*`). The persistent
`realityscan-state` volume is the worker's home, retaining login and Wine state.
A virtual X server supports normal unattended execution.

When importing an existing Wine prefix, retain its temporary directory even if
you exclude cached contents: `.realityscan/realityscan/drive_c/users/crossover/AppData/Local/Temp`
under the persistent home. A missing directory can block startup with a modal
"Failed to create the application temp" error. Verify startup with
`xvfb-run -a /opt/realityscan/bin/realityscan-cli -headless -set appQuitOnError=true -newScene -quit`
inside the container before serving its Prefect deployment.

Activate/login once as the **same container user and home**. On an X11 desktop,
stop the runner and launch the GUI interactively with your own authenticated
Xauthority cookie:

```sh
docker compose --env-file ../.env --profile realityscan stop worker-realityscan
docker compose --env-file ../.env --profile realityscan run --rm \
  --entrypoint /opt/realityscan/bin/realityscan \
  -e DISPLAY -e XAUTHORITY=/tmp/host.Xauthority \
  -v /tmp/.X11-unix:/tmp/.X11-unix:ro \
  -v "${XAUTHORITY:-$HOME/.Xauthority}:/tmp/host.Xauthority:ro" \
  worker-realityscan
docker compose --env-file ../.env --profile realityscan up -d worker-realityscan
```

This requires a valid readable Xauthority file and an X11/XWayland session; a
remote headless host needs an operator-provided remote desktop/login session.
Epic notes that login can require an in-container browser; add the browser
appropriate to your login flow to the RealityScan image if required. Verify
`nvidia-smi`, `vulkaninfo --summary` and the CLI under the service account before
submitting a real job. Some host/container driver combinations require extra
Vulkan ICD/library mounts described in Epic's guide; these are deployment
specific. No login credentials or activated state are baked into the image.

## Reconstruction and camera conventions

ODM uses NodeODM's multipart API and downloads the textured GLB, matching OBJ and
`opensfm/reconstruction.json`. Brown and perspective calibration are supported;
unsupported/disconnected reconstructions fail explicitly. ODM outputs are `Z_UP`.
Meshroom stages original bytes with unique names, exports its textured OBJ and
matching calibrated Meshing scene, and converts AliceVision camera/OBJ conventions
to `Y_UP`. Supported intrinsics are pinhole, radialk1, radialk3 and Brown; camera
rigs, fisheye and unsupported calibration fail explicitly.

RealityScan exports textured OBJ and COLMAP text cameras with original distorted
calibration using the presets under `presets/realityscan/`. Both presets require
local Euclidean Z-up coordinates and identity scene transforms. Supported COLMAP
models are SIMPLE_PINHOLE, PINHOLE, SIMPLE_RADIAL, RADIAL, OPENCV and FULL_OPENCV
with zero rational denominator coefficients. Unregistered images are skipped.
See [Epic Linux setup](https://dev.epicgames.com/documentation/realityscan/installation-linux?lang=en-US)
and [CLI export commands](https://rshelp.capturingreality.com/en-US/appbasics/allcommands.htm).

Detection intersects calibrated rays with triangles from the exact GLB mesh.
`project.json` includes mapped hits, referenced crops and cameras independently
of detections. Zero detections can complete; detections without mesh intersections
fail. GPS remains empty without a GPS export. The editor must preserve each
project's coordinate convention and transform cameras/hits with the model.


RealityScan progress is read from `realityscan-progress.txt` in the private job
work directory every two seconds using the CLI's `-writeProgress` option.
Job status includes `operation`, `operationProgress` (0–100),
`operationElapsedSeconds`, and `operationRemainingSeconds` while native updates
are available. These describe the current operation; its percentage can reset
when RealityScan switches operations. Overall job progress uses approximate
weights for alignment, reconstruction, texturing and export, and never decreases.
Nested operations do not advance the parent estimate. Remaining time is RealityScan's
estimate for the operation, not the whole job. Missing native updates leave the
last known progress in place; cancellation continues to work normally.

## Per-run settings

Workers consume the API's resolved `options` for preparation, reconstruction,
inference and positioning. See [the options contract](../../SOURCE_LIBRARY.md#per-step-processing-options)
for defaults, bounds, quality mappings, restart rules and provenance. Standard
quality preserves the previous behavior. Sampling, time ranges and exclusions
are applied only during preparation; cached positioning never reruns inference.
Batch size, device selection, service paths and safety limits remain operator
settings. Deploy the API and updated worker images together to enable the controls.

## Worker protocol

Felslager retains authenticated job metadata, progress and private downloads.
`POST /api/processing` binds a paused Prefect run to the job before scheduling it.
Reads map Prefect states to the existing `queued`, `processing`, `failed` and
`cancelled` statuses. An installed result is the completion commit point and
remains downloadable even when Prefect is offline. `flowRunId` identifies the
root run in the dashboard. Cancellation requests transition that run through
Prefect; workers stop engine process groups or cancel the remote NodeODM task.
A detection child checks the root run as well, so parent cancellation stops it.

Workers authenticate with `Authorization: Bearer $BOLT_WORKER_TOKEN` and send
`X-Processing-Run: <root Prefect run ID>` on these callbacks:

| Endpoint under `/api/processing` | Purpose |
| --- | --- |
| GET `/worker/:id` | Obtain private paths; check the root run is still active |
| POST `/worker/:id/progress` | Update application progress |
| POST `/worker/:id/complete` | Import immutable private result files |

Callbacks from inactive, cancelled or mismatched runs are rejected.
Workers share `PROCESSING_DIR` read-write and `CAPTURE_DIR` read-only at identical
absolute paths. They need no public content or Felsstudio filesystem access.
Temporary files live under `artifacts/<root-run-id>` and `outputs/<root-run-id>`.
Scratch is retained for manual cleanup after a run finishes. Preserve captures,
job metadata and final results when removing scratch. Terminal job deletion removes its metadata and
results too. Capture deletion checks Prefect for active processing references.

## Common reconstruction output

```text
artifact.json
reconstruction/
  model.glb
  cameras.json
  prepared-images/...
  detection-mesh.obj       # Only when a separate mesh is needed
```

All adapters return `ReconstructionOutput(model, cameras, names, detection_mesh,
coordinate_system)`. The exporter normalizes camera documents to OpenSfM format
and validates paths. Meshroom exports `Y_UP`; ODM and RealityScan export `Z_UP`.
The v1 manifest records relative paths, engine, image mapping and coordinate
system. Detection consumes this bundle; reconstruction-only runs export cameras
and empty hits without importing the detector. Prepared images come from the
current capture directory, with FFmpeg extracting one video frame per second by default
and a total limit of 10,000 images. SRT telemetry is preserved verbatim.


## Updating workers

Run from `workers/`, using the same project name, environment files and Compose
`-f` overrides used when starting the deployment. The examples update ODM and
detection; select only the worker services you use (`worker-odm`,
`worker-meshroom`, `worker-realityscan`, `worker-detection`). Naming services
explicitly enables their profiles.

Build the selected images first, then recreate their containers after the build
succeeds:

```sh
cd workers
docker compose --env-file ../.env build worker-odm worker-detection
docker compose --env-file ../.env up -d --no-build --no-deps --force-recreate worker-odm worker-detection
```

Builds use Docker's layer cache. Changes to dependencies, presets, model weights
or source files are included through the repository Dockerfile. Detection builds
require hydrated Git LFS weights; RealityScan builds require its installer.

To restart existing containers without building or applying configuration changes:

```sh
docker compose --env-file ../.env restart worker-odm worker-detection
```

To apply Compose configuration changes using existing images, use the `up`
command above without the build command. For a custom project, add
`--project-name my-felslager` to each command. For GPU or storage overrides, add
`-f compose.yaml -f compose.gpu.yaml -f compose.storage.yaml` as applicable to each
command before `build`, `up`, `restart`, `ps` or `logs`.

Check container status and confirm the selected runners are polling in their logs:

```sh
docker compose --env-file ../.env ps worker-odm worker-detection
docker compose --env-file ../.env logs --tail=50 worker-odm worker-detection
```

Run updates between processing jobs: restarting or recreating a worker stops its
active processes. The explicit service list and `--no-deps` keep Prefect, NodeODM
and other services running. Restart the host API separately after API code changes.
