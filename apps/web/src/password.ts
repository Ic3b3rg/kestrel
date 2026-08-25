import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

const ARGON2_VERSION = 19;
const MEMORY_KIB = 19_456;
const PASSES = 2;
const PARALLELISM = 1;
const SALT_LENGTH = 16;
const TAG_LENGTH = 32;
const PHC_PATTERN =
  /^\$argon2id\$v=([0-9]+)\$m=([0-9]+),t=([0-9]+),p=([0-9]+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u;

export const ARGON2ID_DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export class InvalidPasswordHashError extends Error {}

function encodePhcPart(value: Buffer): string {
  return value.toString("base64").replace(/=+$/u, "");
}

function decodePhcPart(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (encodePhcPart(decoded) !== value) {
    throw new InvalidPasswordHashError("Password hash contains invalid base64");
  }
  return decoded;
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  const message = Buffer.from(password, "utf8");
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      {
        memory: MEMORY_KIB,
        message,
        nonce: salt,
        parallelism: PARALLELISM,
        passes: PASSES,
        tagLength: TAG_LENGTH,
      },
      (error, derivedKey) => {
        message.fill(0);
        if (error) {
          reject(error);
        } else {
          resolve(derivedKey);
        }
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await derivePassword(password, salt);
  return `$argon2id$v=${String(ARGON2_VERSION)}$m=${String(MEMORY_KIB)},t=${String(PASSES)},p=${String(PARALLELISM)}$${encodePhcPart(salt)}$${encodePhcPart(derivedKey)}`;
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const match = PHC_PATTERN.exec(encodedHash);
  if (!match) {
    throw new InvalidPasswordHashError("Password hash is not a supported Argon2id PHC string");
  }
  const [, version, memory, passes, parallelism, encodedSalt, encodedDerivedKey] = match;
  if (
    Number(version) !== ARGON2_VERSION ||
    Number(memory) !== MEMORY_KIB ||
    Number(passes) !== PASSES ||
    Number(parallelism) !== PARALLELISM ||
    encodedSalt === undefined ||
    encodedDerivedKey === undefined
  ) {
    throw new InvalidPasswordHashError("Password hash uses an unsupported profile");
  }

  const salt = decodePhcPart(encodedSalt);
  const expected = decodePhcPart(encodedDerivedKey);
  if (salt.length !== SALT_LENGTH || expected.length !== TAG_LENGTH) {
    throw new InvalidPasswordHashError("Password hash has an invalid length");
  }

  const actual = await derivePassword(password, salt);
  return timingSafeEqual(actual, expected);
}
