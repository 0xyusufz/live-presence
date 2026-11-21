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
type ResumeStatusRecord = {
  epoch: number;
  ownerUserId: string;
  ownerDeviceId?: string;
  viewerUserId: string;
  status: "completed" | "expired";
  expiresAt: number;
};

export type ResumeCapabilities = {
  epoch: number;
  expiresAt: number;
  owner: string;
  viewer: string;
};

export type ResumeStatus =
  | { status: "retryable" }
  | { status: "pending"; capability: string; expiresAt: number }
  | { status: "completed" }
  | { status: "expired" }
  | { status: "invalid" };

export class ResumeSessionStore {
  private readonly sessions = new Map<string, ResumeSession>();
  private readonly ownerDevices = new Map<string, string | undefined>();
  private readonly terminal = new Map<string, ResumeStatusRecord>();
  private readonly expired = new Map<string, ResumeStatusRecord>();
  private readonly terminalLifetimeMs = 60_000;

  create(
    sessionId: string,
    ownerUserId: string,
    viewerUserId: string,
    now: number,
    lifetimeMs: number,
    epoch = 1,
    ownerDeviceId?: string,
  ): ResumeCapabilities {
    const owner = randomBytes(32).toString("base64url");
    const viewer = randomBytes(32).toString("base64url");
    this.sessions.set(sessionId, {
      epoch,
      expiresAt: now + lifetimeMs,
      owner: { userId: ownerUserId, capabilityHash: this.hash(owner), ready: true },
      viewer: { userId: viewerUserId, capabilityHash: this.hash(viewer), ready: true },
    });
    this.ownerDevices.set(sessionId, ownerDeviceId);
    return { epoch, expiresAt: now + lifetimeMs, owner, viewer };
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
    if (
      endpoint.lastRotation?.requestId === requestId &&
      this.equal(endpoint.capabilityHash, presented)
    ) {
      endpoint.ready = true;
      return {
        capability,
        epoch: session.epoch,
        expiresAt: session.expiresAt,
        bothReady: session.owner.ready && session.viewer.ready,
      };
    }
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
    endpoint.lastRotation = { requestId, oldCapabilityHash: presented, capability: nextCapability };
    endpoint.capabilityHash = this.hash(nextCapability);
    endpoint.ready = true;
    return {
      capability: nextCapability,
      epoch: session.epoch,
      expiresAt: session.expiresAt,
      bothReady: session.owner.ready && session.viewer.ready,
    };
  }

  status(
    sessionId: string,
    role: ResumeRole,
    userId: string,
    epoch: number,
    requestId: string,
    now: number,
    deviceId?: string,
  ): ResumeStatus {
    this.pruneTerminal(now);
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.epoch !== epoch || session[role].userId !== userId) return { status: "invalid" };
      if (role === "owner" && this.ownerDevices.get(sessionId) !== deviceId) return { status: "invalid" };
      if (session.expiresAt <= now) {
        this.expire(sessionId, now);
        return { status: "expired" };
      }
      if (session[role].lastRotation?.requestId === requestId) {
        return {
          status: "pending",
          capability: session[role].lastRotation.capability,
          expiresAt: session.expiresAt,
        };
      }
      return { status: "retryable" };
    }
    const record = this.terminal.get(this.key(sessionId, role, requestId));
    if (record && record.epoch === epoch &&
      (role === "owner" ? record.ownerUserId : record.viewerUserId) === userId &&
      (role !== "owner" || record.ownerDeviceId === deviceId)) {
      return { status: record.status };
    }
    const expired = this.expired.get(sessionId);
    if (expired && expired.epoch === epoch &&
      (role === "owner" ? expired.ownerUserId : expired.viewerUserId) === userId &&
      (role !== "owner" || expired.ownerDeviceId === deviceId)) {
      return { status: "expired" };
    }
    return { status: "invalid" };
  }

  complete(sessionId: string, now: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const role of ["owner", "viewer"] as const) {
      const requestId = session[role].lastRotation?.requestId;
      if (requestId) {
        this.terminal.set(this.key(sessionId, role, requestId), {
          epoch: session.epoch,
          ownerUserId: session.owner.userId,
          ownerDeviceId: this.ownerDevices.get(sessionId),
          viewerUserId: session.viewer.userId,
          status: "completed",
          expiresAt: now + this.terminalLifetimeMs,
        });
      }
    }
    this.sessions.delete(sessionId);
    this.ownerDevices.delete(sessionId);
  }

  expire(sessionId: string, now: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.expired.set(sessionId, {
      epoch: session.epoch,
      ownerUserId: session.owner.userId,
      ownerDeviceId: this.ownerDevices.get(sessionId),
      viewerUserId: session.viewer.userId,
      status: "expired",
      expiresAt: now + this.terminalLifetimeMs,
    });
    for (const role of ["owner", "viewer"] as const) {
      const requestId = session[role].lastRotation?.requestId;
      if (requestId) {
        this.terminal.set(this.key(sessionId, role, requestId), {
          epoch: session.epoch,
          ownerUserId: session.owner.userId,
          ownerDeviceId: this.ownerDevices.get(sessionId),
          viewerUserId: session.viewer.userId,
          status: "expired",
          expiresAt: now + this.terminalLifetimeMs,
        });
      }
    }
    this.sessions.delete(sessionId);
    this.ownerDevices.delete(sessionId);
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
    this.ownerDevices.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
    this.ownerDevices.clear();
    this.terminal.clear();
    this.expired.clear();
  }

  private key(sessionId: string, role: ResumeRole, requestId: string): string {
    return `${sessionId}:${role}:${requestId}`;
  }

  private pruneTerminal(now: number): void {
    for (const [key, record] of this.terminal) {
      if (record.expiresAt <= now) this.terminal.delete(key);
    }
    for (const [key, record] of this.expired) {
      if (record.expiresAt <= now) this.expired.delete(key);
    }
  }

  private hash(value: string): Buffer {
    return createHash("sha256").update(value).digest();
  }

  private equal(left: Buffer, right: Buffer): boolean {
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
