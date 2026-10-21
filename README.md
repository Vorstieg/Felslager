# Felslager

Public content reads are anonymous. Every provisioned user can upload, move and delete content. Accounts use Better Auth email/password authentication with sessions stored in SQLite.

## Setup

1. Run `npm ci` and copy `.env.example` to `.env`.
2. Set `BETTER_AUTH_SECRET` to a persistent random secret of at least 32 characters (for example, generate it with `openssl rand -base64 48`). Set `AUTH_DATABASE_PATH` to a private persistent file outside both the checkout and `DATA_DIR`.
3. Configure the backend URL and the exact trusted frontend origin. Production requires HTTPS and `NODE_ENV=production`. Set `TRUST_PROXY` only for your actual reverse proxy addresses/CIDRs; otherwise leave it empty.
4. Run `npm run create-user` to enter a name, email and password interactively. Password input is hidden and must contain 12–128 characters. Repeat this command for additional users.
5. Run `npm start`. The auth schema is created automatically. Use one backend process. Rate limiting is disabled.

No SMTP or admin account is required. Public signup, invitations, roles and self-service password recovery are unavailable. Operators handle forgotten passwords outside the application. Back up the private SQLite database with a SQLite-aware backup tool (or stop the server before copying it).

## Frontend integration

Use `credentials: "include"` for auth requests and content writes. Send JSON with `Content-Type: application/json` to the login/logout endpoints:

| Endpoint                            | Request / response                                                     |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `POST /api/auth/sign-in/email`      | Body: `{ "email": "...", "password": "..." }`; sets the session cookie |
| `POST /api/auth/sign-out`           | Body: `{}`; invalidates the session                                    |
| `GET /api/auth/get-session`         | Returns `{ user, session }`, or `null` when logged out                 |
| `GET`, `HEAD /api/fs/...`           | Public reads                                                           |
| `PUT`, `MOVE`, `DELETE /api/fs/...` | Require a valid session and trusted `Origin`                           |

For `MOVE`, the `Destination` header is a path relative to the content root, for example `/austria/renamed.json`. A `401` on a content write means the user must log in again. Uploaded documents are sandboxed; preserve the content security headers at the reverse proxy.

The previous `/api/me` and `/api/admin/*` API is removed. Use session lookup for login state; every authenticated user can edit. A populated database from the earlier roles/invitation implementation is rejected to avoid granting write access to former pending, suspended or read-only accounts. Preserve that database, select a fresh `AUTH_DATABASE_PATH`, and provision the intended editors explicitly.

Run `npm test` to check auth, provisioning, persistence, content writes and filesystem protections.

## Reconstruction and detection workers

The Python workers live under [workers/processing](workers/processing/README.md).
Felslager coordinates reconstruction followed by detection through its queue.
Each reconstruction engine and the YOLO detector run as separate processes or
containers. Only detection installs PyTorch and loads the v3 weights. See
[BOLT_JOBS.md](BOLT_JOBS.md) for the queue and private shared storage contract.
Detector weights are tracked with Git LFS; run `git lfs install` and `git lfs pull`
before starting the worker.

### Docker Compose

Compose runs only the detection and reconstruction workers, plus NodeODM when
selected. Felslager itself runs on the host using the [setup above](#setup):

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

In another terminal, start the engines you need from `workers/`, loading the
root `.env` explicitly:

```sh
git lfs pull
cd workers
docker compose --env-file ../.env --profile odm --profile detection up --build -d
```

This starts detection, the ODM reconstruction worker and NodeODM. Profiles
`meshroom` and `realityscan` enable their own engine containers; profiles can be
combined. Without profiles no workers start. The `detection` profile is optional; omit it
for reconstruction-only jobs. Select an engine in processing requests that has a running worker; requests
default to ODM. NodeODM has no published host port.

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

Only NodeODM task data and RealityScan login/Wine state use named volumes. To
place those on another disk, set `FELSLAGER_STORAGE_DIR`, create its
`realityscan-state` and `nodeodm-data` directories owned by UID 1000, and add
`-f compose.storage.yaml` after `-f compose.yaml` before first creating the volumes.
Choose `PROCESSING_DIR` and `CAPTURE_DIR` directly to put shared data on another
disk. Do not use `docker compose --env-file ../.env down --volumes` unless deliberately deleting
persistent engine state.

Existing deployments with a containerized API need a separate migration: stop
the old API, preserve its volumes, and move its auth, reviews, content, captures
and processing data to the configured host paths before starting the host API.
Removing the service from Compose does not stop an existing API container.

Detection runs on CPU by default. With NVIDIA drivers and Container Toolkit,
enable its GPU with
`docker compose --env-file ../.env -f compose.yaml -f compose.gpu.yaml --profile odm --profile detection up --build -d`.
Meshroom and RealityScan profiles require an NVIDIA GPU. See the
[worker deployment instructions](workers/processing/README.md#containers) for
engine installations, RealityScan login and GPU setup. No worker receives the
Docker socket.

## Captures and processing

Upload private captures for any Fels entry path, then start processing immediately.
Captures accept any file type; workers process images, videos and SRT files; there is no sealing step or declared
file count. The entry does not need to be published first. Processing reads the capture files when preparing a run, supports ODM, Meshroom
and RealityScan, and accepts
`runBoltDetection: false` to reconstruct without YOLO.

Use `/api/captures` for uploads and `/api/processing` for starting, monitoring,
cancelling and downloading results. See [SOURCE_LIBRARY.md](SOURCE_LIBRARY.md)
for the complete frontend API and [BOLT_JOBS.md](BOLT_JOBS.md) for worker integration.

Felsstudio imports the result into its own project filesystem, performs manual
editing and owns publication through authenticated `/api/fs` writes. Processing
never publishes content. Captures and processing use separate storage from public content. Operations run without application locks.

## Review submissions

Anonymous clients may `POST /api/reviews` with an `application/zip` v1 review package (500 MB request and expanded-content ceiling, 10 MB JSON manifest ceiling). No rate limiting is applied. All review reads and deletions require an existing authenticated account; writes also require a trusted Origin.

- `GET /api/reviews`: inbox metadata, newest first.
- `GET /api/reviews/:id`: metadata and affected-file actions.
- `GET /api/reviews/:id/archive`: immutable archive download.
- `DELETE /api/reviews/:id`: permanently remove a review and its archive.

Archives and metadata live in `REVIEW_DIR`, defaulting to `reviews/` beside `AUTH_DATABASE_PATH`. This directory must be persistent, private, and outside both `DATA_DIR` and the deployment checkout. Back it up alongside authentication storage. No production files are changed by submission or deletion. The Felsstudio inbox imports a separate local reviewer draft; explicit publication uses authenticated filesystem operations before deleting the review and its archive. Failed deletion can be retried without repeating production writes. Existing publication is sequential and may partially succeed; publication uses the ordinary filesystem write behavior. There are no reviewer assignments, comments, notifications, or automatic cleanup.
