import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";
import { InvalidEmailError, type AuthService } from "./service.js";

const SESSION_COOKIE = "live_presence_session";
const MAX_TOKEN_LENGTH = 512;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_LOGIN_REQUESTS = 5;
const MAX_VERIFY_ATTEMPTS = 10;

type LoginBody = {
  email?: unknown;
};

type VerifyBody = {
  token?: unknown;
};

type RateLimitEntry = {
  count: number;
  startedAt: number;
};

function sessionFromRequest(request: FastifyRequest): string | undefined {
  return request.cookies[SESSION_COOKIE];
}

function clearSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: true,
  });
}

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("referrer-policy", "no-referrer");
}

function withinRateLimit(
  limits: Map<string, RateLimitEntry>,
  key: string,
  maximum: number,
  now: number,
): boolean {
  const existing = limits.get(key);
  if (!existing || now - existing.startedAt >= RATE_WINDOW_MS) {
    limits.set(key, { count: 1, startedAt: now });
    return true;
  }

  if (existing.count >= maximum) {
    return false;
  }

  existing.count += 1;
  return true;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  config: ServerConfig,
): Promise<void> {
  const loginLimits = new Map<string, RateLimitEntry>();
  const verificationLimits = new Map<string, RateLimitEntry>();

  app.post<{ Body: LoginBody }>(
    "/auth/request-login",
    async (request, reply) => {
      noStore(reply);
      const key = request.ip;
      if (!withinRateLimit(loginLimits, key, MAX_LOGIN_REQUESTS, Date.now())) {
        return reply.code(429).send({ error: "too many requests" });
      }

      if (
        typeof request.body?.email !== "string" ||
        request.body.email.trim().length === 0 ||
        request.body.email.length > 320
      ) {
        return reply.code(400).send({ error: "valid email is required" });
      }

      try {
        const delivery = auth.requestLogin(request.body.email);
        return reply.code(202).send({
          message: "If the address is eligible, a login link has been sent.",
          ...(config.nodeEnv === "development" || config.nodeEnv === "test"
            ? { developmentToken: delivery.developmentToken }
            : {}),
        });
      } catch (error) {
        if (error instanceof InvalidEmailError) {
          return reply.code(400).send({ error: "valid email is required" });
        }
        return reply.code(500).send({ error: "login unavailable" });
      }
    },
  );

  app.post<{ Body: VerifyBody }>(
    "/auth/verify-login",
    async (request, reply) => {
      noStore(reply);
      const key = request.ip;
      if (
        !withinRateLimit(
          verificationLimits,
          key,
          MAX_VERIFY_ATTEMPTS,
          Date.now(),
        )
      ) {
        return reply.code(429).send({ error: "too many requests" });
      }

      const token = request.body?.token;
      if (
        typeof token !== "string" ||
        token.length < 20 ||
        token.length > MAX_TOKEN_LENGTH
      ) {
        return reply.code(401).send({ error: "invalid or expired login token" });
      }

      try {
        const result = auth.verifyLogin(token);
        reply.setCookie(SESSION_COOKIE, result.sessionToken, {
          httpOnly: true,
          maxAge: config.sessionTtlSeconds,
          path: "/",
          sameSite: "strict",
          secure: true,
        });
        return reply.send({ user: result.user });
      } catch {
        return reply.code(401).send({ error: "invalid or expired login token" });
      }
    },
  );

  app.get("/auth/session", async (request, reply) => {
    noStore(reply);
    const token = sessionFromRequest(request);
    const user = token ? auth.getSession(token) : null;

    if (!user) {
      return reply.code(401).send({ error: "not authenticated" });
    }

    return reply.send({ user });
  });

  app.post("/auth/logout", async (request, reply) => {
    noStore(reply);
    const token = sessionFromRequest(request);
    if (token) {
      auth.logout(token);
    }
    clearSession(reply);
    return reply.code(204).send();
  });
}
