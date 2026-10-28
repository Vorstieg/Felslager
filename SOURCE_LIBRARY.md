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
for video uploads. Traversal, hidden path components and symlink paths are rejected.
Workers decode supported media during processing and ignore other file types.

Captures and processing data are kept indefinitely until explicitly deleted.
Active jobs prevent deletion of their input captures.

## Processing

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/processing` | Queue a run; return `202` with processing metadata and `id` |
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
`boltPlacementMethod` is `triangle` (default, exact nearest forward triangle hit),
`vertex` (the older dashboard's nearby-vertex snapping), or `multiview`
(experimental robust triangulation with triangle fallback). It works with all three
engines and is returned in job summaries and result manifests. For example, add
`"boltPlacementMethod": "vertex"` when starting a run.
Vertex snapping uses a 0.15-unit ray tolerance and probes from 1 to under 35 units
in 0.5-unit steps. These are metres only for metric reconstructions. It can miss
sparse meshes or distant surfaces; triangle placement has no distance cutoff.

With `"boltPlacementMethod": "multiview"`, triangle hits seed candidate matches
of the same detection class across different images. Only reciprocal matches
without competing candidates in the same image are linked. At least three
distinct images, 2 degrees of ray separation, and a 60% consensus are required.
Pair hypotheses reject reprojection outliers; robust nonlinear refinement minimizes
distorted calibration-pixel errors with fixed cameras. The error limit is 6 pixels.
Candidates and estimates must remain within 3% of camera-to-surface distance of
their visible triangle hits. This is a scale-relative consistency gate, not a
measured accuracy guarantee. Positions may remain off the rock surface.
Tracks are limited to 64 observations; crowded or ambiguous regions and failed
estimates keep their original triangle positions. Detections without a surface
hit cannot seed a track in this version. The existing first-1,500-hit limit applies.

All methods export additive diagnostics without removing individual observations:

- `project.json`: `mapping.unmapped`, `mapping.truncated`, and `positioning` with
  `requestedMethod`, `refinedObservations`, and `tracks` (ID, position, zero-based
  `hitIndices`, reprojection RMS in calibration pixels, and maximum view angle).
- Each hit's `positioning`: actual `method`, original `surfacePosition`, world
  `ray`, `calibrationPixel`, and original surface `incidenceAngleDeg` (0 is head-on).
  Multi-view inliers also have `trackId`, `surfaceOffset` in model units, and
  `reprojectionErrorPx`. Fallbacks expose `fallbackReason` such as
  `insufficient_views`, `ambiguous_match`, `ambiguous_track`, `crowded_region`,
  `inconsistent_geometry`, or `reprojection_outlier`.
- `detections.json`: calibrated camera models, world-to-camera rotation matrices
  and camera centres keyed by source image under `calibration`. Supported detections
  report `mapping: "mapped"` plus `hitIndex`, or `mapping: "no_surface_hit"`.

Hits belonging to an accepted track share its estimated position; image/crop
references and original surface positions remain available. Felsstudio can inspect
this evidence without treating tracks as confirmed bolts. This mode still uses
bounding-box centres, not learned attachment-point keypoints. Wrong calibration,
camera/mesh alignment, or systematically shifted detections can affect every mode.
The entry path comes from the capture and cannot be overridden. The worker requires at least two usable images/frames after preparation.

Processing runs reference their capture directly. Workers read the files available
when preparing a run; uploads after queueing can be included. Several engines/runs
can reuse one capture. Workers copy photos into their work directory and extract
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

Capture, processing and public filesystem operations run directly without application
locks or serialization. Concurrent mutations are assumed not to conflict.

Installing an immutable result commits completion. Job reads recognize that result
without repeating processing or relying on Prefect availability. Execution and
cancellation state for unfinished jobs comes directly from Prefect.
