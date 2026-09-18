import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/index.js";
import { deviceCredentials, devices, users } from "../db/schema.js";

const ENROLLMENT_CODE_BYTES = 16;
const REFRESH_TOKEN_BYTES = 32;

export type EnrollmentCode = {
  code: string;
  expiresAt: number;
  userId: string;
};

export type EnrolledDevice = {
  deviceId: string;
  refreshToken: string;
};

export type AuthenticatedDevice = {
  deviceId: string;
  userId: string;
};

export type DeviceServiceOptions = {
  enrollmentCodeTtlSeconds: number;
  now?: () => number;
  onDeviceRevoked?: (deviceId: string) => void;
  randomToken?: () => string;
};

export class DeviceAuthError extends Error {}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function secureToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function validText(value: string, maxLength: number): boolean {
  return value.trim().length > 0 && value.length <= maxLength;
}

export class DeviceService {
  private readonly enrollmentCodes = new Map<string, EnrollmentCode>();
  private readonly now: () => number;
  private readonly randomToken: () => string;

  public constructor(
    private readonly db: AppDatabase,
    private readonly options: DeviceServiceOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? (() => secureToken(REFRESH_TOKEN_BYTES));
  }

  public createEnrollmentCode(userId: string): EnrollmentCode {
    const code = secureToken(ENROLLMENT_CODE_BYTES);
    const enrollmentCode = {
      code,
      expiresAt:
        this.now() + this.options.enrollmentCodeTtlSeconds * 1000,
      userId,
    };
    this.enrollmentCodes.set(hashSecret(code), enrollmentCode);
    return enrollmentCode;
  }

  public enrollDevice(
    codeInput: string,
    nameInput: string,
    platformInput: string,
  ): EnrolledDevice {
    if (
      !validText(codeInput, 512) ||
      !validText(nameInput, 100) ||
      !validText(platformInput, 50)
    ) {
      throw new DeviceAuthError("Invalid enrollment");
    }

    const codeHash = hashSecret(codeInput);
    const enrollmentCode = this.enrollmentCodes.get(codeHash);
    const now = this.now();

    if (!enrollmentCode || enrollmentCode.expiresAt <= now) {
      throw new DeviceAuthError("Invalid enrollment");
    }

    this.enrollmentCodes.delete(codeHash);

    return this.db.transaction((transaction) => {
      const user = transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, enrollmentCode.userId))
        .get();

      if (!user) {
        throw new DeviceAuthError("Invalid enrollment");
      }

      const deviceId = randomUUID();
      const familyId = randomUUID();
      const refreshToken = this.randomToken();
      transaction
        .insert(devices)
        .values({
          id: deviceId,
          userId: user.id,
          name: nameInput.trim(),
          platform: platformInput.trim(),
          revokedAt: null,
          lastSeenAt: now,
        })
        .run();
      transaction
        .insert(deviceCredentials)
        .values({
          id: randomUUID(),
          deviceId,
          refreshTokenHash: hashSecret(refreshToken),
          familyId,
          revokedAt: null,
        })
        .run();

      return { deviceId, refreshToken };
    });
  }

  public refreshDevice(refreshTokenInput: string): EnrolledDevice {
    if (!validText(refreshTokenInput, 512)) {
      throw new DeviceAuthError("Invalid device credential");
    }

    const tokenHash = hashSecret(refreshTokenInput);
    const now = this.now();

    const refreshed = this.db.transaction((transaction) => {
      const credential = transaction
        .select({
          credential: deviceCredentials,
          device: devices,
        })
        .from(deviceCredentials)
        .innerJoin(devices, eq(deviceCredentials.deviceId, devices.id))
        .where(eq(deviceCredentials.refreshTokenHash, tokenHash))
        .get();

      if (!credential || credential.device.revokedAt !== null) {
        throw new DeviceAuthError("Invalid device credential");
      }

      if (credential.credential.revokedAt !== null) {
        transaction
          .update(deviceCredentials)
          .set({ revokedAt: now })
          .where(eq(deviceCredentials.familyId, credential.credential.familyId))
          .run();
        return null;
      }

      const updated = transaction
        .update(deviceCredentials)
        .set({ revokedAt: now })
        .where(
          and(
            eq(deviceCredentials.id, credential.credential.id),
            isNull(deviceCredentials.revokedAt),
          ),
        )
        .run();

      if (updated.changes !== 1) {
        transaction
          .update(deviceCredentials)
          .set({ revokedAt: now })
          .where(eq(deviceCredentials.familyId, credential.credential.familyId))
          .run();
        return null;
      }

      const nextRefreshToken = this.randomToken();
      transaction
        .insert(deviceCredentials)
        .values({
          id: randomUUID(),
          deviceId: credential.device.id,
          refreshTokenHash: hashSecret(nextRefreshToken),
          familyId: credential.credential.familyId,
          revokedAt: null,
        })
        .run();
      transaction
        .update(devices)
        .set({ lastSeenAt: now })
        .where(eq(devices.id, credential.device.id))
        .run();

      return {
        deviceId: credential.device.id,
        refreshToken: nextRefreshToken,
      };
    });

    if (!refreshed) {
      throw new DeviceAuthError("Invalid device credential");
    }

    return refreshed;
  }

  public authenticateDevice(refreshTokenInput: string): AuthenticatedDevice {
    if (!validText(refreshTokenInput, 512)) {
      throw new DeviceAuthError("Invalid device credential");
    }

    const credential = this.db
      .select({
        credential: deviceCredentials,
        device: devices,
      })
      .from(deviceCredentials)
      .innerJoin(devices, eq(deviceCredentials.deviceId, devices.id))
      .where(eq(deviceCredentials.refreshTokenHash, hashSecret(refreshTokenInput)))
      .get();

    if (
      !credential ||
      credential.credential.revokedAt !== null ||
      credential.device.revokedAt !== null
    ) {
      throw new DeviceAuthError("Invalid device credential");
    }

    return {
      deviceId: credential.device.id,
      userId: credential.device.userId,
    };
  }

  public revokeDevice(userId: string, deviceId: string): void {
    this.db.transaction((transaction) => {
      const device = transaction
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
        .get();

      if (!device) {
        throw new DeviceAuthError("Invalid device");
      }

      const now = this.now();
      transaction
        .update(devices)
        .set({ revokedAt: now })
        .where(eq(devices.id, device.id))
        .run();
      transaction
        .update(deviceCredentials)
        .set({ revokedAt: now })
        .where(eq(deviceCredentials.deviceId, device.id))
        .run();
    });
    this.options.onDeviceRevoked?.(deviceId);
  }
}
