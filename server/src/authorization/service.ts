import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/index.js";
import {
  presenceAuthorizationBindings,
  presenceRevocationOutbox,
  presenceRevocationTombstones,
  devices,
  users,
  viewerPermissions,
} from "../db/schema.js";

export class AuthorizationError extends Error {}

function isCapacityError(error: unknown): boolean {
  return error instanceof Error &&
    error.message.includes("PRESENCE_REVOCATION_CAPACITY_EXHAUSTED");
}

export class ViewerAuthorizationService {
  private onRevoked?: (ownerUserId: string, viewerUserId: string) => void;
  public constructor(private readonly db: AppDatabase) {}

  public setRevocationHandler(
    handler: (ownerUserId: string, viewerUserId: string) => void,
  ): void {
    this.onRevoked = handler;
  }

  public grant(ownerUserId: string, viewerUserId: string): string {
    this.validateRelationship(ownerUserId, viewerUserId);
    try {
      return this.db.transaction((transaction) => {
        const existing = transaction
          .select({ id: viewerPermissions.id })
          .from(viewerPermissions)
          .where(
            and(
              eq(viewerPermissions.ownerUserId, ownerUserId),
              eq(viewerPermissions.viewerUserId, viewerUserId),
            ),
          )
          .get();

        if (existing) {
          if (this.isActive(existing.id)) {
            throw new AuthorizationError("Viewer authorization already exists");
          }
          transaction
            .update(viewerPermissions)
            .set({ revokedAt: null })
            .where(eq(viewerPermissions.id, existing.id))
            .run();
          return existing.id;
        }

        const id = randomUUID();
        transaction
          .insert(viewerPermissions)
          .values({
            id,
            ownerUserId,
            viewerUserId,
            revokedAt: null,
          })
          .run();
        return id;
      }, { behavior: "immediate" });
    } catch (error) {
      if (isCapacityError(error)) {
        throw new AuthorizationError(
          "Presence revocation capacity is full; acknowledge pending revocations or reduce active authorized relationships before granting access",
        );
      }
      throw error;
    }
  }

  public revoke(ownerUserId: string, viewerUserId: string): void {
    this.validateRelationship(ownerUserId, viewerUserId);
    this.db.transaction((transaction) => {
      const revokedAt = Date.now();
      transaction
        .update(viewerPermissions)
        .set({ revokedAt })
        .where(
          and(
            eq(viewerPermissions.ownerUserId, ownerUserId),
            eq(viewerPermissions.viewerUserId, viewerUserId),
            isNull(viewerPermissions.revokedAt),
          ),
        )
        .run();

      const bindings = transaction
        .select()
        .from(presenceAuthorizationBindings)
        .where(
          and(
            eq(presenceAuthorizationBindings.ownerUserId, ownerUserId),
            eq(presenceAuthorizationBindings.viewerUserId, viewerUserId),
          ),
        )
        .all();

      for (const binding of bindings) {
        transaction
          .delete(presenceAuthorizationBindings)
          .where(
            and(
              eq(presenceAuthorizationBindings.ownerUserId, binding.ownerUserId),
              eq(presenceAuthorizationBindings.deviceId, binding.deviceId),
              eq(presenceAuthorizationBindings.viewerUserId, binding.viewerUserId),
              eq(presenceAuthorizationBindings.sessionId, binding.sessionId),
            ),
          )
          .run();
        transaction
          .insert(presenceRevocationTombstones)
          .values({
            sessionId: binding.sessionId,
            ownerUserId: binding.ownerUserId,
            deviceId: binding.deviceId,
            viewerUserId: binding.viewerUserId,
            createdAt: revokedAt,
          })
          .onConflictDoNothing()
          .run();
        transaction
          .insert(presenceRevocationOutbox)
          .values({
            sessionId: binding.sessionId,
            ownerUserId: binding.ownerUserId,
            deviceId: binding.deviceId,
            viewerUserId: binding.viewerUserId,
            createdAt: revokedAt,
            processedAt: null,
          })
          .onConflictDoNothing()
          .run();
      }
    }, { behavior: "immediate" });
    this.onRevoked?.(ownerUserId, viewerUserId);
  }

  public bindAuthorizedSession(
    ownerUserId: string,
    deviceId: string,
    viewerUserId: string,
    sessionId: string,
  ): void {
    if (!ownerUserId || !deviceId || !viewerUserId || !sessionId ||
      ownerUserId === viewerUserId) {
      throw new AuthorizationError("Invalid presence authorization binding");
    }

    this.db.transaction((transaction) => {
      const ownerDevice = transaction
        .select({ id: devices.id })
        .from(devices)
        .where(and(
          eq(devices.id, deviceId),
          eq(devices.userId, ownerUserId),
          isNull(devices.revokedAt),
        ))
        .get();
      if (!ownerDevice) {
        throw new AuthorizationError("Owner device is not active");
      }

      const permission = transaction
        .select({ id: viewerPermissions.id })
        .from(viewerPermissions)
        .where(and(
          eq(viewerPermissions.ownerUserId, ownerUserId),
          eq(viewerPermissions.viewerUserId, viewerUserId),
          isNull(viewerPermissions.revokedAt),
        ))
        .get();
      if (!permission) {
        throw new AuthorizationError("Viewer authorization is not active");
      }

      const existing = transaction
        .select()
        .from(presenceAuthorizationBindings)
        .where(and(
          eq(presenceAuthorizationBindings.ownerUserId, ownerUserId),
          eq(presenceAuthorizationBindings.deviceId, deviceId),
          eq(presenceAuthorizationBindings.viewerUserId, viewerUserId),
        ))
        .get();
      if (existing) {
        transaction
          .update(presenceAuthorizationBindings)
          .set({ sessionId })
          .where(and(
            eq(presenceAuthorizationBindings.ownerUserId, ownerUserId),
            eq(presenceAuthorizationBindings.deviceId, deviceId),
            eq(presenceAuthorizationBindings.viewerUserId, viewerUserId),
          ))
          .run();
      } else {
        transaction
          .insert(presenceAuthorizationBindings)
          .values({ ownerUserId, deviceId, viewerUserId, sessionId })
          .run();
      }
    }, { behavior: "immediate" });
  }

  public canAccess(ownerUserId: string, viewerUserId: string): boolean {
    if (!ownerUserId || !viewerUserId || ownerUserId === viewerUserId) {
      return false;
    }

    return (
      this.db
        .select({ id: viewerPermissions.id })
        .from(viewerPermissions)
        .where(
          and(
            eq(viewerPermissions.ownerUserId, ownerUserId),
            eq(viewerPermissions.viewerUserId, viewerUserId),
            isNull(viewerPermissions.revokedAt),
          ),
        )
        .get() !== undefined
    );
  }

  private isActive(permissionId: string): boolean {
    return (
      this.db
        .select({ id: viewerPermissions.id })
        .from(viewerPermissions)
        .where(
          and(
            eq(viewerPermissions.id, permissionId),
            isNull(viewerPermissions.revokedAt),
          ),
        )
        .get() !== undefined
    );
  }

  private validateRelationship(ownerUserId: string, viewerUserId: string): void {
    if (
      !ownerUserId ||
      !viewerUserId ||
      ownerUserId === viewerUserId ||
      !this.userExists(ownerUserId) ||
      !this.userExists(viewerUserId)
    ) {
      throw new AuthorizationError("Invalid viewer authorization");
    }

  }

  private userExists(userId: string): boolean {
    return (
      this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .get() !== undefined
    );
  }
}
