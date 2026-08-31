import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileCredentialStore } from "./index.js";

function makeTemporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function removeTemporaryDirectory(directory: string): Promise<void> {
  return rm(directory, { force: true, recursive: true });
}

describe("FileCredentialStore", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
  });

  it("stores only authenticated ciphertext behind a Project-bound opaque handle", async () => {
    const directory = await makeTemporaryDirectory("kestrel-model-provider-");
    directories.push(directory);
    const store = new FileCredentialStore(directory);
    const projectId = "018f0f89-8f75-7cc4-9860-3fda5f75d697";
    const apiKey = "sk-project-exclusive-test-key-1234567890";

    const handle = await store.put(projectId, apiKey);

    expect(handle).toMatch(/^cred_[A-Za-z0-9_-]{43}$/u);
    await expect(store.read(projectId, handle)).resolves.toBe(apiKey);
    await expect(store.read("018f0f89-949a-75a8-8f61-6df78a843b1e", handle)).rejects.toThrow(
      "Credential is unavailable",
    );
    await expect(store.read(projectId, "../wrapping-key")).rejects.toThrow(
      "Credential is unavailable",
    );

    const credentialPath = `${directory}/credentials/${handle}.json`;
    const record = await readFile(credentialPath, "utf8");
    expect(record).not.toContain(apiKey);
    expect(record).not.toContain(projectId);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(`${directory}/wrapping-key`)).mode & 0o777).toBe(0o600);
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
  });

  it("deletes only a handle bound to the supplied Project", async () => {
    const directory = await makeTemporaryDirectory("kestrel-model-provider-");
    directories.push(directory);
    const store = new FileCredentialStore(directory);
    const projectId = "018f0f89-8f75-7cc4-9860-3fda5f75d697";
    const handle = await store.put(projectId, "sk-project-exclusive-test-key-1234567890");

    await expect(store.delete("018f0f89-949a-75a8-8f61-6df78a843b1e", handle)).rejects.toThrow(
      "Credential is unavailable",
    );
    await expect(store.read(projectId, handle)).resolves.toContain("project-exclusive");

    await store.delete(projectId, handle);
    await expect(store.read(projectId, handle)).rejects.toThrow("Credential is unavailable");
  });

  it("reconciles an encrypted deletion tombstone on the next store operation", async () => {
    const directory = await makeTemporaryDirectory("kestrel-model-provider-");
    directories.push(directory);
    const store = new FileCredentialStore(directory);
    await store.put(
      "018f0f89-8f75-7cc4-9860-3fda5f75d697",
      "sk-project-exclusive-test-key-1234567890",
    );
    const tombstone = ".deleted-credential-0123456789abcdef0123456789abcdef.tmp";
    await writeFile(join(directory, "credentials", tombstone), "encrypted orphan", "utf8");

    await store.reconcile();

    expect(await readdir(join(directory, "credentials"))).not.toContain(tombstone);
  });
});
