import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDatabase } from "../db/index.js";
import {
  devices,
  presenceAuthorizationBindings,
  presenceRevocationOutbox,
  presenceRevocationTombstones,
  users,
  viewerPermissions,
} from "../db/schema.js";
import {
  AuthorizationError,
  ViewerAuthorizationService,
} from "./service.js";

function addUser(
  database: ReturnType<typeof createDatabase>,
  id: string,
): void {
  database.db
    .insert(users)
    .values({ id, email: `${id}@example.com`, createdAt: Date.now() })
    .run();
}

test("viewer authorization is directional, revocable, and re-grantable", () => {
  const database = createDatabase(":memory:");
  try {
    addUser(database, "owner");
    addUser(database, "viewer");
    addUser(database, "other");
    const authorization = new ViewerAuthorizationService(database.db);

    const permissionId = authorization.grant("owner", "viewer");
    assert.equal(authorization.canAccess("owner", "viewer"), true);
    assert.equal(authorization.canAccess("viewer", "owner"), false);
    assert.equal(authorization.canAccess("owner", "other"), false);
    assert.throws(
      () => authorization.grant("owner", "viewer"),
      AuthorizationError,
    );

    authorization.revoke("owner", "viewer");
    assert.equal(authorization.canAccess("owner", "viewer"), false);
    assert.equal(authorization.canAccess("viewer", "owner"), false);
    assert.equal(authorization.grant("owner", "viewer"), permissionId);
    assert.equal(authorization.canAccess("owner", "viewer"), true);
  } finally {
    database.close();
  }
});

test("invalid users and self-authorization fail without creating rows", () => {
  const database = createDatabase(":memory:");
  try {
    addUser(database, "owner");
    const authorization = new ViewerAuthorizationService(database.db);
    assert.throws(
      () => authorization.grant("owner", "missing"),
      AuthorizationError,
    );
    assert.throws(
      () => authorization.grant("owner", "owner"),
      AuthorizationError,
    );
    assert.equal(authorization.canAccess("owner", "missing"), false);
  } finally {
    database.close();
  }
});

