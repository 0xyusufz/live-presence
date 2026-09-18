import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema.js";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

const schemaSql = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS auth_tokens_token_hash_idx
    ON auth_tokens(token_hash);
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_token_hash_idx
    ON sessions(token_hash);
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    revoked_at INTEGER,
    last_seen_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS device_credentials (
    id TEXT PRIMARY KEY NOT NULL,
    device_id TEXT NOT NULL REFERENCES devices(id),
    refresh_token_hash TEXT NOT NULL,
    family_id TEXT NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS device_credentials_refresh_token_hash_idx
    ON device_credentials(refresh_token_hash);
  CREATE INDEX IF NOT EXISTS device_credentials_family_idx
    ON device_credentials(family_id);
  CREATE TABLE IF NOT EXISTS viewer_permissions (
    id TEXT PRIMARY KEY NOT NULL,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    viewer_user_id TEXT NOT NULL REFERENCES users(id),
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS viewer_permissions_owner_viewer_idx
    ON viewer_permissions(owner_user_id, viewer_user_id);
  CREATE INDEX IF NOT EXISTS viewer_permissions_viewer_owner_idx
    ON viewer_permissions(viewer_user_id, owner_user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS viewer_permissions_active_unique_idx
    ON viewer_permissions(owner_user_id, viewer_user_id)
    WHERE revoked_at IS NULL;
`;

export function createDatabase(databasePath: string): {
  close: () => void;
  db: AppDatabase;
} {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(schemaSql);

  return {
    close: () => sqlite.close(),
    db: drizzle(sqlite, { schema }),
  };
}
