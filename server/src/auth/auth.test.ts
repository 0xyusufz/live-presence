import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/index.js";
import {
  AuthService,
  DevelopmentLoginLinkDelivery,
  type LoginLink,
  type LoginLinkDelivery,
} from "./service.js";

const SESSION_COOKIE = "live_presence_session";

function cookieValue(setCookie: string | string[] | undefined): string {
  assert.ok(setCookie);
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return cookie.split(";")[0]!;
}

function testAuth(
  databasePath = ":memory:",
  now: () => number = Date.now,
  delivery: LoginLinkDelivery = new DevelopmentLoginLinkDelivery(),
) {
  const database = createDatabase(databasePath);
  const auth = new AuthService(database.db, {
    delivery,
    now,
    randomToken: () => `token-${Math.random().toString(36)}-with-enough-length`,
    sessionTtlSeconds: 3600,
  });
  return { auth, database };
}

test("browser login flow uses POST verification and invalidates logout", async () => {
  const server = await buildApp(":memory:", 3600);

  try {
    const request = await server.app.inject({
      method: "POST",
      url: "/auth/request-login",
      payload: { email: "Test@example.com" },
    });
    assert.equal(request.statusCode, 202);
    const { developmentToken } = request.json<{
      developmentToken: string;
    }>();
    assert.ok(developmentToken);

    const verification = await server.app.inject({
      method: "POST",
      url: "/auth/verify-login",
      payload: { token: developmentToken },
    });
    assert.equal(verification.statusCode, 200);
    assert.equal(verification.headers.location, undefined);
    assert.equal(verification.headers["cache-control"], "no-store");
    assert.equal(verification.headers["referrer-policy"], "no-referrer");
    const cookie = cookieValue(verification.headers["set-cookie"]);
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
    assert.match(
      verification.headers["set-cookie"] as string,
      /HttpOnly/i,
    );
    assert.match(
      verification.headers["set-cookie"] as string,
      /Secure/i,
    );
    assert.match(
      verification.headers["set-cookie"] as string,
      /SameSite=Strict/i,
    );
    assert.match(
      verification.headers["set-cookie"] as string,
      /Max-Age=3600/i,
    );

    const session = await server.app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    assert.equal(session.statusCode, 200);
    assert.equal(
      session.json<{ user: { email: string } }>().user.email,
      "test@example.com",
    );

    const logout = await server.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie },
    });
    assert.equal(logout.statusCode, 204);
    assert.match(logout.headers["set-cookie"] as string, /Max-Age=0/i);
    assert.match(logout.headers["set-cookie"] as string, /Path=\//i);
    assert.match(logout.headers["set-cookie"] as string, /HttpOnly/i);
    assert.match(logout.headers["set-cookie"] as string, /Secure/i);
    assert.match(logout.headers["set-cookie"] as string, /SameSite=Strict/i);

    const afterLogout = await server.app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    assert.equal(afterLogout.statusCode, 401);
  } finally {
    await server.app.close();
    server.close();
  }
});

test("verification never places the raw token in a URL", async () => {
  const server = await buildApp(":memory:");

  try {
    const request = await server.app.inject({
      method: "POST",
      url: "/auth/request-login",
      payload: { email: "owner@example.com" },
    });
    const { developmentToken } = request.json<{
      developmentToken: string;
    }>();
    assert.ok(developmentToken);
    assert.equal(
      (await server.app.inject({
        method: "GET",
        url: `/auth/verify-login?token=${developmentToken}`,
      })).statusCode,
      404,
    );
  } finally {
    await server.app.close();
    server.close();
  }
});

test("invalid, malformed, oversized, expired, and reused tokens are generic failures", () => {
  let now = 1_700_000_000_000;
  const { auth, database } = testAuth(":memory:", () => now);

  try {
    assert.throws(
      () => auth.verifyLogin(""),
      /Invalid or expired login token/,
    );
    assert.throws(
      () => auth.verifyLogin("a".repeat(513)),
      /Invalid or expired login token/,
    );

    const { developmentToken } = auth.requestLogin("owner@example.com");
    assert.ok(developmentToken);
    auth.verifyLogin(developmentToken);
    assert.throws(
      () => auth.verifyLogin(developmentToken),
      /Invalid or expired login token/,
    );

    const { developmentToken: expiredToken } = auth.requestLogin(
      "owner@example.com",
    );
    assert.ok(expiredToken);
    now += 15 * 60 * 1000;
    assert.throws(
      () => auth.verifyLogin(expiredToken),
      /Invalid or expired login token/,
    );
  } finally {
    database.close();
  }
});

