# Processing with Prefect

Felslager submits processing jobs to the Prefect deployment
`Felslager reconstruction/reconstruct-<engine>` (`odm`, `meshroom`, `realityscan`).
The reconstruction flow prepares captures and exports a common artifact bundle.
When requested, it invokes `Felslager detection/detection` as a child flow and
waits for its completion. Otherwise it packages the reconstruction directly.
Each deployment is served by its existing engine-specific container using
`flow.serve(limit=1)`. Prefect handles scheduling, process isolation, execution
state, crash reporting and cancellation. There is no Felslager worker queue,
polling loop, lease or heartbeat protocol.

## API and private files

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

Callbacks from inactive, cancelled or mismatched runs are rejected. Failure and
cancellation callbacks and the old `/worker/next` endpoint have been removed.
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
current capture directory, with FFmpeg extracting one video frame per second
and a total limit of 10,000 images. SRT telemetry is preserved verbatim.

## Deployment and upgrades

See [worker deployment](workers/processing/README.md). Start the Prefect server
and serve the selected engine deployments before admitting jobs. The host API
uses `PREFECT_API_URL=http://127.0.0.1:4200/api`; containers use the Compose address.
Automatic retries and caching are disabled because external engine side effects
are not replay safe. Start a new job after failure rather than retrying an old
run in the dashboard. No capture snapshots are introduced.

Stop the previous queue workers before upgrading. Existing completed results
remain readable. Legacy jobs without a Prefect run ID are reported as failed
and should be restarted as new jobs; they are not silently replayed.
