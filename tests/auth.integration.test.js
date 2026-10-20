import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createUser } from "../auth.js";
import { createApp } from "../index.js";
import { Document, NodeIO } from '@gltf-transform/core';

const password = "Correct horse battery staple!";
const origin = "http://localhost:5173";

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "felslager-auth-"));
  const dataDir = path.join(directory, "content");
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, "public.txt"), "public content");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const optimized = [];
  const config = {
    dataDir,
    databasePath: path.join(directory, "private", "auth.sqlite"),
    secret: "test-secret-with-at-least-thirty-two-characters",
    baseURL: `${baseURL}/api/auth`,
    studioURL: origin,
    trustedOrigins: [origin],
    production: false,
    trustProxy: false,
    boltWorkerToken: "integration-worker-secret",
  };
  const dependencies = {
    optimizeGlb: async (...args) => {
      optimized.push(args);
    },
  };
  let instance;
  try {
    instance = await createApp(config, dependencies);
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const handler = (request, response) => instance.app(request, response);
  server.on("request", handler);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = async (
    route,
    { cookie, body, rawBody, headers, ...init } = {},
  ) => {
    const response = await fetch(`${baseURL}${route}`, {
      ...init,
      headers: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(rawBody !== undefined
        ? { body: rawBody }
        : body !== undefined
          ? { body: JSON.stringify(body) }
          : {}),
      redirect: "manual",
    });
    return response;
  };
  const seed = async () => {
    const email = `user-${crypto.randomUUID()}@example.test`;
    const user = await createUser(config, { email, password, name: "Editor" });
    const response = await request("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password },
    });
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    return { ...user, email, cookie, response };
  };
  return {
    request,
    seed,
    optimized,
    config,
    baseURL,
    directory,
    dataDir,
    get db() {
      return instance.db;
    },
    async restart() {
      await instance.close();
      instance = await createApp(config, dependencies);
    },
  };
}

async function expectCode(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal((await response.json()).code, code);
}

