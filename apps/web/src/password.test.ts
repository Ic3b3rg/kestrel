import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./password.js";

describe("Operator password hashing", () => {
  it("stores independently salted Argon2id hashes with versioned parameters", async () => {
    const password = "correct horse battery staple";

    const [first, second] = await Promise.all([hashPassword(password), hashPassword(password)]);

    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    expect(first).not.toContain(password);
    expect(second).not.toBe(first);
    await expect(verifyPassword(password, first)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", first)).resolves.toBe(false);
  });
});
