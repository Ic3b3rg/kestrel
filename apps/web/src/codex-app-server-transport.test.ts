import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CodexAppServerTransport } from "./codex-app-server-transport.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { force: true, recursive: true });
});
async function fixture(mode: string, profile: "connection" | "turn") {
  const cwd = await mkdtemp(join(tmpdir(), "kestrel-transport-conformance-"));
  directories.push(cwd);
  const executable = join(cwd, "server.mjs");
  await writeFile(
    executable,
    `
    import { createInterface } from 'node:readline';
    const mode = process.argv[2];
    const lines = createInterface({ input: process.stdin });
    let pending;
    function reply(id) {
      const bytes = Buffer.from(JSON.stringify({ id, result: { text: 'caffè 🪶' } }) + '\\n');
      const split = bytes.indexOf(Buffer.from('è')) + 1;
      process.stdout.write(bytes.subarray(0, split));
      setImmediate(() => process.stdout.write(bytes.subarray(split)));
    }
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'probe') {
        if (mode === 'eof') { process.stdout.end(JSON.stringify({ id: message.id, result: { text: 'caffè 🪶' } })); return; }
        if (mode === 'wrong_id') { reply(message.id + 1); return; }
        if (mode === 'stderr') { process.stderr.write('x'.repeat(48 * 1024)); setTimeout(() => reply(message.id), 20); return; }
        if (mode === 'bidirectional') {
          pending = message.id;
          console.log(JSON.stringify({ method: 'progress', params: { state: 'working' } }));
          console.log(JSON.stringify({ id: pending, method: 'approval', params: { scope: 'fixture' } }));
          return;
        }
        reply(message.id);
      } else if (message.id === pending && message.result?.decision === 'decline') reply(pending);
    });
  `,
  );
  const received: Record<string, unknown>[] = [];
  const transport = new CodexAppServerTransport({
    executable: process.execPath,
    arguments: [executable, mode],
    cwd,
    profile,
    timeoutMs: 2_000,
    receive(message) {
      received.push(message);
      if (message.method === "approval")
        transport.send({ id: message.id, result: { decision: "decline" } });
    },
  });
  return { transport, received };
}

it.each(["connection", "turn"] as const)(
  "correlates bidirectional requests and split UTF-8 frames in the %s profile",
  async (profile) => {
    const { transport, received } = await fixture("bidirectional", profile);
    try {
      expect(await transport.request("probe", {})).toEqual({ text: "caffè 🪶" });
      expect(received.map(({ method }) => method)).toEqual(["progress", "approval"]);
    } finally {
      await transport.close();
    }
  },
);

it.each(["connection", "turn"] as const)(
  "rejects an uncorrelated response in the %s profile",
  async (profile) => {
    const { transport } = await fixture("wrong_id", profile);
    try {
      await expect(transport.request("probe", {})).rejects.toMatchObject({
        code: "invalid_response",
      });
    } finally {
      await transport.close();
    }
  },
);

it("accepts a connection response terminated by EOF without a trailing newline", async () => {
  const { transport } = await fixture("eof", "connection");
  try {
    expect(await transport.request("probe", {})).toEqual({ text: "caffè 🪶" });
  } finally {
    await transport.close();
  }
});

it("preserves the narrower connection stderr bound and the existing turn allowance", async () => {
  const connection = await fixture("stderr", "connection");
  try {
    await expect(connection.transport.request("probe", {})).rejects.toMatchObject({
      code: "invalid_response",
    });
  } finally {
    await connection.transport.close();
  }
  const turn = await fixture("stderr", "turn");
  try {
    expect(await turn.transport.request("probe", {})).toEqual({ text: "caffè 🪶" });
  } finally {
    await turn.transport.close();
  }
});