test("public reads remain anonymous and shared Basic credentials cannot write", async (t) => {
  const f = await fixture(t);
  const response = await f.request("/api/fs/public.txt", {
    headers: { Origin: "https://public.example" },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "public content");
  const session = await f.request("/api/auth/get-session");
  assert.equal(await session.json(), null);
  for (const method of ["PUT", "DELETE", "MOVE"]) {
    await expectCode(
      await f.request("/api/fs/public.txt", {
        method,
        headers: {
          Authorization:
            "Basic " + Buffer.from("admin:old-password").toString("base64"),
          Destination: "/moved.txt",
        },
      }),
      401,
      "AUTH_REQUIRED",
    );
  }
});

test("capture uploads require a session and trusted Origin, without sealing or a published entry", async (t) => {
  const f = await fixture(t);
  const editor = await f.seed();
  await expectCode(await f.request('/api/captures'), 401, 'AUTH_REQUIRED');
  await expectCode(await f.request('/api/captures', { method: 'POST', cookie: editor.cookie,
    headers: { Origin: 'https://attacker.example' }, body: { name: 'Survey', entryPath: 'wall' } }), 403, 'ORIGIN_NOT_ALLOWED');
  const response = await f.request('/api/captures', { method: 'POST', cookie: editor.cookie,
    body: { name: 'Survey', entryPath: 'region/wall' } });
  assert.equal(response.status, 201);
  const capture = await response.json();
  for (const name of ['a.jpg', 'b.jpg', 'flight.mp4', 'flight.srt']) {
    assert.equal((await f.request(`/api/captures/${capture.id}/files?path=${name}`, { method: 'PUT', cookie: editor.cookie,
      headers: { 'Content-Type': 'application/octet-stream' }, rawBody: Buffer.from('original') })).status, 201);
  }
  await expectCode(await f.request(`/api/captures/${capture.id}/files?path=a.jpg`), 401, 'AUTH_REQUIRED');
  assert.equal((await f.request(`/api/fs/region/wall/.sources/${capture.id}/images/a.jpg`)).status, 403);
  assert.equal((await f.request(`/api/captures/${capture.id}/complete`, { method: 'POST', cookie: editor.cookie })).status, 404);
  const job = await f.request('/api/processing', { method: 'POST', cookie: editor.cookie,
    body: { captureId: capture.id, runBoltDetection: false } });
  assert.equal(job.status, 202);
  assert.equal((await job.json()).captureId, capture.id);
  await expectCode(await f.request(`/api/captures/${capture.id}`, { method: 'DELETE', cookie: editor.cookie }), 409, 'CAPTURE_IN_USE');
  // Capture ownership does not block Studio's ordinary filesystem writes.
  const entry = { type: 'Feature', properties: { id: 'wall', name: 'Wall', kind: 'crag' }, geometry: { type: 'Point', coordinates: [16, 48] } };
  assert.equal((await f.request('/api/fs/region/wall/wall.json', { method: 'PUT', cookie: editor.cookie, body: entry })).status, 200);
  assert.equal((await f.request('/api/entries?entryPath=region/wall', { cookie: editor.cookie })).status, 404);
  assert.equal((await f.request('/api/entries/publish', { method: 'POST', cookie: editor.cookie, body: {} })).status, 404);
});

test("separate reconstruction and detection services return private results for Studio publication", async (t) => {
  const f = await fixture(t);
  const editor = await f.seed();
  await expectCode(await f.request("/api/processing", {
    method: "POST", body: { engine: "meshroom" },
  }), 401, "AUTH_REQUIRED");
  const sourceResponse = await f.request('/api/captures', { method: 'POST', cookie: editor.cookie,
    body: { name: 'Survey', entryPath: 'models' } });
  assert.equal(sourceResponse.status, 201, await sourceResponse.clone().text());
  const source = await sourceResponse.json();
  for (const name of ['a.jpg', 'b.jpg']) {
    const uploaded = await f.request(`/api/captures/${source.id}/files?path=${name}`, {
      method: 'PUT', cookie: editor.cookie,
      headers: { 'Content-Type': 'application/octet-stream' }, rawBody: Buffer.from('image'),
    });
    assert.equal(uploaded.status, 201);
  }
  const created = await f.request('/api/processing', { method: 'POST', cookie: editor.cookie,
    body: { captureId: source.id, engine: 'meshroom', name: 'Test wall' } });
  assert.equal(created.status, 202);
  const job = await created.json();
  const worker = (route, { lease, method = "GET" } = {}) => fetch(`${f.baseURL}/api/processing/worker${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${f.config.boltWorkerToken}`,
      ...(lease ? { "X-Worker-Lease": lease } : {}),
    },
  });
  assert.equal((await worker("/next?role=reconstruction&engine=odm")).status, 204);
  const reconstruction = await (await worker("/next?role=reconstruction&engine=meshroom")).json();
  assert.equal(reconstruction.id, job.id);
  assert.equal(reconstruction.phase, "reconstruction");
  await mkdir(reconstruction.workPath, { recursive: true });
  await writeFile(path.join(reconstruction.workPath, "model.glb"), "reconstructed model");
  await writeFile(path.join(reconstruction.workPath, "cameras.json"), JSON.stringify({ cameras: {}, shots: {} }));
  await writeFile(path.join(reconstruction.workPath, "artifact.json"), JSON.stringify({
    version: 1, engine: "meshroom", model: "model.glb", detectionMesh: "model.glb",
    reconstruction: "cameras.json", coordinateSystem: "Y_UP", names: { "a.jpg": "image_000000.jpg", "b.jpg": "image_000001.jpg" },
  }));
  const handedOff = await worker(`/${job.id}/reconstructed`, { method: "POST", lease: reconstruction.leaseToken });
  assert.equal(handedOff.status, 200, await handedOff.clone().text());
  assert.equal((await handedOff.json()).phase, "detection");
  const detection = await (await worker("/next?role=detection")).json();
  assert.equal(detection.id, job.id);
  assert.equal(detection.phase, "detection");
  assert.ok(!detection.outputAbsolutePath.startsWith(f.dataDir + path.sep));
  const publicPath = `/api/fs/${detection.entryPath}`;
  assert.equal((await f.request(`${publicPath}/model.glb`)).status, 404);
  await mkdir(detection.outputAbsolutePath, { recursive: true });
  const modelDocument = new Document(), modelBuffer = modelDocument.createBuffer();
  const positions = modelDocument.createAccessor().setType('VEC3').setBuffer(modelBuffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  modelDocument.createScene().addChild(modelDocument.createNode().setMesh(modelDocument.createMesh()
    .addPrimitive(modelDocument.createPrimitive().setAttribute('POSITION', positions))));
  const modelBytes = Buffer.from(await new NodeIO().writeBinary(modelDocument));
  await writeFile(path.join(detection.outputAbsolutePath, "model.glb"), modelBytes);
  await writeFile(path.join(detection.outputAbsolutePath, "project.json"), JSON.stringify({ name: "Test wall", hits: [], cameras: {}, coordinateSystem: "Y_UP" }));
  await expectCode(await worker(`/${job.id}/complete`, { method: "POST", lease: reconstruction.leaseToken }), 409, "STALE_WORKER_LEASE");
  const completed = await worker(`/${job.id}/complete`, { method: "POST", lease: detection.leaseToken });
  assert.equal(completed.status, 200, await completed.clone().text());
  assert.equal((await completed.json()).status, "completed");
  assert.equal((await f.request(`${publicPath}/model.glb`)).status, 404);
  const result = await f.request(`/api/processing/${job.id}/results`, { cookie: editor.cookie });
  assert.equal(result.status, 200);
  const resultManifest = await result.json();
  assert.equal(resultManifest.processingId, job.id);
  assert.ok(resultManifest.files.some((file) => file.path === 'model.glb'));
  const fileUrl = `/api/processing/${job.id}/results/files?path=model.glb`;
  await expectCode(await f.request(fileUrl), 401, 'AUTH_REQUIRED');
  assert.deepEqual(Buffer.from(await (await f.request(fileUrl, { cookie: editor.cookie })).arrayBuffer()), modelBytes);
  assert.equal((await f.request(fileUrl, { method: 'PUT', cookie: editor.cookie,
    headers: { 'Content-Type': 'application/octet-stream' }, rawBody: 'edit' })).status, 404);
  // Studio owns the edited bundle and publishes with ordinary filesystem writes.
  const published = await f.request(`${publicPath}/model.glb`, { method: 'PUT', cookie: editor.cookie,
    headers: { 'Content-Type': 'application/octet-stream' }, rawBody: modelBytes });
  assert.equal(published.status, 200);
  assert.equal((await f.request(`${publicPath}/models.json`, { method: 'PUT', cookie: editor.cookie,
    body: { type: 'Feature', properties: { id: 'models', name: 'Models', kind: 'sector' },
      geometry: { type: 'Point', coordinates: [16, 48] } } })).status, 200);
  assert.deepEqual(Buffer.from(await (await f.request(`${publicPath}/model.glb`)).arrayBuffer()), modelBytes);
  const manifest = await (await f.request('/api/fs/manifest.json')).json();
  assert.equal(manifest[0].path, 'models');
  assert.match(manifest[0].hash, /^[a-f0-9]{64}$/);
  const listing = await (await f.request('/api/fs?recursive=true')).json();
  assert.ok(listing.every((entry) => !entry.path.startsWith('.')));
});

