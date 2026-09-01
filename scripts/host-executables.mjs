import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";

const MAC_DOCKER = "/Applications/Docker.app/Contents/Resources/bin/docker";

async function canonicalExecutable(candidate) {
  if (!isAbsolute(candidate)) return null;
  try {
    const canonical = await realpath(candidate);
    if (!(await stat(canonical)).isFile()) return null;
    await access(canonical, constants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

export async function findExecutable(name, environment = process.env) {
  if (isAbsolute(name)) return canonicalExecutable(name);
  for (const directory of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    const executable = await canonicalExecutable(resolve(directory, name));
    if (executable !== null) return executable;
  }
  return null;
}

export async function requireExecutable(name, configured, environment = process.env) {
  const executable = await findExecutable(configured ?? name, environment);
  if (executable === null) {
    throw new Error(`${name} is required but was not found as an absolute executable`);
  }
  return executable;
}

export async function resolveDocker(environment = process.env) {
  if (environment.DOCKER_BIN !== undefined) {
    return requireExecutable("Docker", environment.DOCKER_BIN, environment);
  }
  const docker =
    (await findExecutable("docker", environment)) ?? (await canonicalExecutable(MAC_DOCKER));
  if (docker === null) throw new Error("Docker with the Compose plugin is required");
  return docker;
}

export function environmentForDocker(docker, environment = process.env) {
  return {
    ...environment,
    PATH: `${dirname(docker)}${delimiter}${environment.PATH ?? ""}`,
  };
}
