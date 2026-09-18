import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/index.js";
import { users, viewerPermissions } from "../db/schema.js";

export class AuthorizationError extends Error {}

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
    const existing = this.db
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

      this.db
        .update(viewerPermissions)
        .set({ revokedAt: null })
        .where(eq(viewerPermissions.id, existing.id))
        .run();
      return existing.id;
    }

    const id = randomUUID();
    this.db
      .insert(viewerPermissions)
      .values({
        id,
        ownerUserId,
        viewerUserId,
        revokedAt: null,
      })
      .run();
    return id;
  }

  public revoke(ownerUserId: string, viewerUserId: string): void {
    this.validateRelationship(ownerUserId, viewerUserId);
    this.db
      .update(viewerPermissions)
      .set({ revokedAt: Date.now() })
      .where(
        and(
          eq(viewerPermissions.ownerUserId, ownerUserId),
          eq(viewerPermissions.viewerUserId, viewerUserId),
          isNull(viewerPermissions.revokedAt),
        ),
      )
      .run();
    this.onRevoked?.(ownerUserId, viewerUserId);
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