test("uploaded documents are sandboxed while public assets remain readable", async (t) => {
  const f = await fixture(t);
  const editor = await f.seed();
  const html = "<script>fetch('/api/auth/get-session')</script>";
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  // Seed HTML as existing content; upload SVG as editor-controlled content.
  await writeFile(path.join(f.dataDir, "existing.html"), html);
  const upload = await f.request("/api/fs/upload.svg", {
    method: "PUT",
    cookie: editor.cookie,
    rawBody: svg,
    headers: { "Content-Type": "image/svg+xml" },
  });
  assert.equal(upload.status, 200);
  for (const [file, content, mime] of [
    ["existing.html", html, "text/html"],
    ["upload.svg", svg, "image/svg+xml"],
    ["public.txt", "public content", "text/plain"],
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await f.request(`/api/fs/${file}`, {
        method,
        headers: { Origin: "https://public.example" },
      });
      assert.equal(response.status, 200);
      const policy = response.headers.get("content-security-policy");
      assert.match(policy, /(?:^|;)\s*sandbox\s*(?:;|$)/);
      assert.doesNotMatch(policy, /allow-scripts|allow-same-origin/);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.ok(response.headers.get("content-type").startsWith(mime));
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal(await response.text(), method === "GET" ? content : "");
    }
  }
});

test("signup is closed, wrong passwords fail, logout invalidates sessions", async (t) => {
  const f = await fixture(t);
  const user = await f.seed();
  assert.equal(user.response.status, 200);
  assert.equal(
    (
      await (
        await f.request("/api/auth/get-session", { cookie: user.cookie })
      ).json()
    ).user.id,
    user.id,
  );
  const wrong = await f.request("/api/auth/sign-in/email", {
    method: "POST",
    body: { email: user.email, password: "Incorrect password!" },
  });
  assert.ok(wrong.status >= 400);
  const signup = await f.request("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Self signup", email: "signup@example.test", password },
  });
  assert.ok(signup.status >= 400);
  assert.equal(
    (
      await f.request("/api/auth/sign-out", {
        method: "POST",
        cookie: user.cookie,
        body: {},
      })
    ).status,
    200,
  );
  await expectCode(
    await f.request("/api/fs/public.txt", {
      method: "DELETE",
      cookie: user.cookie,
    }),
    401,
    "AUTH_REQUIRED",
  );
});