test("revocation atomically rolls back permission and binding changes if outbox persistence fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "live-presence-revocation-atomic-"));
  const databasePath = join(directory, "test.sqlite");
  const database = createDatabase(databasePath);
  try {
    addUser(database, "owner");
    addUser(database, "viewer");
    database.db.insert(devices).values({
      id: "owner-device",
      userId: "owner",
      name: "Desktop",
      platform: "macOS",
      revokedAt: null,
      lastSeenAt: null,
    }).run();
    const authorization = new ViewerAuthorizationService(database.db);
    authorization.grant("owner", "viewer");
    database.db.insert(presenceAuthorizationBindings).values({
      ownerUserId: "owner",
      deviceId: "owner-device",
      viewerUserId: "viewer",
      sessionId: "session-atomic",
    }).run();

    const raw = new Database(databasePath);
    raw.exec(`
      CREATE TRIGGER reject_revocation_outbox
      BEFORE INSERT ON presence_revocation_outbox
      BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END;
    `);
    raw.close();

    assert.throws(() => authorization.revoke("owner", "viewer"), /outbox unavailable/);
    assert.equal(authorization.canAccess("owner", "viewer"), true);
    assert.equal(
      database.db.select().from(presenceAuthorizationBindings).all().length,
      1,
    );
    assert.equal(
      database.db.select().from(presenceRevocationTombstones).all().length,
      0,
    );
    assert.equal(
      database.db.select().from(presenceRevocationOutbox).all().length,
      0,
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("capacity exhaustion retains unresolved revocations and rejects new authorization", () => {
  const database = createDatabase(":memory:", 1);
  try {
    addUser(database, "owner");
    addUser(database, "viewer");
    addUser(database, "next-viewer");
    database.db.insert(devices).values({
      id: "owner-device",
      userId: "owner",
      name: "Desktop",
      platform: "macOS",
      revokedAt: null,
      lastSeenAt: null,
    }).run();
    const authorization = new ViewerAuthorizationService(database.db);
    authorization.grant("owner", "viewer");
    database.db.insert(presenceAuthorizationBindings).values({
      ownerUserId: "owner",
      deviceId: "owner-device",
      viewerUserId: "viewer",
      sessionId: "session-capacity",
    }).run();

    authorization.revoke("owner", "viewer");
    assert.equal(database.db.select().from(presenceAuthorizationBindings).all().length, 0);
    assert.equal(database.db.select().from(presenceRevocationTombstones).all().length, 1);
    assert.equal(database.db.select().from(presenceRevocationOutbox).all().length, 1);
    assert.throws(
      () => authorization.grant("owner", "next-viewer"),
      /Presence revocation capacity is full/,
    );
    assert.equal(database.db.select().from(presenceRevocationTombstones).all().length, 1);
    assert.equal(database.db.select().from(presenceRevocationOutbox).all().length, 1);
  } finally {
    database.close();
  }
});

test("database startup migrates previously revoked bindings into durable outbox records", () => {
  const directory = mkdtempSync(join(tmpdir(), "live-presence-revocation-migration-"));
  const databasePath = join(directory, "test.sqlite");
  let database = createDatabase(databasePath);
  try {
    addUser(database, "owner");
    addUser(database, "viewer");
    database.db.insert(devices).values({
      id: "owner-device",
      userId: "owner",
      name: "Desktop",
      platform: "macOS",
      revokedAt: null,
      lastSeenAt: null,
    }).run();
    const authorization = new ViewerAuthorizationService(database.db);
    authorization.grant("owner", "viewer");
    database.db.insert(presenceAuthorizationBindings).values({
      ownerUserId: "owner",
      deviceId: "owner-device",
      viewerUserId: "viewer",
      sessionId: "session-legacy-revocation",
    }).run();
    database.db.update(viewerPermissions)
      .set({ revokedAt: Date.now() })
      .run();
    database.close();

    database = createDatabase(databasePath);
    assert.equal(database.db.select().from(presenceAuthorizationBindings).all().length, 0);
    assert.deepEqual(
      database.db.select().from(presenceRevocationTombstones).all().map((entry) => ({
        sessionId: entry.sessionId,
        deviceId: entry.deviceId,
      })),
      [{ sessionId: "session-legacy-revocation", deviceId: "owner-device" }],
    );
    assert.deepEqual(
      database.db.select().from(presenceRevocationOutbox).all().map((entry) => ({
        sessionId: entry.sessionId,
        processedAt: entry.processedAt,
      })),
      [{ sessionId: "session-legacy-revocation", processedAt: null }],
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("binding fails closed when revocation commits before the binding transaction", () => {
  const database = createDatabase(":memory:");
  try {
    addUser(database, "owner");
    addUser(database, "viewer");
    database.db.insert(devices).values({
      id: "owner-device",
      userId: "owner",
      name: "Desktop",
      platform: "macOS",
      revokedAt: null,
      lastSeenAt: null,
    }).run();
    const authorization = new ViewerAuthorizationService(database.db);
    authorization.grant("owner", "viewer");
    authorization.revoke("owner", "viewer");

    assert.throws(
      () => authorization.bindAuthorizedSession(
        "owner",
        "owner-device",
        "viewer",
        "session-after-revoke",
      ),
      (error: unknown) =>
        error instanceof AuthorizationError &&
        error.message === "Viewer authorization is not active",
    );
    assert.equal(database.db.select().from(presenceAuthorizationBindings).all().length, 0);
    assert.equal(database.db.select().from(presenceRevocationTombstones).all().length, 0);
  } finally {
    database.close();
  }
});

test("revocation after binding commit creates the device-scoped tombstone", () => {
  const database = createDatabase(":memory:");
  try {
    addUser(database, "owner");
    addUser(database, "viewer");
    database.db.insert(devices).values({
      id: "owner-device",
      userId: "owner",
      name: "Desktop",
      platform: "macOS",
      revokedAt: null,
      lastSeenAt: null,
    }).run();
    const authorization = new ViewerAuthorizationService(database.db);
    authorization.grant("owner", "viewer");
    authorization.bindAuthorizedSession(
      "owner",
      "owner-device",
      "viewer",
      "session-before-revoke",
    );
    authorization.revoke("owner", "viewer");

    assert.equal(database.db.select().from(presenceAuthorizationBindings).all().length, 0);
    assert.deepEqual(
      database.db.select().from(presenceRevocationTombstones).all().map((entry) => ({
        sessionId: entry.sessionId,
        ownerUserId: entry.ownerUserId,
        deviceId: entry.deviceId,
        viewerUserId: entry.viewerUserId,
      })),
      [{
        sessionId: "session-before-revoke",
        ownerUserId: "owner",
        deviceId: "owner-device",
        viewerUserId: "viewer",
      }],
    );
    assert.equal(
      database.db.select().from(presenceRevocationOutbox).all()[0]?.sessionId,
      "session-before-revoke",
    );
  } finally {
    database.close();
  }
});

test("concurrent binding and revocation serialize without losing revocation state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "live-presence-revocation-race-"));
  const databasePath = join(directory, "test.sqlite");
  const firstDatabase = createDatabase(databasePath);
  const secondDatabase = createDatabase(databasePath);
  try {
    addUser(firstDatabase, "owner");
    addUser(firstDatabase, "viewer");
    firstDatabase.db.insert(devices).values({
      id: "owner-device",
      userId: "owner",
      name: "Desktop",
      platform: "macOS",
      revokedAt: null,
      lastSeenAt: null,
    }).run();
    const binder = new ViewerAuthorizationService(firstDatabase.db);
    const revoker = new ViewerAuthorizationService(secondDatabase.db);
    binder.grant("owner", "viewer");

    const binding = new Promise<"bound" | "rejected">((resolve, reject) => {
      setImmediate(() => {
        try {
          binder.bindAuthorizedSession(
            "owner",
            "owner-device",
            "viewer",
            "session-racing",
          );
          resolve("bound");
        } catch (error) {
          if (error instanceof AuthorizationError) resolve("rejected");
          else reject(error);
        }
      });
    });
    const revocation = new Promise<void>((resolve) => {
      setImmediate(() => {
        revoker.revoke("owner", "viewer");
        resolve();
      });
    });
    const [bindingOutcome] = await Promise.all([binding, revocation]);

    assert.equal(binder.canAccess("owner", "viewer"), false);
    const remainingBindings = firstDatabase.db.select()
      .from(presenceAuthorizationBindings)
      .all();
    const tombstones = firstDatabase.db.select()
      .from(presenceRevocationTombstones)
      .all();
    if (bindingOutcome === "bound") {
      assert.equal(remainingBindings.length, 0);
      assert.deepEqual(tombstones.map((entry) => ({
        sessionId: entry.sessionId,
        deviceId: entry.deviceId,
      })), [{ sessionId: "session-racing", deviceId: "owner-device" }]);
    } else {
      assert.equal(remainingBindings.length, 0);
      assert.equal(tombstones.length, 0);
    }
  } finally {
    firstDatabase.close();
    secondDatabase.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
