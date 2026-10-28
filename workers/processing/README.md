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

Detection accepts the job's `boltPlacementMethod`: `triangle` (default) intersects
the nearest forward mesh triangle; `vertex` uses the older dashboard's vertex
snapping with a 0.15-unit tolerance and probes from 1 to under 35 units in 0.5-unit
steps. Distances are in model units, so they represent metres only with metric
scale. `multiview` experimentally refines triangle hits using at least three
unambiguously matched views, robust pixel reprojection fitting, and a scale-relative
surface consistency gate. It falls back to triangle positions for insufficient or
inconsistent evidence. All methods consume the same calibrated camera/model handoff from ODM,
Meshroom or RealityScan and export individual observations for Felsstudio.
The project retains surface positions, ray diagnostics and accepted track membership;
the detections document includes camera calibration and mapping failures. See the
[API documentation](../../SOURCE_LIBRARY.md) for thresholds and field definitions.

## Package layout

The worker is an application package, launched with `python -m felslager_processing`.
There is no separate runtime script or import-path setup.

```text
felslager_processing/
  __main__.py          Command-line arguments and startup
  worker.py            Prefect deployments and processing tasks
  api.py               Private artifact access, cancellation checks and progress
  capture.py           Photo/video preparation and telemetry
  artifacts.py         Shared reconstruction output contract
  results.py           Private result packaging
  errors.py            Shared cancellation and failure types
  reconstruction.py    Camera geometry and mesh projection
  engines/
    odm.py             NodeODM adapter
    meshroom.py        Meshroom adapter
    realityscan.py     RealityScan adapter
    common.py          Subprocess control and material export
  detection/
    runner.py          YOLO loading, inference and 3D mapping
    inference/         Tiling and batched inference
    domain/            Detection data types
```

Engine adapters accept images, an output directory, cancellation and progress
callbacks. Only the chosen engine is imported. Detection dependencies load only
when detection is requested; reconstruction-only runs use the base dependencies.

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
`REALITYSCAN_REGISTRATION_PARAMS`. See [processing protocol](../../BOLT_JOBS.md).
Stop legacy queue workers before upgrading; restart unfinished legacy jobs as new
Prefect jobs. Existing completed results remain readable. Run regressions with `uv run --extra detection --group dev pytest`. Worker integration
tests use an isolated temporary Prefect server and do not contact your deployment.

## Containers

Build and start from the `workers/` directory with Docker Compose 2.30+ and
BuildKit. Pass `--env-file ../.env` to load the host API configuration from the
repository root. The Compose files live in `workers/`.
The [root README](../../README.md#docker-compose) covers secrets, users, persistence
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
See [the handoff format](../../BOLT_JOBS.md#common-reconstruction-output).

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