test("local provisioning validates credentials, hashes passwords and rejects duplicates", async (t) => {
  const f = await fixture(t);
  const body = { name: "Editor", email: "EDITOR@example.test", password };
  for (const patch of [
    { name: " " },
    { email: "invalid" },
    { password: "short" },
  ])
    await assert.rejects(createUser(f.config, { ...body, ...patch }));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM user").get().n, 0);
  const user = await createUser(f.config, body);
  assert.equal(user.email, "editor@example.test");
  const account = f.db
    .prepare("SELECT password FROM account WHERE userId=?")
    .get(user.id);
  assert.ok(account.password);
  assert.notEqual(account.password, password);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM session").get().n, 0);
  await assert.rejects(
    createUser(f.config, {
      ...body,
      email: "editor@example.test",
      password: "A different password!",
    }),
    /already exists/,
  );
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM user").get().n, 1);
  assert.equal(
    f.db.prepare("SELECT password FROM account WHERE userId=?").get(user.id)
      .password,
    account.password,
  );
});

test("provisioned users and sessions survive restart and allow every content mutation", async (t) => {
  const f = await fixture(t);
  const user = await f.seed();
  await f.restart();
  const current = await f.request("/api/auth/get-session", {
    cookie: user.cookie,
  });
  assert.equal((await current.json()).user.id, user.id);
  for (const [route, init] of [
    ["/api/fs/note.json", { method: "PUT", body: { note: "saved" } }],
    [
      "/api/fs/note.json",
      { method: "MOVE", headers: { Destination: "/renamed.json" } },
    ],
    ["/api/fs/renamed.json", { method: "DELETE" }],
  ]) {
    const response = await f.request(route, { ...init, cookie: user.cookie });
    assert.equal(response.status, 200, await response.text());
  }
  const login = await f.request("/api/auth/sign-in/email", {
    method: "POST",
    body: { email: user.email, password },
  });
  assert.equal(login.status, 200);
});

test("HTTP exposes only login, logout and session lookup, including for authenticated users", async (t) => {
  const f = await fixture(t);
  const user = await f.seed();
  for (const cookie of [undefined, user.cookie]) {
    for (const route of [
      "/sign-up/email",
      "/admin/create-user",
      "/update-user",
      "/request-password-reset",
      "/reset-password",
      "/change-password",
    ]) {
      assert.equal(
        (
          await f.request(`/api/auth${route}`, {
            method: "POST",
            cookie,
            body: { name: "Uninvited", email: "new@example.test", password },
          })
        ).status,
        404,
      );
    }
    assert.equal((await f.request("/api/admin/users", { cookie })).status, 404);
    assert.equal(
      (
        await f.request("/api/admin/invitations", {
          method: "POST",
          cookie,
          body: {},
        })
      ).status,
      404,
    );
  }
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM user").get().n, 1);
});

test("content writes forward refreshed session cookies", async (t) => {
  const f = await fixture(t);
  const user = await f.seed();
  f.db
    .prepare("UPDATE session SET expiresAt=? WHERE userId=?")
    .run(Date.now() + 5 * 86400000, user.id);
  const response = await f.request("/api/fs/refreshed.txt", {
    method: "PUT",
    cookie: user.cookie,
    rawBody: "saved",
    headers: { "Content-Type": "text/plain" },
  });
  assert.equal(response.status, 200);
  assert.ok(response.headers.getSetCookie().length > 0);
});

test("legacy accounts cannot silently acquire editing access", async (t) => {
  const f = await fixture(t);
  const user = await f.seed();
  f.db.exec(
    "ALTER TABLE user ADD COLUMN invitationAccepted INTEGER NOT NULL DEFAULT 0",
  );
  assert.throws(() => createApp(f.config), /Legacy account database/);
  assert.ok(f.db.prepare("SELECT id FROM user WHERE id=?").get(user.id));
});

test("auth database cannot resolve through a symlink into public content", async (t) => {
  const f = await fixture(t);
  const link = path.join(f.directory, "content-link");
  await symlink(f.dataDir, link);
  assert.throws(
    () =>
      createApp({ ...f.config, databasePath: path.join(link, "auth.sqlite") }),
    /outside content/,
  );
});

