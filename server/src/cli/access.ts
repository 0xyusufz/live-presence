import { eq } from "drizzle-orm";
import { statSync } from "node:fs";
import { loadConfig, resolveDatabasePath } from "../config.js";
import { createDatabase } from "../db/index.js";
import { users } from "../db/schema.js";
import { ViewerAuthorizationService } from "../authorization/service.js";

type AccessAction = "grant" | "revoke";

export class AccessCommandError extends Error {}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AccessCommandError(`Invalid email address: ${value}`);
  }
  return email;
}

export function parseAccessArguments(args: string[]): {
  ownerEmail: string;
  viewerEmail: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      (option !== "--owner-email" && option !== "--viewer-email") ||
      !value ||
      value.startsWith("--") ||
      values.has(option)
    ) {
      throw new AccessCommandError(
        "Expected --owner-email <email> and --viewer-email <email> exactly once each.",
      );
    }
    values.set(option, value);
  }

  const ownerEmail = values.get("--owner-email");
  const viewerEmail = values.get("--viewer-email");
  if (!ownerEmail || !viewerEmail || args.length !== 4) {
    throw new AccessCommandError(
      "Expected --owner-email <email> and --viewer-email <email> exactly once each.",
    );
  }
  return {
    ownerEmail: normalizeEmail(ownerEmail),
    viewerEmail: normalizeEmail(viewerEmail),
  };
}

export function executeAccessCommand(
  action: AccessAction,
  args: string[],
  databasePath: string,
): string {
  const { ownerEmail, viewerEmail } = parseAccessArguments(args);
  if (databasePath === ":memory:") {
    throw new AccessCommandError("A persistent DATABASE_PATH is required for access commands.");
  }
  const resolvedDatabasePath = resolveDatabasePath(databasePath);
  try {
    if (!statSync(resolvedDatabasePath).isFile()) {
      throw new AccessCommandError("Configured database path is not a file.");
    }
  } catch (error) {
    if (error instanceof AccessCommandError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new AccessCommandError(
        "Configured database file does not exist; refusing to create a new database.",
      );
    }
    throw error;
  }
  const database = createDatabase(resolvedDatabasePath);
  try {
    const owner = database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, ownerEmail))
      .get();
    if (!owner) throw new AccessCommandError(`Owner user not found: ${ownerEmail}`);

    const viewer = database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, viewerEmail))
      .get();
    if (!viewer) throw new AccessCommandError(`Viewer user not found: ${viewerEmail}`);
    if (owner.id === viewer.id) {
      throw new AccessCommandError("Owner and viewer must be different users.");
    }

    const authorization = new ViewerAuthorizationService(database.db);
    if (action === "grant") {
      authorization.grant(owner.id, viewer.id);
      return `Granted viewer access from ${ownerEmail} to ${viewerEmail}.`;
    }

    authorization.revoke(owner.id, viewer.id);
    return `Revoked viewer access from ${ownerEmail} to ${viewerEmail}.`;
  } finally {
    database.close();
  }
}

export function runAccessCli(args = process.argv.slice(2)): void {
  const [action, ...commandArgs] = args;
  if (action !== "grant" && action !== "revoke") {
    console.error(
      "Usage: npm --workspace server run access:<grant|revoke> -- --owner-email <email> --viewer-email <email>",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const config = loadConfig();
    console.log(executeAccessCommand(action, commandArgs, config.databasePath));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected access command error";
    console.error(`Live Presence access command failed: ${message}`);
    process.exitCode = 1;
  }
}
