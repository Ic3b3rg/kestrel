import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAC_DOCKER = "/Applications/Docker.app/Contents/Resources/bin/docker";

export interface RunningStack {
  apiUrl: string;
  close(): Promise<void>;
  restart(...services: string[]): Promise<void>;
  start(...services: string[]): Promise<void>;
  stop(...services: string[]): Promise<void>;
}

async function resolveDocker(): Promise<string> {
  if (process.env.DOCKER_BIN) {
    return process.env.DOCKER_BIN;
  }

  try {
    await execFileAsync("docker", ["compose", "version"]);
    return "docker";
  } catch {
    await access(MAC_DOCKER);
    return MAC_DOCKER;
  }
}

async function waitForJson(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });
      await response.arrayBuffer();
      if (response.ok) {
        return;
      }
    } catch {
      // The process is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function dockerEnvironment(docker: string): NodeJS.ProcessEnv {
  if (docker !== MAC_DOCKER) {
    return process.env;
  }

  return {
    ...process.env,
    PATH: `${dirname(docker)}:${process.env.PATH ?? ""}`,
  };
}

export async function startStack(): Promise<RunningStack> {
  const docker = await resolveDocker();
  const project = `kestrel-black-box-${randomUUID().slice(0, 8)}`;
  const composeArgs = ["compose", "-p", project, "-f", "compose.yaml", "-f", "compose.test.yaml"];
  const environment = dockerEnvironment(docker);

  async function close(): Promise<void> {
    if (!project.startsWith("kestrel-black-box-")) {
      throw new Error(`Refusing to remove unexpected Compose project ${project}`);
    }
    await execFileAsync(docker, [...composeArgs, "down", "--volumes", "--remove-orphans"], {
      env: environment,
    });
  }

  async function resolvePublishedUrl(service: string, containerPort: string): Promise<string> {
    const { stdout } = await execFileAsync(
      docker,
      [...composeArgs, "port", service, containerPort],
      { env: environment },
    );
    const endpoints = stdout.trim().split(/\r?\n/u).filter(Boolean);
    if (endpoints.length !== 1) {
      throw new Error(
        `Expected one published ${service} endpoint, received ${String(endpoints.length)}`,
      );
    }

    const port = endpoints[0]?.split(":").at(-1);
    if (!port) {
      throw new Error(`Compose did not publish the ${service} port`);
    }

    return `http://127.0.0.1:${port}`;
  }

  try {
    await execFileAsync(docker, [...composeArgs, "up", "--build", "--detach", "--wait"], {
      env: environment,
      maxBuffer: 10 * 1024 * 1024,
    });

    let apiUrl = await resolvePublishedUrl("web", "3000");
    await waitForJson(`${apiUrl}/health/ready`);

    return {
      get apiUrl() {
        return apiUrl;
      },
      close,
      async restart(...services) {
        await execFileAsync(docker, [...composeArgs, "restart", ...services], {
          env: environment,
        });
        if (services.includes("web")) {
          apiUrl = await resolvePublishedUrl("web", "3000");
        }
        await waitForJson(`${apiUrl}/health/ready`);
      },
      async start(...services) {
        await execFileAsync(docker, [...composeArgs, "start", ...services], {
          env: environment,
        });
        if (services.includes("web")) {
          apiUrl = await resolvePublishedUrl("web", "3000");
          await waitForJson(`${apiUrl}/health/ready`);
        }
      },
      async stop(...services) {
        await execFileAsync(docker, [...composeArgs, "stop", ...services], {
          env: environment,
        });
      },
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