test("application mutations validate missing and untrusted origins; preflight is explicit", async (t) => {
  const f = await fixture(t);
  const editor = await f.seed();
  for (const value of ["", "https://attacker.example"]) {
    await expectCode(
      await f.request("/api/fs/public.txt", {
        method: "DELETE",
        cookie: editor.cookie,
        headers: { Origin: value },
      }),
      403,
      "ORIGIN_NOT_ALLOWED",
    );
  }
  const allowed = await f.request("/api/fs/public.txt", {
    method: "OPTIONS",
    headers: {
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(allowed.headers.get("access-control-allow-origin"), origin);
  assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
  const rejected = await f.request("/api/admin/users", {
    method: "OPTIONS",
    headers: {
      Origin: "https://attacker.example",
      "Access-Control-Request-Method": "GET",
    },
  });
  assert.notEqual(
    rejected.headers.get("access-control-allow-origin"),
    "https://attacker.example",
  );
});

test("path containment rejects encoded traversal, symlinks and root mutations", async (t) => {
  const f = await fixture(t);
  const editor = await f.seed();
  await writeFile(path.join(f.directory, "secret.txt"), "private");
  await symlink(f.directory, path.join(f.dataDir, "escape"));
  for (const route of [
    "/api/fs/escape/secret.txt",
    "/api/fs/%2e%2e%2fsecret.txt",
  ]) {
    const response = await f.request(route);
    assert.ok(response.status >= 400, route);
  }
  for (const method of ["DELETE", "MOVE"]) {
    const response = await f.request("/api/fs/", {
      method,
      cookie: editor.cookie,
      headers: { Destination: "/renamed-root" },
    });
    assert.ok(response.status >= 400);
  }
  for (const destination of ["/", "/../outside.txt", "/escape/new.txt"]) {
    const response = await f.request("/api/fs/public.txt", {
      method: "MOVE",
      cookie: editor.cookie,
      headers: { Destination: destination },
    });
    assert.ok(response.status >= 400, destination);
  }
  assert.equal(
    await readFile(path.join(f.dataDir, "public.txt"), "utf8"),
    "public content",
  );
});

test("expired database sessions immediately lose mutation access", async (t) => {
  const f = await fixture(t);
  const editor = await f.seed();
  f.db.prepare("UPDATE session SET expiresAt=0 WHERE userId=?").run(editor.id);
  await expectCode(
    await f.request("/api/fs/public.txt", {
      method: "DELETE",
      cookie: editor.cookie,
    }),
    401,
    "AUTH_REQUIRED",
  );
});

test("unauthorized uploads are rejected before the declared body arrives", async (t) => {
  const f = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const upload = httpRequest(
      `${f.baseURL}/api/fs/huge.glb`,
      {
        method: "PUT",
        headers: {
          Origin: origin,
          "Content-Type": "application/octet-stream",
          "Content-Length": 100_000_000,
        },
      },
      (response) => {
        resolve(response.statusCode);
        response.resume();
        upload.destroy();
      },
    );
    upload.setTimeout(2000, () => {
      upload.destroy();
      reject(new Error("server waited for unauthenticated upload body"));
    });
    upload.on("error", reject);
    upload.flushHeaders();
  });
  assert.equal(status, 401);
});

test("JSON validation, image processing, GLB processing and hashes remain functional", async (t) => {
  const f = await fixture(t);
  const editor = await f.seed();
  const invalid = await f.request("/api/fs/crag/crag.json", {
    method: "PUT",
    cookie: editor.cookie,
    body: { invalid: true },
  });
  assert.equal(invalid.status, 400);
  const rawInvalid = await f.request("/api/fs/crag/crag.json", {
    method: "PUT",
    cookie: editor.cookie,
    rawBody: Buffer.from('{"invalid":true}'),
    headers: { "Content-Type": "application/octet-stream" },
  });
  assert.equal(
    rawInvalid.status,
    400,
    "raw JSON uploads must not bypass schema validation",
  );
  const crag = {
    type: "Feature",
    properties: { id: "crag", name: "Test Crag", kind: "crag" },
    geometry: { type: "Point", coordinates: [16, 48] },
  };
  assert.equal(
    (
      await f.request("/api/fs/crag/crag.json", {
        method: "PUT",
        cookie: editor.cookie,
        body: crag,
      })
    ).status,
    200,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(f.dataDir, "crag/crag.json"), "utf8")),
    crag,
  );
  const sharp = (await import("sharp")).default;
  const png = await sharp({
    create: { width: 2000, height: 10, channels: 3, background: "#ff0000" },
  })
    .png()
    .toBuffer();
  const image = await f.request("/api/fs/assets/photo.png", {
    method: "PUT",
    cookie: editor.cookie,
    rawBody: png,
    headers: { "Content-Type": "image/png" },
  });
  assert.equal(image.status, 200);
  assert.equal(
    (
      await sharp(
        await readFile(path.join(f.dataDir, "assets/photo.png")),
      ).metadata()
    ).width,
    1920,
  );
  const model = await f.request("/api/fs/assets/model.glb", {
    method: "PUT",
    cookie: editor.cookie,
    rawBody: Buffer.from("test model data"),
    headers: { "Content-Type": "model/gltf-binary" },
  });
  assert.equal(model.status, 200);
  const firstDownload = await f.request('/api/fs/assets/model.glb');
  assert.equal(firstDownload.headers.get('cache-control'), 'public, no-cache');
  const etag = firstDownload.headers.get('etag');
  assert.ok(etag);
  await writeFile(path.join(f.dataDir, 'assets/model.glb'), 'updated model material data');
  const updatedDownload = await f.request('/api/fs/assets/model.glb', {
    headers: { 'If-None-Match': etag }
  });
  assert.equal(updatedDownload.status, 200);
  assert.equal(await updatedDownload.text(), 'updated model material data');
  assert.equal(f.optimized.length, 1);
  assert.match(
    await readFile(path.join(f.dataDir, "assets/hash.txt"), "utf8"),
    /^[a-f0-9]{64}$/,
  );
  const manifest = JSON.parse(
    await readFile(path.join(f.dataDir, "manifest.json"), "utf8"),
  );
  assert.ok(Array.isArray(manifest));
  assert.ok(
    manifest.some((entry) => entry.id === "crag" && entry.name === "Test Crag"),
  );
});

