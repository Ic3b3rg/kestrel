import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const MAC_DOCKER = "/Applications/Docker.app/Contents/Resources/bin/docker";

function resolveDockerBinary() {
  if (process.env.DOCKER_BIN) {
    return process.env.DOCKER_BIN;
  }

  const systemDocker = spawnSync("docker", ["compose", "version"], { stdio: "ignore" });
  if (!systemDocker.error) {
    return "docker";
  }

  if (existsSync(MAC_DOCKER)) {
    return MAC_DOCKER;
  }

  throw new Error("Docker with the Compose plugin is required");
}

const docker = resolveDockerBinary();
const dockerEnvironment =
  docker === MAC_DOCKER
    ? { ...process.env, PATH: `${dirname(docker)}:${process.env.PATH ?? ""}` }
    : process.env;
const environment = {
  ...dockerEnvironment,
  SESSION_SIGNING_KEY: process.env.SESSION_SIGNING_KEY ?? randomBytes(32).toString("base64url"),
};
const composeArguments = ["compose", "-f", "compose.yaml", ...process.argv.slice(2)];
const result = spawnSync(docker, composeArguments, {
  env: environment,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.signal ? 1 : (result.status ?? 1);
