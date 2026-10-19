import path from "node:path";
import { fileURLToPath } from "node:url";
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const studioURL = env.STUDIO_URL || "https://studio.felsverzeichnis.at";
  const trustedOrigins = (env.TRUSTED_ORIGINS || studioURL)
    .split(",")
    .map((s) => s.trim());
  const config = {
    production,
    port: Number(env.PORT || 3001),
    dataDir: path.resolve(
      env.DATA_DIR || fileURLToPath(new URL("./data", import.meta.url)),
    ),
    databasePath: env.AUTH_DATABASE_PATH,
    reviewDir: env.REVIEW_DIR ? path.resolve(env.REVIEW_DIR) : undefined,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL || "https://lager.felsverzeichnis.at/api/auth",
    studioURL,
    trustedOrigins,
    trustProxy: env.TRUST_PROXY
      ? env.TRUST_PROXY.split(",").map((s) => s.trim())
      : false,
  };
  validateConfig(config);
  return config;
}
export function validateConfig(c) {
  if (!c.secret || c.secret.length < 32)
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  if (
    !c.databasePath ||
    c.databasePath === ":memory:" ||
    !path.isAbsolute(c.databasePath)
  )
    throw new Error("AUTH_DATABASE_PATH must be a persistent file path");
  const origin = (value) => {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      throw new Error("Invalid URL");
    if (
      c.production &&
      (u.protocol !== "https:" ||
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    )
      throw new Error("Production requires HTTPS origins");
    return u;
  };
  origin(c.baseURL);
  origin(c.studioURL);
  if (!Array.isArray(c.trustedOrigins) || !c.trustedOrigins.length)
    throw new Error("Explicit trusted origins are required");
  for (const o of c.trustedOrigins)
    if (origin(o).origin !== o)
      throw new Error("Trusted origins must be exact origins");
  if (!c.trustedOrigins.includes(new URL(c.studioURL).origin))
    throw new Error("Studio origin must be trusted");
  for (const [root, label] of [
    [fileURLToPath(new URL(".", import.meta.url)), "deployment checkout"],
    [c.dataDir, "public content directory"],
  ]) {
    const relative = path.relative(path.resolve(root), path.resolve(c.databasePath));
    if (
      !relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative)
    )
      throw new Error(`Auth storage must be outside the ${label}`);
  }
}
