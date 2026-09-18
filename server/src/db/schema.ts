import {
  integer,
  sqliteTable,
  text,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (table) => ({
    emailIndex: uniqueIndex("users_email_idx").on(table.email),
  }),
);

export const authTokens = sqliteTable(
  "auth_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "number" }),
  },
  (table) => ({
    tokenHashIndex: index("auth_tokens_token_hash_idx").on(table.tokenHash),
  }),
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "number" }),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (table) => ({
    tokenHashIndex: index("sessions_token_hash_idx").on(table.tokenHash),
  }),
);

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  platform: text("platform").notNull(),
  revokedAt: integer("revoked_at", { mode: "number" }),
  lastSeenAt: integer("last_seen_at", { mode: "number" }),
});

export const viewerPermissions = sqliteTable(
  "viewer_permissions",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    viewerUserId: text("viewer_user_id")
      .notNull()
      .references(() => users.id),
    revokedAt: integer("revoked_at", { mode: "number" }),
  },
  (table) => ({
    ownerViewerIndex: index("viewer_permissions_owner_viewer_idx").on(
      table.ownerUserId,
      table.viewerUserId,
    ),
    viewerOwnerIndex: index("viewer_permissions_viewer_owner_idx").on(
      table.viewerUserId,
      table.ownerUserId,
    ),
  }),
);

export const deviceCredentials = sqliteTable(
  "device_credentials",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    familyId: text("family_id").notNull(),
    revokedAt: integer("revoked_at", { mode: "number" }),
  },
  (table) => ({
    refreshTokenHashIndex: index("device_credentials_refresh_token_hash_idx").on(
      table.refreshTokenHash,
    ),
    familyIndex: index("device_credentials_family_idx").on(table.familyId),
  }),
);
