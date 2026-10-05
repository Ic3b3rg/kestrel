import {
  FactoryPrivateDockerStorageSchema,
  type FactoryPrivateDockerStorage,
} from "@kestrel/contracts";
import { z } from "zod";

type DockerCommand = (args: readonly string[]) => Promise<string>;
const volumeSchema = z.object({
  Name: z.string(),
  CreatedAt: z.string(),
  Driver: z.literal("local"),
  Scope: z.literal("local"),
  Mountpoint: z.string().startsWith("/"),
});

export async function inspectPrivateDockerStorage(cli: DockerCommand, name: string) {
  FactoryPrivateDockerStorageSchema.shape.name.parse(name);
  const volume = volumeSchema.parse(
    JSON.parse(await cli(["volume", "inspect", "--format", "{{json .}}", name])),
  );
  if (volume.Name !== name) throw new Error("Private Docker storage identity changed");
  return {
    receipt: FactoryPrivateDockerStorageSchema.parse({
      name,
      driver: volume.Driver,
      createdAt: volume.CreatedAt,
    }),
    mountpoint: volume.Mountpoint,
  };
}

export async function privateDockerStorageFor(cli: DockerCommand, mounts: unknown) {
  const entries = z.array(z.record(z.string(), z.unknown())).parse(mounts);
  const privateMounts = entries.filter((mount) => mount.Destination === "/var/lib/docker");
  const mount = z
    .object({
      Type: z.literal("volume"),
      Name: z.string(),
      Source: z.string(),
      RW: z.literal(true),
    })
    .parse(privateMounts.length === 1 ? privateMounts[0] : null);
  const storage = await inspectPrivateDockerStorage(cli, mount.Name);
  if (mount.Source !== storage.mountpoint) throw new Error("Private Docker storage mount changed");
  return storage.receipt;
}

/** The owning container must be absent before this cleanup. A busy volume retains the fence. */
export async function removePrivateDockerStorage(
  cli: DockerCommand,
  receipt: FactoryPrivateDockerStorage,
) {
  FactoryPrivateDockerStorageSchema.parse(receipt);
  const find = () =>
    cli(["volume", "ls", "--filter", `name=^${receipt.name}$`, "--format", "{{.Name}}"]);
  const name = await find();
  if (name === "") return;
  if (name !== receipt.name) throw new Error("Private Docker storage lookup was ambiguous");
  const actual = (await inspectPrivateDockerStorage(cli, name)).receipt;
  if (actual.createdAt !== receipt.createdAt)
    throw new Error("Private Docker storage identity changed");
  await cli(["volume", "rm", receipt.name]);
  if ((await find()) !== "") throw new Error("Private Docker storage remains present");
}
