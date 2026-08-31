import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const handlePattern = /^cred_[A-Za-z0-9_-]{43}$/u;
const recordPattern = /^[A-Za-z0-9+/=]+$/u;
const deletedCredentialPattern = /^\.deleted-credential-[a-f0-9]{32}\.tmp$/u;

export class CredentialStoreError extends Error {
  public constructor() {
    super("Credential is unavailable");
    this.name = "CredentialStoreError";
  }
}

interface EncryptedCredentialRecord {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
  readonly version: 1;
}

interface CredentialPayload {
  readonly apiKey: string;
  readonly projectId: string;
  readonly version: 1;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function parseRecord(value: unknown): EncryptedCredentialRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 4 ||
    !("version" in value) ||
    value.version !== 1 ||
    !("ciphertext" in value) ||
    typeof value.ciphertext !== "string" ||
    !recordPattern.test(value.ciphertext) ||
    !("iv" in value) ||
    typeof value.iv !== "string" ||
    !recordPattern.test(value.iv) ||
    !("tag" in value) ||
    typeof value.tag !== "string" ||
    !recordPattern.test(value.tag)
  ) {
    throw new CredentialStoreError();
  }
  return value as EncryptedCredentialRecord;
}

function parsePayload(value: unknown): CredentialPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !("version" in value) ||
    value.version !== 1 ||
    !("projectId" in value) ||
    typeof value.projectId !== "string" ||
    !("apiKey" in value) ||
    typeof value.apiKey !== "string"
  ) {
    throw new CredentialStoreError();
  }
  return value as CredentialPayload;
}

export interface CredentialStore {
  reconcile(): Promise<void>;
  put(projectId: string, apiKey: string): Promise<string>;
  read(projectId: string, handle: string): Promise<string>;
  delete(projectId: string, handle: string): Promise<void>;
}

export class FileCredentialStore implements CredentialStore {
  readonly #credentialsDirectory: string;
  readonly #keyPath: string;

  public constructor(private readonly rootDirectory: string) {
    this.#credentialsDirectory = join(rootDirectory, "credentials");
    this.#keyPath = join(rootDirectory, "wrapping-key");
  }

  async #initialize(): Promise<Buffer> {
    await mkdir(this.rootDirectory, { mode: 0o700, recursive: true });
    await chmod(this.rootDirectory, 0o700);
    await mkdir(this.#credentialsDirectory, { mode: 0o700, recursive: true });
    await chmod(this.#credentialsDirectory, 0o700);
    const entries = await readdir(this.#credentialsDirectory);
    await Promise.all(
      entries
        .filter((entry) => deletedCredentialPattern.test(entry))
        .map((entry) => unlink(join(this.#credentialsDirectory, entry)).catch(() => undefined)),
    );

    try {
      const keyFile = await open(this.#keyPath, "wx", 0o600);
      try {
        await keyFile.writeFile(randomBytes(32));
        await keyFile.sync();
      } finally {
        await keyFile.close();
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw new CredentialStoreError();
    }
    await chmod(this.#keyPath, 0o600);
    const key = await readFile(this.#keyPath);
    if (key.length !== 32) throw new CredentialStoreError();
    return key;
  }

  public async reconcile(): Promise<void> {
    const key = await this.#initialize();
    key.fill(0);
  }

  public async put(projectId: string, apiKey: string): Promise<string> {
    const key = await this.#initialize();
    const handle = `cred_${randomBytes(32).toString("base64url")}`;
    const temporaryPath = join(
      this.#credentialsDirectory,
      `.credential-${randomBytes(16).toString("hex")}.tmp`,
    );
    let plaintext: Buffer | undefined;
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const associatedData = Buffer.from(`kestrel:direct-api:${handle}:v1`, "utf8");
      cipher.setAAD(associatedData);
      plaintext = Buffer.from(JSON.stringify({ apiKey, projectId, version: 1 }), "utf8");
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const record: EncryptedCredentialRecord = {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        version: 1,
      };
      const temporaryFile = await open(temporaryPath, "wx", 0o600);
      try {
        await temporaryFile.writeFile(JSON.stringify(record), "utf8");
        await temporaryFile.sync();
      } finally {
        await temporaryFile.close();
      }
      const targetPath = join(this.#credentialsDirectory, `${handle}.json`);
      await rename(temporaryPath, targetPath);
      await chmod(targetPath, 0o600);
      return handle;
    } catch {
      await unlink(temporaryPath).catch(() => undefined);
      throw new CredentialStoreError();
    } finally {
      plaintext?.fill(0);
      key.fill(0);
    }
  }

  public async read(projectId: string, handle: string): Promise<string> {
    if (!handlePattern.test(handle)) throw new CredentialStoreError();

    let key: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      key = await this.#initialize();
      const contents = await readFile(join(this.#credentialsDirectory, `${handle}.json`), "utf8");
      if (Buffer.byteLength(contents, "utf8") > 4_096) throw new CredentialStoreError();
      const record = parseRecord(JSON.parse(contents) as unknown);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
      decipher.setAAD(Buffer.from(`kestrel:direct-api:${handle}:v1`, "utf8"));
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64")),
        decipher.final(),
      ]);
      const payload = parsePayload(JSON.parse(plaintext.toString("utf8")) as unknown);
      if (payload.projectId !== projectId) throw new CredentialStoreError();
      return payload.apiKey;
    } catch {
      throw new CredentialStoreError();
    } finally {
      plaintext?.fill(0);
      key?.fill(0);
    }
  }

  public async delete(projectId: string, handle: string): Promise<void> {
    await this.read(projectId, handle);
    const tombstonePath = join(
      this.#credentialsDirectory,
      `.deleted-credential-${randomBytes(16).toString("hex")}.tmp`,
    );
    try {
      await rename(join(this.#credentialsDirectory, `${handle}.json`), tombstonePath);
    } catch {
      throw new CredentialStoreError();
    }
    await unlink(tombstonePath).catch(() => undefined);
  }
}
