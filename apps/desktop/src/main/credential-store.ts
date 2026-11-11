import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeStorage } from "electron";

export class SafeStorageCredentialStore {
  private readonly path: string;

  constructor(userDataPath: string) {
    this.path = join(userDataPath, "device-credential.bin");
  }

  async has(): Promise<boolean> {
    try {
      await readFile(this.path);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  async load(): Promise<string | null> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error("OS credential encryption is unavailable");
    const value = safeStorage.decryptString(encrypted);
    if (value.length < 20 || value.length > 512) throw new Error("stored device credential is invalid");
    return value;
  }

  async save(value: string): Promise<void> {
    if (value.trim() !== value || value.length < 20 || value.length > 512) {
      throw new Error("device credential is invalid");
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error("OS credential encryption is unavailable");
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, safeStorage.encryptString(value), { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.path);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
