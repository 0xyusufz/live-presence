import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { createDatabase } from "../db/index.js";
import { users } from "../db/schema.js";
import { ViewerAuthorizationService } from "../authorization/service.js";
import { resolveDatabasePath, SERVER_ROOT } from "../config.js";
import { AccessCommandError, executeAccessCommand } from "./access.js";

function fixture(): {
  databasePath: string;
  close: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "live-presence-access-cli-"));
  const databasePath = join(directory, "test.sqlite");
  const database = createDatabase(databasePath);
  database.db.insert(users).values([
    { id: "owner-id", email: "owner@example.com", createdAt: Date.now() },
    { id: "viewer-id", email: "viewer@example.com", createdAt: Date.now() },
  ]).run();
  database.close();
  return {
    databasePath,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const grantArgs = [
  "--owner-email", "OWNER@example.com",
  "--viewer-email", "viewer@example.com",
];

function canAccess(databasePath: string): boolean {
  const database = createDatabase(databasePath);
  try {
    return new ViewerAuthorizationService(database.db).canAccess("owner-id", "viewer-id");
  } finally {
    database.close();
  }
}

test("CLI grants and revokes the existing owner/viewer permission", () => {
  const testFixture = fixture();
  try {
    const granted = executeAccessCommand("grant", grantArgs, testFixture.databasePath);
    assert.equal(granted, "Granted viewer access from owner@example.com to viewer@example.com.");
    assert.equal(canAccess(testFixture.databasePath), true);

    const revoked = executeAccessCommand("revoke", grantArgs, testFixture.databasePath);
    assert.equal(revoked, "Revoked viewer access from owner@example.com to viewer@example.com.");
    assert.equal(canAccess(testFixture.databasePath), false);
  } finally {
    testFixture.close();
  }
});

test("CLI reports unknown owners and viewers without changing permissions", () => {
  const testFixture = fixture();
  try {
    assert.throws(
      () => executeAccessCommand("grant", [
        "--owner-email", "missing@example.com",
        "--viewer-email", "viewer@example.com",
      ], testFixture.databasePath),
      (error: unknown) => error instanceof AccessCommandError && /Owner user not found/.test(error.message),
    );
    assert.throws(
      () => executeAccessCommand("grant", [
        "--owner-email", "owner@example.com",
        "--viewer-email", "missing@example.com",
      ], testFixture.databasePath),
      (error: unknown) => error instanceof AccessCommandError && /Viewer user not found/.test(error.message),
    );
    assert.equal(canAccess(testFixture.databasePath), false);
  } finally {
    testFixture.close();
  }
});

test("CLI rejects self-authorization", () => {
  const testFixture = fixture();
  try {
    assert.throws(
      () => executeAccessCommand("grant", [
        "--owner-email", "owner@example.com",
        "--viewer-email", "OWNER@example.com",
      ], testFixture.databasePath),
      (error: unknown) => error instanceof AccessCommandError && /must be different/.test(error.message),
    );
    assert.equal(canAccess(testFixture.databasePath), false);
  } finally {
    testFixture.close();
  }
});

test("repeated grant fails safely and repeated revoke is idempotent", () => {
  const testFixture = fixture();
  try {
    executeAccessCommand("grant", grantArgs, testFixture.databasePath);
    assert.throws(
      () => executeAccessCommand("grant", grantArgs, testFixture.databasePath),
      /Viewer authorization already exists/,
    );
    executeAccessCommand("revoke", grantArgs, testFixture.databasePath);
    assert.doesNotThrow(
      () => executeAccessCommand("revoke", grantArgs, testFixture.databasePath),
    );
    assert.equal(canAccess(testFixture.databasePath), false);
  } finally {
    testFixture.close();
  }
});

test("CLI rejects malformed and incomplete arguments", () => {
  assert.throws(
    () => executeAccessCommand("grant", ["--owner-email", "not-an-email", "--viewer-email", "viewer@example.com"], ":memory:"),
    /Invalid email address/,
  );
  assert.throws(
    () => executeAccessCommand("grant", ["--owner-email", "owner@example.com"], ":memory:"),
    /Expected --owner-email/,
  );
  assert.throws(
    () => executeAccessCommand("grant", grantArgs, ":memory:"),
    /persistent DATABASE_PATH is required/,
  );
  assert.throws(
    () => executeAccessCommand("grant", [...grantArgs, "--unexpected", "value"], "/unused"),
    /Expected --owner-email/,
  );
});

test("CLI refuses to create a database at an incorrect or missing path", () => {
  const directory = mkdtempSync(join(tmpdir(), "live-presence-access-cli-empty-"));
  const missingDatabasePath = join(directory, "missing.sqlite");
  try {
    assert.throws(
      () => executeAccessCommand("grant", grantArgs, missingDatabasePath),
      /refusing to create a new database/,
    );
    assert.equal(existsSync(missingDatabasePath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("database path resolution uses the server root for relative paths", () => {
  assert.equal(SERVER_ROOT, resolve(__dirname, "../.."));
  assert.equal(
    resolveDatabasePath("data/live-presence.db"),
    resolve(SERVER_ROOT, "data/live-presence.db"),
  );
  assert.equal(
    resolveDatabasePath("/tmp/live-presence-absolute.db"),
    "/tmp/live-presence-absolute.db",
  );
  assert.equal(resolveDatabasePath(":memory:"), ":memory:");
});

test("CLI entry point uses the server database path from another working directory", () => {
  const testFixture = fixture();
  const invocationDirectory = mkdtempSync(join(tmpdir(), "live-presence-cli-cwd-"));
  try {
    const databasePathFromServerRoot = relative(SERVER_ROOT, testFixture.databasePath);
    const result = spawnSync(process.execPath, [
      `--env-file-if-exists=${resolve(SERVER_ROOT, "../.env")}`,
      `--import=${resolve(SERVER_ROOT, "../node_modules/tsx/dist/loader.mjs")}`,
      resolve(SERVER_ROOT, "src/cli/access-main.ts"),
      "grant",
      "--owner-email", "owner@example.com",
      "--viewer-email", "viewer@example.com",
    ], {
      cwd: invocationDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_PATH: databasePathFromServerRoot,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Granted viewer access/);
    assert.equal(canAccess(testFixture.databasePath), true);
  } finally {
    rmSync(invocationDirectory, { recursive: true, force: true });
    testFixture.close();
  }
});
