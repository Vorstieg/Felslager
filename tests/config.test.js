import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, validateConfig } from "../config.js";

const config = () => ({
  production: true,
  dataDir: "/srv/content",
  databasePath: "/srv/private/auth.sqlite",
  secret: "a-secret-longer-than-thirty-two-characters",
  baseURL: "https://lager.example.test/api/auth",
  studioURL: "https://studio.example.test",
  trustedOrigins: ["https://studio.example.test"],
  trustProxy: false,
});

test("configuration requires a persistent private database and explicit trusted HTTPS origins", () => {
  assert.doesNotThrow(() => validateConfig(config()));
  for (const patch of [
    { secret: "" },
    { databasePath: "" },
    { databasePath: ":memory:" },
    { databasePath: "/srv/content/auth.sqlite" },
    { trustedOrigins: [] },
    { trustedOrigins: ["*"] },
    { trustedOrigins: ["https://studio.example.test/path"] },
    { trustedOrigins: ["https://other.example.test"] },
    { baseURL: "http://lager.example.test/api/auth" },
    { baseURL: "https://localhost/api/auth" },
  ])
    assert.throws(
      () => validateConfig({ ...config(), ...patch }),
      JSON.stringify(patch),
    );
});

test("startup requires an auth secret and database but no SMTP", () => {
  assert.throws(() => loadConfig({}), /BETTER_AUTH_SECRET/);
  assert.doesNotThrow(() =>
    loadConfig({
      BETTER_AUTH_SECRET: config().secret,
      AUTH_DATABASE_PATH: config().databasePath,
    }),
  );
});
