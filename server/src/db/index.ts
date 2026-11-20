import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema.js";

export type AppDatabase = BetterSQLite3Database<typeof schema>;
export const MAX_PRESENCE_REVOCATION_RECORDS = 10_000;

function schemaSql(presenceRevocationCapacity: number): string {
  return `
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
  CREATE TABLE IF NOT EXISTS presence_authorization_bindings (
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT NOT NULL REFERENCES devices(id),
    viewer_user_id TEXT NOT NULL REFERENCES users(id),
    session_id TEXT NOT NULL,
    UNIQUE(owner_user_id, device_id, viewer_user_id)
  );
  CREATE INDEX IF NOT EXISTS presence_authorization_bindings_session_idx
    ON presence_authorization_bindings(session_id);
  CREATE TABLE IF NOT EXISTS presence_revocation_tombstones (
    session_id TEXT PRIMARY KEY NOT NULL,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT NOT NULL REFERENCES devices(id),
    viewer_user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS presence_revocation_tombstones_owner_device_idx
    ON presence_revocation_tombstones(owner_user_id, device_id);
  CREATE TABLE IF NOT EXISTS presence_revocation_outbox (
    session_id TEXT PRIMARY KEY NOT NULL
      REFERENCES presence_revocation_tombstones(session_id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT NOT NULL REFERENCES devices(id),
    viewer_user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    processed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS presence_revocation_outbox_pending_idx
    ON presence_revocation_outbox(processed_at);
  CREATE TRIGGER IF NOT EXISTS presence_authorization_bindings_capacity
    BEFORE INSERT ON presence_authorization_bindings
    WHEN
      (SELECT COUNT(*) FROM presence_authorization_bindings) +
      (SELECT COUNT(*) FROM presence_revocation_tombstones) >= ${presenceRevocationCapacity}
    BEGIN
      SELECT RAISE(ABORT, 'PRESENCE_REVOCATION_CAPACITY_EXHAUSTED');
    END;
  CREATE TRIGGER IF NOT EXISTS viewer_permissions_capacity_insert
    BEFORE INSERT ON viewer_permissions
    WHEN NEW.revoked_at IS NULL AND
      (SELECT COUNT(*) FROM presence_authorization_bindings) +
      (SELECT COUNT(*) FROM presence_revocation_tombstones) >= ${presenceRevocationCapacity}
    BEGIN
      SELECT RAISE(ABORT, 'PRESENCE_REVOCATION_CAPACITY_EXHAUSTED');
    END;
  CREATE TRIGGER IF NOT EXISTS viewer_permissions_capacity_regrant
    BEFORE UPDATE OF revoked_at ON viewer_permissions
    WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL AND
      (SELECT COUNT(*) FROM presence_authorization_bindings) +
      (SELECT COUNT(*) FROM presence_revocation_tombstones) >= ${presenceRevocationCapacity}
    BEGIN
      SELECT RAISE(ABORT, 'PRESENCE_REVOCATION_CAPACITY_EXHAUSTED');
    END;
`;
}

export function createDatabase(
  databasePath: string,
  presenceRevocationCapacity = MAX_PRESENCE_REVOCATION_RECORDS,
): {
  close: () => void;
  db: AppDatabase;
} {
  if (!Number.isSafeInteger(presenceRevocationCapacity) || presenceRevocationCapacity < 1) {
    throw new Error("Presence revocation capacity must be a positive safe integer");
  }
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.exec(schemaSql(presenceRevocationCapacity));
  sqlite.transaction(() => {
    sqlite.prepare(`
      INSERT OR IGNORE INTO presence_revocation_tombstones
        (session_id, owner_user_id, device_id, viewer_user_id, created_at)
      SELECT b.session_id, b.owner_user_id, b.device_id, b.viewer_user_id, p.revoked_at
      FROM presence_authorization_bindings b
      JOIN viewer_permissions p
        ON p.owner_user_id = b.owner_user_id AND p.viewer_user_id = b.viewer_user_id
      WHERE p.revoked_at IS NOT NULL
    `).run();
    sqlite.prepare(`
      DELETE FROM presence_authorization_bindings
      WHERE EXISTS (
        SELECT 1 FROM viewer_permissions p
        WHERE p.owner_user_id = presence_authorization_bindings.owner_user_id
          AND p.viewer_user_id = presence_authorization_bindings.viewer_user_id
          AND p.revoked_at IS NOT NULL
      )
    `).run();
    sqlite.prepare(`
      INSERT OR IGNORE INTO presence_revocation_outbox
        (session_id, owner_user_id, device_id, viewer_user_id, created_at)
      SELECT session_id, owner_user_id, device_id, viewer_user_id, created_at
      FROM presence_revocation_tombstones
    `).run();
  }).immediate();

  return {
    close: () => sqlite.close(),
    db: drizzle(sqlite, { schema }),
  };
}
