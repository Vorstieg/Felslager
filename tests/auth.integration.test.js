import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createUser } from "../auth.js";
import { createApp } from "../index.js";

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
