export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type TurnServiceOptions = {
  keyId: string;
  apiToken: string;
  ttlSeconds: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
};

export class TurnProviderError extends Error {
  constructor(message = "TURN provider unavailable") {
    super(message);
    this.name = "TurnProviderError";
  }
}

function validUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return ["stun:", "stuns:", "turn:", "turns:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function validateIceServers(value: unknown): IceServer[] {
  if (!Array.isArray(value) || value.length === 0) throw new TurnProviderError();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TurnProviderError();
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => !["urls", "username", "credential"].includes(key))) {
      throw new TurnProviderError();
    }
    const urls = record.urls;
    const validUrls = typeof urls === "string"
      ? validUrl(urls) ? urls : null
      : Array.isArray(urls) && urls.length > 0 && urls.every(validUrl)
        ? urls
        : null;
    if (!validUrls) throw new TurnProviderError();
    const isTurn = (typeof validUrls === "string" ? [validUrls] : validUrls)
      .some((url) => url.startsWith("turn:") || url.startsWith("turns:"));
    if (isTurn && (typeof record.username !== "string" || record.username.length === 0 ||
      typeof record.credential !== "string" || record.credential.length === 0)) {
      throw new TurnProviderError();
    }
    return {
      urls: validUrls,
      ...(typeof record.username === "string" ? { username: record.username } : {}),
      ...(typeof record.credential === "string" ? { credential: record.credential } : {}),
    };
  });
}

export class TurnService {
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: TurnServiceOptions) {
    if (!options.keyId || !options.apiToken || options.ttlSeconds < 1) {
      throw new Error("Invalid Cloudflare TURN configuration");
    }
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? (() => Date.now());
  }

  async issue(): Promise<{ iceServers: IceServer[]; expiresAt: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.options.keyId)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ ttl: this.options.ttlSeconds }),
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new TurnProviderError();
      const body = await response.json() as Record<string, unknown>;
      if (Object.keys(body).some((key) => key !== "iceServers")) throw new TurnProviderError();
      return {
        iceServers: validateIceServers(body.iceServers),
        expiresAt: Math.floor(this.now() / 1000) + this.options.ttlSeconds,
      };
    } catch (error) {
      if (error instanceof TurnProviderError) throw error;
      throw new TurnProviderError();
    } finally {
      clearTimeout(timeout);
    }
  }
}
