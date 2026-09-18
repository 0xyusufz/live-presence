import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/index.js";
import { AuthService, DevelopmentLoginLinkDelivery } from "../auth/service.js";
import { DeviceAuthError, DeviceService } from "./service.js";

function services(
  now: () => number = Date.now,
  databasePath = ":memory:",
  deviceRandomToken: () => string = (() => {
    let count = 100;
    return () => `refresh-${++count}-with-enough-length`;
  })(),
) {
  const database = createDatabase(databasePath);
  const auth = new AuthService(database.db, {
    delivery: new DevelopmentLoginLinkDelivery(),
    now,
    randomToken: (() => {
      let count = 0;
      return () => `credential-${++count}-with-enough-length`;
    })(),
    sessionTtlSeconds: 3600,
  });
  const devices = new DeviceService(database.db, {
    enrollmentCodeTtlSeconds: 600,
    now,
    randomToken: deviceRandomToken,
  });
  return { auth, database, devices };
}

function createUser(auth: AuthService): string {
  const { developmentToken } = auth.requestLogin("owner@example.com");
  assert.ok(developmentToken);
  return auth.verifyLogin(developmentToken).user.id;
}

test("authenticated browser enrollment creates a device and unauthenticated requests fail", async () => {
  const server = await buildApp(":memory:", 3600, "test", undefined, 600);

  try {
    const unauthorized = await server.app.inject({
      method: "POST",
      url: "/devices/enrollment-code",
    });
    assert.equal(unauthorized.statusCode, 401);

    const login = await server.app.inject({
      method: "POST",
      url: "/auth/request-login",
      payload: { email: "owner@example.com" },
    });
    const { developmentToken } = login.json<{ developmentToken: string }>();
    const verification = await server.app.inject({
      method: "POST",
      url: "/auth/verify-login",
      payload: { token: developmentToken },
    });
    const cookie = (verification.headers["set-cookie"] as string).split(";")[0]!;

    const enrollmentCode = await server.app.inject({
      method: "POST",
      url: "/devices/enrollment-code",
      headers: { cookie },
    });
    assert.equal(enrollmentCode.statusCode, 201);
    const { code } = enrollmentCode.json<{ code: string }>();
    assert.ok(code);

    const enrolled = await server.app.inject({
      method: "POST",
      url: "/devices/enroll",
      payload: { code, name: "Work laptop", platform: "macOS" },
    });
    assert.equal(enrolled.statusCode, 201);
    assert.equal(
      enrolled.json<{ refreshToken: string }>().refreshToken.length,
      43,
    );
    assert.notEqual(enrolled.json<{ deviceId: string }>().deviceId, "");
  } finally {
    await server.app.close();
    server.close();
  }
});

test("enrollment codes expire, are single-use, and concurrent use succeeds once", async () => {
  let now = 1_700_000_000_000;
  const { auth, database, devices } = services(() => now);
  try {
    const userId = createUser(auth);
    const enrollment = devices.createEnrollmentCode(userId);
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        devices.enrollDevice(enrollment.code, "Laptop A", "macOS"),
      ),
      Promise.resolve().then(() =>
        devices.enrollDevice(enrollment.code, "Laptop B", "Windows"),
      ),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);

    const expired = devices.createEnrollmentCode(userId);
    now += 600 * 1000;
    assert.throws(
      () => devices.enrollDevice(expired.code, "Laptop C", "macOS"),
      DeviceAuthError,
    );
  } finally {
    database.close();
  }
});

test("refresh rotates credentials and reuse revokes the credential family", () => {
  const { auth, database, devices } = services();
  try {
    const userId = createUser(auth);
    const enrollment = devices.createEnrollmentCode(userId);
    const first = devices.enrollDevice(enrollment.code, "Laptop", "macOS");
    const second = devices.refreshDevice(first.refreshToken);
    assert.notEqual(second.refreshToken, first.refreshToken);
    assert.throws(
      () => devices.refreshDevice(first.refreshToken),
      DeviceAuthError,
    );
    assert.throws(
      () => devices.refreshDevice(second.refreshToken),
      DeviceAuthError,
    );
    assert.throws(
      () => devices.refreshDevice("invalid-refresh-token"),
      DeviceAuthError,
    );
  } finally {
    database.close();
  }
});

test("family reuse notifies only after commit, while normal rotation stays connected", () => {
  const { auth, database } = services();
  const revoked: string[] = [];
  const devices = new DeviceService(database.db, {
    enrollmentCodeTtlSeconds: 600,
    onDeviceFamilyRevoked: (deviceId) => revoked.push(deviceId),
  });
  try {
    const userId = createUser(auth);
    const enrollment = devices.createEnrollmentCode(userId);
    const first = devices.enrollDevice(enrollment.code, "Laptop", "macOS");
    const second = devices.refreshDevice(first.refreshToken);
    assert.deepEqual(revoked, []);

    assert.throws(() => devices.refreshDevice(first.refreshToken), DeviceAuthError);
    assert.deepEqual(revoked, [first.deviceId]);
    assert.throws(() => devices.authenticateDevice(second.refreshToken), DeviceAuthError);
  } finally {
    database.close();
  }
});

