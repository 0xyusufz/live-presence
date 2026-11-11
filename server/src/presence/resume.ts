import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type ResumeRole = "owner" | "viewer";
type Endpoint = {
  userId: string;
  capabilityHash: Buffer;
  ready: boolean;
  lastRotation?: {
    requestId: string;
    oldCapabilityHash: Buffer;
    capability: string;
  };
};
type ResumeSession = {
  epoch: number;
  expiresAt: number;
  owner: Endpoint;
  viewer: Endpoint;
};

export type ResumeCapabilities = {
  epoch: number;
  expiresAt: number;
  owner: string;
  viewer: string;
};

export class ResumeSessionStore {
  private readonly sessions = new Map<string, ResumeSession>();

  create(
    sessionId: string,
    ownerUserId: string,
    viewerUserId: string,
    now: number,
    lifetimeMs: number,
    epoch = 1,
  ): ResumeCapabilities {
    const owner = randomBytes(32).toString("base64url");
    const viewer = randomBytes(32).toString("base64url");
    const current: ResumeSession = {
      epoch,
      expiresAt: now + lifetimeMs,
      owner: { userId: ownerUserId, capabilityHash: this.hash(owner), ready: true },
      viewer: { userId: viewerUserId, capabilityHash: this.hash(viewer), ready: true },
    };
    this.sessions.set(sessionId, current);
    return { epoch: current.epoch, expiresAt: current.expiresAt, owner, viewer };
  }

  rotate(
    sessionId: string,
    role: ResumeRole,
    userId: string,
    capability: string,
    requestId: string,
    now: number,
  ): { capability: string; epoch: number; expiresAt: number; bothReady: boolean } | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= now) {
      this.sessions.delete(sessionId);
      return null;
    }
    const endpoint = session[role];
    if (endpoint.userId !== userId) return null;
    const presented = this.hash(capability);
    if (endpoint.lastRotation &&
      endpoint.lastRotation.requestId === requestId &&
      this.equal(endpoint.lastRotation.oldCapabilityHash, presented)) {
      endpoint.ready = true;
      return {
        capability: endpoint.lastRotation.capability,
        epoch: session.epoch,
        expiresAt: session.expiresAt,
        bothReady: session.owner.ready && session.viewer.ready,
      };
    }
    if (!this.equal(endpoint.capabilityHash, presented)) return null;

    const nextCapability = randomBytes(32).toString("base64url");
    endpoint.lastRotation = {
      requestId,
      oldCapabilityHash: presented,
      capability: nextCapability,
    };
    endpoint.capabilityHash = this.hash(nextCapability);
    endpoint.ready = true;
    return {
      capability: nextCapability,
      epoch: session.epoch,
      expiresAt: session.expiresAt,
      bothReady: session.owner.ready && session.viewer.ready,
    };
  }

  markDisconnected(sessionId: string, role: ResumeRole): void {
    const session = this.sessions.get(sessionId);
    if (session) session[role].ready = false;
  }

  isActive(sessionId: string, epoch: number, now: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.epoch !== epoch || session.expiresAt <= now) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  invalidate(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
  }

  private hash(value: string): Buffer {
    return createHash("sha256").update(value).digest();
  }

  private equal(left: Buffer, right: Buffer): boolean {
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
