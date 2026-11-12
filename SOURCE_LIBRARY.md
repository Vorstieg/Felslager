# Capture uploads and processing API

Felslager stores original captures and produces immutable processing results.
Felsstudio downloads a result, imports it into its own project filesystem, edits
it manually, and owns publication through the authenticated `/api/fs` API.
There is no backend editing or publication workflow under `/api/entries`.

All capture and processing endpoints require a session cookie. Mutations also
require a trusted `Origin`. Use `credentials: "include"` from Felsstudio. Worker
bearer tokens only grant access to worker endpoints.

## Capture uploads

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/captures` | Create `{entryPath, name}`; return capture metadata with `id` |
| GET | `/api/captures?entryPath=...` | List capture summaries; filter optional |
| GET | `/api/captures/:id` | Metadata, original file paths and byte counts |
| PUT | `/api/captures/:id/files?path=flight/video.mp4` | Stream an original file |
| GET | `/api/captures/:id/files?path=flight/video.mp4` | Download an original privately |
| DELETE | `/api/captures/:id` | Remove a capture without active processing references |

`entryPath` is the existing relative Fels entry directory, for example
`austria/example-crag/main-wall`. It need not exist in public content. No extra
entry identifier or backend draft is required.

There is **no sealing endpoint**, expected upload count, or completion action.
Each successful upload becomes available for the next processing run. Duplicate
filenames return `409`; append new filenames or create a new capture to replace
an existing original. Interrupted uploads are not registered and can be retried.
The API streams bytes to temporary files and atomically installs each completed
upload without modifying the original.

Uploads accept any filename extension and content type. Workers process these media types:

- Images: JPEG, PNG, WebP and TIFF (`.jpg`, `.jpeg`, `.png`, `.webp`, `.tif`, `.tiff`).
- Videos: `.mp4`, `.mov`, `.m4v`, `.avi`, `.mkv`, `.webm` (decoding depends on FFmpeg).
- Subtitles/telemetry: `.srt`.

Defaults: 10,000 uploaded files, 20 GiB per file (`CAPTURE_MAX_FILE_BYTES`),
100 GiB per capture (`CAPTURE_MAX_DATASET_BYTES`). Configure reverse-proxy request limits and timeouts
for video uploads. The HTTP server allows six hours to receive the entire request
(`HTTP_REQUEST_TIMEOUT_MS=21600000`, minimum 60000 ms), while headers must arrive
within 60 seconds. Restart the API after changing this setting.
Node's default five-minute request timeout is too short for multi-GB uploads.
A reverse proxy can still interrupt uploads earlier: its body size limit must
allow `CAPTURE_MAX_FILE_BYTES`, and its upstream send/read timeouts must accommodate
the transfer. For nginx, check `client_max_body_size`, `client_body_timeout`,
`proxy_send_timeout`, `proxy_read_timeout`, and available temporary disk space
when request buffering is enabled. An HTTP/2 protocol error alone does not identify
which layer closed the connection; check proxy and API logs for 408/413/499/502/504
responses and compare elapsed time with configured timeouts.
Traversal, hidden path components and symlink paths are rejected.
Workers decode supported media during processing and ignore other file types.

Captures and processing data are kept indefinitely until explicitly deleted.
Active jobs prevent deletion of their input captures.

## Processing

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/processing` | Queue a run; return `202` with processing metadata and `id` |
| POST | `/api/processing/:id/runs` | Create an independent run from a selected pipeline step |
| GET | `/api/processing?entryPath=...` | List runs; filter optional |
| GET | `/api/processing/:id` | Status, phase, progress, capture reference or error |
| POST | `/api/processing/:id/cancel` | Cancel a queued run or request cancellation of an active run |
| GET | `/api/processing/:id/results` | Result manifest with filenames and authenticated download URLs |
| GET | `/api/processing/:id/results/files?path=model.glb` | Download one result file |
| DELETE | `/api/processing/:id` | Remove a terminal run, its results and work files; preserve originals |

Start a run:

```json
{
  "captureId": "<capture-id>",
  "engine": "meshroom",
  "runBoltDetection": false,
  "name": "First reconstruction"
}
```

