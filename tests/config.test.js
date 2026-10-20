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

test('capture and processing storage paths and video upload limits are configurable', () => {
  const loaded = loadConfig({ BETTER_AUTH_SECRET: config().secret, AUTH_DATABASE_PATH: config().databasePath,
    CAPTURE_DIR: '/srv/captures', PROCESSING_DIR: '/srv/processing', CAPTURE_MAX_FILE_BYTES: '1024',
    CAPTURE_MAX_DATASET_BYTES: '4096' });
  assert.equal(loaded.captureDir, '/srv/captures');
  assert.equal(loaded.processingDir, '/srv/processing');
  assert.equal(loaded.captureMaxFileBytes, 1024);
  assert.equal(loaded.captureMaxDatasetBytes, 4096);
  for (const value of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => validateConfig({ ...config(), captureMaxFileBytes: value }), /CAPTURE_MAX_FILE_BYTES/);
});

test('capture dataset budgets are positive safe integers and configurable', () => {
  for (const captureMaxDatasetBytes of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => validateConfig({ ...config(), captureMaxDatasetBytes }), /CAPTURE_MAX_DATASET_BYTES/);
  assert.doesNotThrow(() => validateConfig({ ...config(), captureMaxDatasetBytes: 1024 }));
  const loaded = loadConfig({ BETTER_AUTH_SECRET: config().secret, AUTH_DATABASE_PATH: config().databasePath,
    CAPTURE_DIR: '/srv/surveys', CAPTURE_MAX_DATASET_BYTES: '2048' });
  assert.equal(loaded.captureDir, '/srv/surveys');
  assert.equal(loaded.captureMaxDatasetBytes, 2048);
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

test("Prefect API defaults to the local server and accepts another address", () => {
  const env = { BETTER_AUTH_SECRET: config().secret, AUTH_DATABASE_PATH: config().databasePath };
  assert.equal(loadConfig(env).prefectApiUrl, 'http://127.0.0.1:4200/api');
  assert.equal(loadConfig({ ...env, PREFECT_API_URL: 'http://prefect:4200/api' }).prefectApiUrl, 'http://prefect:4200/api');
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
