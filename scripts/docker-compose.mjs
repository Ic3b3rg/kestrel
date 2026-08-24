import { spawn, spawnSync } from "node:child_process";
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
const child = spawn(docker, ["compose", "-f", "compose.yaml", ...process.argv.slice(2)], {
  env:
    docker === MAC_DOCKER
      ? { ...process.env, PATH: `${dirname(docker)}:${process.env.PATH ?? ""}` }
      : process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