`engine` is `odm` (default), `meshroom` or `realityscan`.
`runBoltDetection` is a boolean, defaulting to true. `name` is optional.
Placement uses `options.positioning.method`: `triangle` (default, nearest forward
triangle intersection) or `vertex` (nearby-vertex snapping). Both work with all
three engines. The API accepts only the current options format; stored jobs must
include explicit `startStep`, `optionsVersion`, `options` and `flowRunId` fields.

Vertex snapping uses a 0.15-unit ray tolerance and probes from 1 to under 35 units
in 0.5-unit steps. These are metres only for metric reconstructions. It can miss
sparse meshes or distant surfaces; triangle placement has no distance cutoff.

Restart from a step with `POST /api/processing/:id/runs`:

```json
{
  "fromStep": "positioning",
  "options": { "positioning": { "method": "vertex" } }
}
```

`fromStep` is required: `preparing` reads the current capture and runs the whole
pipeline; `reconstructing` reuses prepared images and runs reconstruction onward;
`detecting` reuses reconstruction and runs fresh inference and positioning;
`positioning` reuses reconstruction and the selected source result's cached
detections. Each request returns `202` with a new job ID, `startStep`, and
`sourceProcessingId` pointing to the selected source. Results are independent.

Summaries expose `availableStartSteps`, computed from the retained prerequisites.
Later-step runs use retained artifacts and do not require the original capture.
Only terminal runs can be sources; a failed engine run can restart reconstruction
if preparation completed. Missing prerequisites return `409 STEP_SOURCE_UNAVAILABLE`.
Options `engine`, `options`, `runBoltDetection` and `name` inherit from
the source. Engine changes require `preparing` or `reconstructing`. Starting at
`detecting` or `positioning` enables detection and rejects `runBoltDetection: false`.
Unknown steps, options, and incompatible options return `400`.
Source runs cannot be deleted while dependent runs exist. Chained runs reuse the
appropriate reconstruction ancestor and the selected source's own detections.

Results include mapping counts (`mapping.unmapped`, `mapping.truncated`) and the
requested positioning method. Each hit records its method, surface position,
world ray, calibration pixel and surface incidence angle. `detections.json`
retains per-image detections, calibration and mapping failures for positioning
reruns. Camera calibration and mesh alignment determine placement accuracy.

The entry path comes from the capture and cannot be overridden. The worker requires at least two usable images/frames after preparation.

Processing runs reference their capture directly. Workers read the files available
when preparing a run; uploads after queueing can be included. Several engines/runs
can reuse one capture. Workers link photos into their work directory and extract
one JPEG frame per second from each video with FFmpeg. The total prepared
image limit is 10,000; exceeding it fails the run rather than silently truncating.
Originals remain mounted read-only.

The worker reconstructs with the selected engine and optionally runs bolt
detection. Reconstruction-only runs do not invoke the detection deployment or load YOLO.
Both paths produce `model.glb` and `project.json` with cameras and coordinate system;
reconstruction-only projects have an empty `hits` array. Detection runs additionally
include detections and referenced crops. Uploaded SRT files are preserved verbatim
under `telemetry/`; camera-specific SRT GPS data is not currently applied to frames.

Statuses are `queued`, `processing`, `completed`, `failed` or `cancelled`.
Active cancellation returns `202` with `cancelRequested: true` and stage
`cancelling`. The worker stops its current stage/process group (or cancels the
remote NodeODM task), then acknowledges `cancelled`. Poll status until terminal.
Queued cancellation is immediate. Cancellation preserves the originals and never
exposes partial results. Cancellation and crash state come from Prefect; no worker leases are used.

Results return `409 RESULT_NOT_READY` until completion. A manifest looks like:

```json
{
  "processingId": "<processing-id>",
  "entryPath": "austria/example-crag/main-wall",
  "captureId": "<capture-id>",
  "engine": "meshroom",
  "runBoltDetection": false,
  "files": [
    { "path": "model.glb", "url": "/api/processing/<processing-id>/results/files?path=model.glb" },
    { "path": "project.json", "url": "/api/processing/<processing-id>/results/files?path=project.json" }
  ]
}
```

Felsstudio fetches the model, project metadata and referenced files with session
credentials, imports them into its own project, and saves subsequent edits there.
Result downloads are immutable; there is no result-file PUT endpoint. Publication
uses Studio's existing authenticated filesystem workflow. Owning a capture does
not block ordinary `/api/fs` writes, moves or deletes.

## Storage

