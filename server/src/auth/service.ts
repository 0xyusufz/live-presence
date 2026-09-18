import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/index.js";
import { authTokens, sessions, users } from "../db/schema.js";

const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

export type LoginLink = {
  email: string;
  token: string;
};

export interface LoginLinkDelivery {
  deliver(loginLink: LoginLink): LoginDelivery;
}

export type LoginDelivery = {
  developmentToken?: string;
};

export type AuthUser = {
  email: string;
  id: string;
};

export class InvalidEmailError extends Error {}

export type AuthServiceOptions = {
  delivery: LoginLinkDelivery;
  now?: () => number;
  randomToken?: () => string;
  sessionTtlSeconds: number;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new InvalidEmailError("A valid email address is required");
  }

  return normalized;
}

function tokenFromBytes(): string {
  return randomBytes(32).toString("base64url");
}

export class DevelopmentLoginLinkDelivery implements LoginLinkDelivery {
  public lastToken: string | undefined;

  public deliver(loginLink: LoginLink): LoginDelivery {
    this.lastToken = loginLink.token;
    return { developmentToken: loginLink.token };
  }
}

export class AuthService {
  private readonly now: () => number;
  private readonly randomToken: () => string;

  public constructor(
    private readonly db: AppDatabase,
    private readonly options: AuthServiceOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? tokenFromBytes;
  }

  public requestLogin(emailInput: string): LoginDelivery {
    const email = normalizeEmail(emailInput);
    const now = this.now();
    const user = this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .get();
    const userId = user?.id ?? randomUUID();

    if (!user) {
      this.db
        .insert(users)
        .values({ id: userId, email, createdAt: now })
        .run();
    }

    const token = this.randomToken();
    this.db
      .insert(authTokens)
      .values({
        id: randomUUID(),
        userId,
        tokenHash: hashToken(token),
        expiresAt: now + LOGIN_TOKEN_TTL_MS,
        consumedAt: null,
      })
      .run();

    return this.options.delivery.deliver({ email, token });
  }

  public verifyLogin(token: string): { sessionToken: string; user: AuthUser } {
    if (token.length < 20 || token.length > 512) {
      throw new Error("Invalid or expired login token");
    }

    const now = this.now();
    const tokenHash = hashToken(token);

    return this.db.transaction((transaction) => {
      const consumedToken = transaction
        .update(authTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(authTokens.tokenHash, tokenHash),
            isNull(authTokens.consumedAt),
            gt(authTokens.expiresAt, now),
          ),
        )
        .returning({ userId: authTokens.userId })
        .get();

      if (!consumedToken) {
        throw new Error("Invalid or expired login token");
      }

      const user = transaction
        .select()
        .from(users)
        .where(eq(users.id, consumedToken.userId))
        .get();

      if (!user) {
        throw new Error("Invalid or expired login token");
      }

      const sessionToken = this.randomToken();
      transaction
        .insert(sessions)
        .values({
          id: randomUUID(),
          userId: user.id,
          tokenHash: hashToken(sessionToken),
          expiresAt: now + this.options.sessionTtlSeconds * 1000,
          revokedAt: null,
          createdAt: now,
        })
        .run();

      return {
        sessionToken,
        user: {
          email: user.email,
          id: user.id,
        },
      };
    });
  }

  public getSession(sessionToken: string): AuthUser | null {
    if (sessionToken.length < 20 || sessionToken.length > 512) {
      return null;
    }

    const now = this.now();
    const session = this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(
        and(
          eq(sessions.tokenHash, hashToken(sessionToken)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
        ),
      )
      .get();

    return session
      ? { email: session.user.email, id: session.user.id }
      : null;
  }

  public logout(sessionToken: string): void {
    if (sessionToken.length < 20 || sessionToken.length > 512) {
      return;
    }

    this.db
      .update(sessions)
      .set({ revokedAt: this.now() })
      .where(
        and(
          eq(sessions.tokenHash, hashToken(sessionToken)),
          isNull(sessions.revokedAt),
        ),
      )
      .run();
  }
}
