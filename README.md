# Felslager

The [OpenAPI 3.1 specification](openapi.json) documents authentication, public
filesystem access, reviews, captures, processing and private worker callbacks.
The nonstandard HTTP `MOVE` operation is recorded as `x-move`; OpenAPI tools
may omit it from generated clients. Replace the local server URL for your deployment.

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

## Captures and processing

Upload private captures through `/api/captures`, then start, monitor, cancel and
download results through `/api/processing`. Reconstruction supports ODM, Meshroom
and RealityScan, with optional YOLO bolt detection. Felsstudio imports results,
owns manual editing, and publishes through authenticated `/api/fs` writes.

- [Capture and processing API](SOURCE_LIBRARY.md): uploads, options, restart steps,
  result downloads and private storage.
- [Worker operations](workers/processing/README.md): Prefect, setup, containers,
  engine installations and worker callbacks.

## Review submissions

Anonymous clients may `POST /api/reviews` with an `application/zip` v1 review package (500 MB request and expanded-content ceiling, 10 MB JSON manifest ceiling). No rate limiting is applied. All review reads and deletions require an existing authenticated account; writes also require a trusted Origin.

- `GET /api/reviews`: inbox metadata, newest first.
- `GET /api/reviews/:id`: metadata and affected-file actions.
- `GET /api/reviews/:id/archive`: immutable archive download.
- `DELETE /api/reviews/:id`: permanently remove a review and its archive.

Archives and metadata live in `REVIEW_DIR`, defaulting to `reviews/` beside `AUTH_DATABASE_PATH`. This directory must be persistent, private, and outside both `DATA_DIR` and the deployment checkout. Back it up alongside authentication storage. No production files are changed by submission or deletion. The Felsstudio inbox imports a separate local reviewer draft; explicit publication uses authenticated filesystem operations before deleting the review and its archive. Failed deletion can be retried without repeating production writes. Existing publication is sequential and may partially succeed; publication uses the ordinary filesystem write behavior. There are no reviewer assignments, comments, notifications, or automatic cleanup.
