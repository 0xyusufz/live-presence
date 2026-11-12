import { randomUUID } from "node:crypto";

export type PresenceRecord = {
  connected: true;
  connectionId: string;
  deviceId: string;
  lastSeen: number;
  userId: string;
};

export type PresenceConnectionCloseCause = "stale" | "revoked" | "shutdown";

export type PresenceServiceOptions = {
  closeConnection?: (connectionId: string, cause: PresenceConnectionCloseCause) => void;
  now?: () => number;
  staleThresholdSeconds: number;
};

export class PresenceService {
  private readonly now: () => number;
  private readonly records = new Map<string, PresenceRecord>();
  private readonly staleThresholdMs: number;
  private readonly sweepTimer: NodeJS.Timeout;
  private closeConnection?: (connectionId: string, cause: PresenceConnectionCloseCause) => void;

  public constructor(options: PresenceServiceOptions) {
    this.now = options.now ?? Date.now;
    this.staleThresholdMs = options.staleThresholdSeconds * 1000;
    this.closeConnection = options.closeConnection;
    this.sweepTimer = setInterval(
      () => this.removeStale(),
      Math.max(1_000, this.staleThresholdMs),
    );
    this.sweepTimer.unref();
  }

  public setConnectionCloser(
    closeConnection: (connectionId: string, cause: PresenceConnectionCloseCause) => void,
  ): void {
    this.closeConnection = closeConnection;
  }

  public connect(userId: string, deviceId: string): PresenceRecord {
    const record = {
      connected: true as const,
      connectionId: randomUUID(),
      deviceId,
      lastSeen: this.now(),
      userId,
    };
    this.records.set(record.connectionId, record);
    return { ...record };
  }

  public heartbeat(connectionId: string): PresenceRecord {
    this.removeStale();
    const existing = this.records.get(connectionId);
    if (!existing) {
      throw new Error("Connection is not active");
    }

    existing.lastSeen = this.now();
    return { ...existing };
  }

  public disconnect(connectionId: string): void {
    this.records.delete(connectionId);
  }

  public getDevicePresence(deviceId: string): PresenceRecord | undefined {
    this.removeStale();
    for (const record of this.records.values()) {
      if (record.deviceId === deviceId) return { ...record };
    }
    return undefined;
  }

  public revokeDevice(deviceId: string): void {
    for (const [connectionId, record] of this.records) {
      if (record.deviceId === deviceId) {
        this.records.delete(connectionId);
        this.closeConnection?.(connectionId, "revoked");
      }
    }
  }

  public getUserPresence(userId: string): PresenceRecord[] {
    this.removeStale();
    const byDevice = new Map<string, PresenceRecord>();
    for (const record of this.records.values()) {
      if (record.userId !== userId) {
        continue;
      }
      const current = byDevice.get(record.deviceId);
      if (!current || record.lastSeen > current.lastSeen) {
        byDevice.set(record.deviceId, { ...record });
      }
    }
    return [...byDevice.values()];
  }

  public close(): void {
    clearInterval(this.sweepTimer);
    for (const connectionId of this.records.keys()) {
      this.closeConnection?.(connectionId, "shutdown");
    }
    this.records.clear();
  }

  private removeStale(): void {
    const cutoff = this.now() - this.staleThresholdMs;
    for (const [connectionId, record] of this.records) {
      if (record.lastSeen <= cutoff) {
        this.records.delete(connectionId);
        this.closeConnection?.(connectionId, "stale");
      }
    }
  }
}