test('an active capture upload does not block unrelated content writes', async (t) => {
  const f = await fixture(t), editor = await f.seed();
  const capture = await (await f.request('/api/captures', { method: 'POST', cookie: editor.cookie,
    body: { name: 'Slow survey', entryPath: 'wall' } })).json();
  const directory = path.join(path.dirname(f.config.databasePath), 'captures', 'wall', `Slow survey--${capture.id}`);
  let request;
  const uploading = new Promise((resolve, reject) => {
    request = httpRequest(`${f.baseURL}/api/captures/${capture.id}/files?path=video.mp4`, {
      method: 'PUT', headers: { Origin: origin, Cookie: editor.cookie,
        'Content-Type': 'application/octet-stream', 'Content-Length': '10' },
    }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.write('first');
  });
  try {
    let started = false;
    for (let attempts = 0; attempts < 100; attempts++) {
      if ((await readdir(directory)).some((name) => name.endsWith('.upload'))) { started = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(started, 'capture upload is streaming');
    const written = await f.request('/api/fs/unrelated.txt', { method: 'PUT', cookie: editor.cookie,
      headers: { 'Content-Type': 'application/octet-stream' }, rawBody: 'published', signal: AbortSignal.timeout(2000) });
    assert.equal(written.status, 200);
    assert.equal(await readFile(path.join(f.dataDir, 'unrelated.txt'), 'utf8'), 'published');
  } finally { request.end('last!'); await uploading; }
});

test('only capture and processing routes expose the new pipeline', async (t) => {
  const f = await fixture(t), editor = await f.seed();
  for (const route of ['/api/sources', '/api/bolt-jobs', '/api/entries']) {
    assert.equal((await f.request(route, { cookie: editor.cookie })).status, 404);
  }
  const capture = await (await f.request('/api/captures', { method: 'POST', cookie: editor.cookie,
    body: { name: 'Survey', entryPath: 'wall' } })).json();
  assert.equal((await f.request(`/api/captures/${capture.id}/complete`, { method: 'POST', cookie: editor.cookie })).status, 404);
  const job = await (await f.request('/api/processing', { method: 'POST', cookie: editor.cookie,
    body: { captureId: capture.id } })).json();
  assert.equal(job.status, 'queued');
  await expectCode(await f.request('/api/processing', { method: 'POST', cookie: editor.cookie,
    body: { sourceId: capture.id } }), 400, 'CAPTURE_REQUIRED');
});
