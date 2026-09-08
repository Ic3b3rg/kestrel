import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import {
  processVerificationFixture,
  releaseVerificationPause,
  seedCertifiedVerificationHistory,
} from "./factory-verification-fixture.js";

// The fixture embeds ESM sent to the compiled web container. TypeScript/lint do
// not parse that generated program; check it without importing it or starting a stack.
it("keeps generated verification worker programs executable after string escaping", async () => {
  const stack = {
    executeWebModule(source: string): Promise<string> {
      const checked = spawnSync(process.execPath, ["--check", "--input-type=module"], {
        input: source,
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(checked.status, checked.stderr).toBe(0);
      return Promise.resolve("null");
    },
  };
  const id = "01991c36-7f90-7000-8000-000000000001";
  await processVerificationFixture(stack, id, "keep", { token: "quote'\"\\\n$()", position: 2 });
  await seedCertifiedVerificationHistory(stack, id);
  await releaseVerificationPause(stack, "quote'\"\\\n$()");
});
