import { createHmac } from "node:crypto";

export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type TurnServiceOptions = {
  sharedSecret: string;
  urls: string[];
  stunUrls?: string[];
  ttlSeconds: number;
  now?: () => number;
};

export class TurnService {
  private readonly now: () => number;

  constructor(private readonly options: TurnServiceOptions) {
    if (!options.sharedSecret || options.urls.length === 0 || options.ttlSeconds < 1) {
      throw new Error("Invalid TURN configuration");
    }
    this.now = options.now ?? (() => Date.now());
  }

  issue(userId: string): { iceServers: IceServer[]; expiresAt: number } {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error("Invalid TURN user");
    const expiresAt = Math.floor(this.now() / 1000) + this.options.ttlSeconds;
    const username = `${expiresAt}:${userId}`;
    const credential = createHmac("sha1", this.options.sharedSecret)
      .update(username)
      .digest("base64");
    return {
      expiresAt,
      iceServers: [
        ...((this.options.stunUrls ?? []).length > 0 ? [{ urls: this.options.stunUrls! }] : []),
        { urls: this.options.urls, username, credential },
      ],
    };
  }
}
