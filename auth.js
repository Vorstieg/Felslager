import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig } from "./config.js";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";

export function createAuth(config, { allowSignUp = false } = {}) {
  validateConfig(config);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.databasePath), {
    recursive: true,
    mode: 0o700,
  });
  const database = fs.existsSync(config.databasePath)
    ? fs.realpathSync(config.databasePath)
    : path.join(
        fs.realpathSync(path.dirname(config.databasePath)),
        path.basename(config.databasePath),
      );
  for (const root of [
    fs.realpathSync(config.dataDir),
    fs.realpathSync(fileURLToPath(new URL(".", import.meta.url))),
  ]) {
    if (database === root || database.startsWith(root + path.sep))
      throw new Error(
        "Auth storage must be outside content and deployment checkout",
      );
  }
  const db = new Database(config.databasePath);
  try {
    fs.chmodSync(config.databasePath, 0o600);
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    // Legacy roles/pending/suspension must not silently become write access.
    const legacy = db
      .prepare("PRAGMA table_info(user)")
      .all()
      .some((c) => c.name === "invitationAccepted");
    if (legacy && db.prepare("SELECT COUNT(*) AS n FROM user").get().n > 0)
      throw new Error(
        "Legacy account database: use a new AUTH_DATABASE_PATH and provision editor accounts with npm run create-user.",
      );
    db.exec(
      fs.readFileSync(
        new URL("./migrations/001-auth.sql", import.meta.url),
        "utf8",
      ),
    );
    const auth = betterAuth({
      database: db,
      secret: config.secret,
      baseURL: config.baseURL,
      basePath: "/api/auth",
      trustedOrigins: config.trustedOrigins,
      advanced: {
        useSecureCookies: config.production,
      },
      rateLimit: { enabled: false },
      emailAndPassword: {
        enabled: true,
        // Only the local provisioning process enables signup; it never listens.
        disableSignUp: !allowSignUp,
        autoSignIn: false,
        minPasswordLength: 12,
      },
    });
    return { auth, db, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}

// Runs locally without exposing signup on the HTTP server.
export async function createUser(config, body) {
  if (!body.name?.trim()) throw new Error("A name is required");
  const service = createAuth(config, { allowSignUp: true });
  try {
    const { user } = await service.auth.api.signUpEmail({ body });
    // Better Auth deliberately returns a synthetic user for duplicate emails.
    if (!service.db.prepare("SELECT id FROM user WHERE id=?").get(user.id))
      throw new Error("An account with this email already exists");
    return user;
  } finally {
    service.close();
  }
}