test("device identity and credentials persist after database reload", () => {
  const path = join(
    tmpdir(),
    `live-presence-device-${process.pid}-${Date.now()}.db`,
  );
  let refreshToken: string;
  let tokenCounter = 0;
  const randomToken = () =>
    `persist-refresh-${++tokenCounter}-with-enough-length`;
  const first = services(Date.now, path, randomToken);
  const userId = createUser(first.auth);
  const enrollment = first.devices.createEnrollmentCode(userId);
  refreshToken = first.devices.enrollDevice(enrollment.code, "Laptop", "Windows").refreshToken;
  first.database.close();

  const second = services(Date.now, path, randomToken);
  try {
    const rotated = second.devices.refreshDevice(refreshToken);
    assert.notEqual(rotated.refreshToken, refreshToken);
  } finally {
    second.database.close();
    rmSync(path, { force: true });
  }
});

test("owner can revoke a device and every credential in its family", () => {
  const { auth, database, devices } = services();
  try {
    const ownerId = createUser(auth);
    const enrollment = devices.createEnrollmentCode(ownerId);
    const first = devices.enrollDevice(enrollment.code, "Laptop", "Windows");
    const second = devices.refreshDevice(first.refreshToken);

    devices.revokeDevice(ownerId, first.deviceId);

    assert.throws(
      () => devices.refreshDevice(first.refreshToken),
      DeviceAuthError,
    );
    assert.throws(
      () => devices.refreshDevice(second.refreshToken),
      DeviceAuthError,
    );
  } finally {
    database.close();
  }
});

test("unauthenticated and other-user device revocation are rejected", async () => {
  const server = await buildApp(":memory:", 3600, "test", undefined, 600);

  try {
    const unauthenticated = await server.app.inject({
      method: "DELETE",
      url: "/devices/device-id",
    });
    assert.equal(unauthenticated.statusCode, 401);

    const firstLogin = await server.app.inject({
      method: "POST",
      url: "/auth/request-login",
      payload: { email: "owner@example.com" },
    });
    const firstToken = firstLogin.json<{ developmentToken: string }>()
      .developmentToken;
    const firstVerification = await server.app.inject({
      method: "POST",
      url: "/auth/verify-login",
      payload: { token: firstToken },
    });
    const firstCookie = (firstVerification.headers["set-cookie"] as string)
      .split(";")[0]!;
    const enrollment = await server.app.inject({
      method: "POST",
      url: "/devices/enrollment-code",
      headers: { cookie: firstCookie },
    });
    const code = enrollment.json<{ code: string }>().code;
    const enrolled = await server.app.inject({
      method: "POST",
      url: "/devices/enroll",
      payload: { code, name: "Laptop", platform: "Windows" },
    });
    const deviceId = enrolled.json<{ deviceId: string }>().deviceId;

    const secondLogin = await server.app.inject({
      method: "POST",
      url: "/auth/request-login",
      payload: { email: "other@example.com" },
    });
    const secondToken = secondLogin.json<{ developmentToken: string }>()
      .developmentToken;
    const secondVerification = await server.app.inject({
      method: "POST",
      url: "/auth/verify-login",
      payload: { token: secondToken },
    });
    const secondCookie = (secondVerification.headers["set-cookie"] as string)
      .split(";")[0]!;
    const revoke = await server.app.inject({
      method: "DELETE",
      url: `/devices/${deviceId}`,
      headers: { cookie: secondCookie },
    });
    assert.equal(revoke.statusCode, 401);
  } finally {
    await server.app.close();
    server.close();
  }
});

test("device revocation persists after database reload and is atomic", () => {
  const path = join(
    tmpdir(),
    `live-presence-revoke-${process.pid}-${Date.now()}.db`,
  );
  let refreshToken: string;
  let deviceId: string;
  let ownerId: string;
  const first = services(Date.now, path);
  try {
    ownerId = createUser(first.auth);
    const enrollment = first.devices.createEnrollmentCode(ownerId);
    const enrolled = first.devices.enrollDevice(
      enrollment.code,
      "Laptop",
      "Windows",
    );
    refreshToken = enrolled.refreshToken;
    deviceId = enrolled.deviceId;
    first.devices.revokeDevice(ownerId, deviceId);
  } finally {
    first.database.close();
  }

  const second = services(Date.now, path);
  try {
    assert.throws(
      () => second.devices.refreshDevice(refreshToken),
      DeviceAuthError,
    );
  } finally {
    second.database.close();
    rmSync(path, { force: true });
  }
});
