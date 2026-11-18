import { randomUUID } from "node:crypto";

type ActivePeerRegistration = {
  id: string;
  connectionGeneration: number;
  sessionId: string;
  transport: object;
};

export class SignalingPeerGeneration {
  private active: ActivePeerRegistration | undefined;

  register(connectionGeneration: number, sessionId: string, transport: object): string {
    if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 0 ||
      typeof sessionId !== "string" || sessionId.length === 0 || !transport) {
      throw new Error("invalid signaling peer registration");
    }
    const id = randomUUID();
    this.active = { id, connectionGeneration, sessionId, transport };
    return id;
  }

  clearRegistration(id: string): void {
    if (this.active?.id === id) this.active = undefined;
  }

  clearConnection(connectionGeneration: number, transport: object): void {
    if (
      this.active?.connectionGeneration === connectionGeneration &&
      this.active.transport === transport
    ) this.active = undefined;
  }

  invalidate(): void {
    this.active = undefined;
  }

  async forward(
    connectionGeneration: number,
    registrationId: string,
    sessionId: string,
    transport: object,
    send: () => void,
  ): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const active = this.active;
    if (!active || active.connectionGeneration !== connectionGeneration) {
      throw new Error("signaling connection generation is stale");
    }
    if (active.id !== registrationId) {
      throw new Error("signaling peer registration is stale");
    }
    if (active.sessionId !== sessionId || active.transport !== transport) {
      throw new Error("signaling session does not match the active peer registration");
    }
    send();
  }
}