`CAPTURE_DIR` defaults to `captures/` beside the auth database.
`PROCESSING_DIR` defaults to `processing/` beside the auth database.
Capture names and entry paths come from the directory layout. File listings, counts,
byte sizes and creation dates come from the filesystem. There are no capture metadata
files or database records. Capture entry paths do not need a corresponding published
directory. Capture names must be valid directory names.

```text
CAPTURE_DIR/<entryPath>/<name>--<captureId>/
  files/...                        Original images, videos and SRT files

PROCESSING_DIR/<processingId>/
  job.json                         Job metadata, Prefect run ID and capture reference
  artifacts/<root-run-id>/...          Prepared images and engine work files
  outputs/<root-run-id>/...        Private worker output for a Prefect run
  results/
    result.json                    Completion timestamp and Prefect run ID
    generated/...                  Immutable, API-owned result files

DATA_DIR/<entryPath>/...            Content published explicitly by Felsstudio
```

Private roots must not overlap content, auth, reviews, checkout or each other.
Workers mount captures read-only and processing read-write at the same absolute
paths as the API. Use one API process. Back up the SQLite database, originals, results and job metadata
separately from public content.

Uploads to the same capture are serialized from validation through commit so parallel
requests cannot overwrite files or exceed capture limits. Different captures can upload
concurrently. Other capture, processing and public filesystem mutations are assumed
not to conflict.

Installing an immutable result commits completion. Job reads recognize that result
without repeating processing or relying on Prefect availability. Execution and
cancellation state for unfinished jobs comes directly from Prefect.

### Per-step processing options

`GET /api/processing/options` (session required) returns versioned control metadata:
labels, help, defaults, bounds, advanced flags
and engine support. Use the same form component for each step and hide overrides
unsupported by the selected engine. Engine, detection enablement and run name
remain job-level controls. Placement is configured through `options.positioning.method`.

Create and restart requests accept a partial `options` object (2 MiB JSON request limit):

```json
{
  "options": {
    "preparing": {
      "videoFrameIntervalSeconds": 2,
      "videoStartSeconds": 0,
      "videoEndSeconds": null,
      "excludedPaths": []
    },
    "reconstructing": { "quality": "standard" },
    "detecting": { "confidence": 0.25, "tileOverlap": 0.2, "suppressionIoU": 0.5 },
    "positioning": { "method": "triangle" }
  }
}
```

Preparation time ranges apply to each video. Exclusions are exact capture-relative
file paths (including telemetry files), without traversal or backslashes. Sampling
interval is 0.1–60 seconds; start/end are 0–86400 seconds and end must exceed start.
Existing image/extraction limits remain operator safeguards.

Quality is `preview`, `standard` (default) or `detailed`. ODM uses maximum mesh
vertices/octree depth of 500000/10, 2000000/12 and 4000000/13. Its advanced
`maxMeshVertices` override accepts 10000–5000000 or null to use the preset.
Meshroom preserves its installed template at standard quality and overrides
DepthMap downscale to 4 for preview or 1 for detailed. Its advanced
`textureResolution` accepts 1024, 2048, 4096, 8192 or 16384 pixels, or null to use
the template. RealityScan uses preview, normal or high model calculation.
Unsupported engine overrides return `UNSUPPORTED_ENGINE_OPTION`; clear them with
null when switching engines. Quality names express intent, not equivalent outputs.

Detection confidence and suppression IoU accept 0.01–1; tile overlap accepts 0–0.5.

Responses, worker payloads and result manifests include fully resolved `options`
and `optionsVersion: 1`. New runs save defaults explicitly. Restarts merge field
by field with the source settings. Settings belonging to steps before `fromStep`
cannot change (`INCOMPATIBLE_RUN_OPTION`): sampling requires `preparing`, quality
requires `reconstructing`, and inference thresholds require `detecting`.
Positioning reuses already thresholded/suppressed detections; reducing a confidence
threshold requires fresh inference. Unknown option keys and invalid types/bounds
return `INVALID_PROCESSING_OPTIONS`.

Downloaded `project.json` includes processing settings and provenance: processing
ID, engine, preset mapping version, generated Meshroom pipeline or RealityScan
export preset hashes where available, and detector weights SHA-256. Positioning
reruns preserve the cached detections' model identity. Native engine binary
versions are deployment-managed; these records do not guarantee reproduction
across engine upgrades or changes to live capture files.
