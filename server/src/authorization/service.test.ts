import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase } from "../db/index.js";
import { users } from "../db/schema.js";
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
