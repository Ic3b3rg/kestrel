import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { environmentForDocker, resolveDocker } from "./host-executables.mjs";

const docker = await resolveDocker(process.env);
const dockerEnvironment = environmentForDocker(docker, process.env);
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
