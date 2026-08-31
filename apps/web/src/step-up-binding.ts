import { createHash, createHmac } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function stepUpRequestBinding(requestDigest: string, signingKey: Buffer): string {
  const bindingKey = createHmac("sha256", signingKey)
    .update("kestrel-step-up-request-binding-key-v1", "ascii")
    .digest();
  return createHmac("sha256", bindingKey)
    .update("kestrel-step-up-request-binding-v1\0", "ascii")
    .update(requestDigest, "ascii")
    .digest("hex");
}