test("concurrent verification consumes a token only once", async () => {
  const { auth, database } = testAuth();

  try {
    const { developmentToken } = auth.requestLogin("owner@example.com");
    assert.ok(developmentToken);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => auth.verifyLogin(developmentToken)),
      Promise.resolve().then(() => auth.verifyLogin(developmentToken)),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
  } finally {
    database.close();
  }
});

test("expired sessions and invalid cookies cannot authenticate", () => {
  let now = 1_700_000_000_000;
  const { auth, database } = testAuth(":memory:", () => now);

  try {
    const { developmentToken } = auth.requestLogin("owner@example.com");
    assert.ok(developmentToken);
    const session = auth.verifyLogin(developmentToken);
    assert.equal(auth.getSession("not-a-session"), null);
    assert.deepEqual(auth.getSession(session.sessionToken)?.email, "owner@example.com");
    now += 3600 * 1000;
    assert.equal(auth.getSession(session.sessionToken), null);
  } finally {
    database.close();
  }
});

test("development delivery exposes the token, while production delivery is injectable", async () => {
  const delivery = new DevelopmentLoginLinkDelivery();
  const { auth, database } = testAuth(":memory:", Date.now, delivery);
  try {
    const result = auth.requestLogin("dev@example.com");
    assert.equal(result.developmentToken, delivery.lastToken);
  } finally {
    database.close();
  }

  const delivered: LoginLink[] = [];
  const productionDelivery: LoginLinkDelivery = {
    deliver(loginLink) {
      delivered.push(loginLink);
      return {};
    },
  };
  const server = await buildApp(
    ":memory:",
    3600,
    "production",
    productionDelivery,
  );
  try {
    const request = await server.app.inject({
      method: "POST",
      url: "/auth/request-login",
      payload: { email: "prod@example.com" },
    });
    assert.equal(request.statusCode, 202);
    assert.equal(request.json<{ developmentToken?: string }>().developmentToken, undefined);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.email, "prod@example.com");
  } finally {
    await server.app.close();
    server.close();
  }

  await assert.rejects(
    () => buildApp(":memory:", 3600, "production"),
    /delivery is not configured/,
  );
});

test("delivery failures return a server error rather than a misleading client error", async () => {
  const server = await buildApp(":memory:", 3600, "production", {
    deliver() {
      throw new Error("delivery unavailable");
    },
  });

  try {
    const response = await server.app.inject({
      method: "POST",
      url: "/auth/request-login",
      payload: { email: "prod@example.com" },
    });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: "login unavailable" });
  } finally {
    await server.app.close();
    server.close();
  }
});

test("authentication state persists after database restart", async () => {
  const databasePath = join(
    tmpdir(),
    `live-presence-auth-${process.pid}-${Date.now()}.db`,
  );
  assert.equal(existsSync(databasePath), false);

  const first = await buildApp(databasePath, 3600);
  let cookie: string;
  try {
    const request = await first.app.inject({
      method: "POST",
      url: "/auth/request-login",
      payload: { email: "persist@example.com" },
    });
    const { developmentToken } = request.json<{
      developmentToken: string;
    }>();
    const verification = await first.app.inject({
      method: "POST",
      url: "/auth/verify-login",
      payload: { token: developmentToken },
    });
    cookie = cookieValue(verification.headers["set-cookie"]);
  } finally {
    await first.app.close();
    first.close();
  }

  const second = await buildApp(databasePath, 3600);
  try {
    const session = await second.app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    assert.equal(session.statusCode, 200);
  } finally {
    await second.app.close();
    second.close();
    rmSync(databasePath, { force: true });
  }
});
