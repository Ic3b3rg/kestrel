import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAC_DOCKER = "/Applications/Docker.app/Contents/Resources/bin/docker";

export interface RunningStack {
  apiUrl: string;
  authenticateOperator(credentials?: OperatorTestCredentials): Promise<void>;
  bootstrapOperator(credentials: OperatorTestCredentials): Promise<string>;
  pwaUrl: string;
  close(): Promise<void>;
  executeRuntimeSql(sql: string): Promise<void>;
  executeSql(sql: string): Promise<void>;
  fetchApi(path: string, init?: RequestInit): Promise<Response>;
  resetOperatorPassword(password: string): Promise<string>;
  readonly sessionCookie: string;
  restart(...services: string[]): Promise<void>;
  start(...services: string[]): Promise<void>;
  stop(...services: string[]): Promise<void>;
}

export interface OperatorTestCredentials {
  password: string;
  username: string;
}

export const TEST_OPERATOR_CREDENTIALS: OperatorTestCredentials = {
  password: "correct horse battery staple",
  username: "operator",
};

export interface StartStackOptions {
  sessionSigningKey?: string;
}

function executeWithInput(
  command: string,
  args: string[],
  input: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      if (code === 0) {
        resolve(output);
      } else {
        reject(
          new Error(
            `Host command failed with exit code ${String(code)}: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
      }
    });
    child.stdin.end(input);
  });
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

export async function startStack(options: StartStackOptions = {}): Promise<RunningStack> {
  const docker = await resolveDocker();
  const project = `kestrel-black-box-${randomUUID().slice(0, 8)}`;
  const composeArgs = ["compose", "-p", project, "-f", "compose.yaml", "-f", "compose.test.yaml"];
  const environment = {
    ...dockerEnvironment(docker),
    KESTREL_MIGRATOR_DATABASE_PASSWORD: randomBytes(32).toString("base64url"),
    KESTREL_RUNTIME_DATABASE_PASSWORD: randomBytes(32).toString("base64url"),
    SESSION_SIGNING_KEY: options.sessionSigningKey ?? randomBytes(32).toString("base64url"),
  };

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

  async function bootstrapOperator(credentials: OperatorTestCredentials): Promise<string> {
    return executeWithInput(
      docker,
      [...composeArgs, "exec", "--no-TTY", "web", "npm", "run", "bootstrap", "-w", "@kestrel/web"],
      `${credentials.username}\n${credentials.password}\n${credentials.password}\n`,
      environment,
    );
  }

  async function resetOperatorPassword(password: string): Promise<string> {
    return executeWithInput(
      docker,
      [
        ...composeArgs,
        "exec",
        "--no-TTY",
        "web",
        "npm",
        "run",
        "reset-password",
        "-w",
        "@kestrel/web",
      ],
      `${password}\n${password}\n`,
      environment,
    );
  }

  try {
    await execFileAsync(docker, [...composeArgs, "up", "--build", "--detach", "--wait"], {
      env: environment,
      maxBuffer: 10 * 1024 * 1024,
    });

    let apiUrl = await resolvePublishedUrl("web", "3000");
    let pwaUrl = await resolvePublishedUrl("pwa", "5173");
    let csrfToken: string | null = null;
    let sessionCookie: string | null = null;
    await waitForJson(`${apiUrl}/health/ready`);
    await waitForJson(pwaUrl);

    return {
      get apiUrl() {
        return apiUrl;
      },
      get pwaUrl() {
        return pwaUrl;
      },
      get sessionCookie() {
        if (sessionCookie === null) {
          throw new Error("The test stack has no authenticated Operator session");
        }
        return sessionCookie;
      },
      async authenticateOperator(credentials = TEST_OPERATOR_CREDENTIALS) {
        await bootstrapOperator(credentials);
        const response = await fetch(`${apiUrl}/auth/login`, {
          body: JSON.stringify(credentials),
          headers: { "Content-Type": "application/json", Origin: apiUrl },
          method: "POST",
        });
        await response.arrayBuffer();
        const cookies = response.headers
          .getSetCookie()
          .map((value) => value.split(";", 1)[0])
          .filter((value): value is string => value !== undefined && value.length > 0);
        const csrfCookie = cookies.find((value) => value.startsWith("__Host-kestrel-csrf="));
        if (!response.ok || cookies.length !== 2 || csrfCookie === undefined) {
          throw new Error(`Operator test login failed with status ${String(response.status)}`);
        }
        csrfToken = csrfCookie.slice(csrfCookie.indexOf("=") + 1);
        sessionCookie = cookies.join("; ");
      },
      bootstrapOperator,
      close,
      async executeRuntimeSql(sql) {
        await execFileAsync(
          docker,
          [
            ...composeArgs,
            "exec",
            "--no-TTY",
            "postgres",
            "psql",
            "--username",
            "kestrel_runtime",
            "--dbname",
            "kestrel",
            "--set",
            "ON_ERROR_STOP=1",
            "--command",
            sql,
          ],
          { env: environment },
        );
      },
      async executeSql(sql) {
        await execFileAsync(
          docker,
          [
            ...composeArgs,
            "exec",
            "--no-TTY",
            "postgres",
            "psql",
            "--username",
            "kestrel",
            "--dbname",
            "kestrel",
            "--set",
            "ON_ERROR_STOP=1",
            "--command",
            sql,
          ],
          { env: environment },
        );
      },
      async fetchApi(path, init = {}) {
        if (sessionCookie === null) {
          throw new Error("The test stack has no authenticated Operator session");
        }
        const headers = new Headers(init.headers);
        headers.set("Cookie", sessionCookie);
        const method = (init.method ?? "GET").toUpperCase();
        if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
          if (csrfToken === null) {
            throw new Error("The test stack has no CSRF token");
          }
          headers.set("Origin", apiUrl);
          headers.set("X-Kestrel-CSRF", csrfToken);
        }
        return fetch(new URL(path, apiUrl), { ...init, headers });
      },
      resetOperatorPassword,
      async restart(...services) {
        await execFileAsync(docker, [...composeArgs, "restart", ...services], {
          env: environment,
        });
        if (services.includes("web")) {
          apiUrl = await resolvePublishedUrl("web", "3000");
        }
        if (services.includes("pwa")) {
          pwaUrl = await resolvePublishedUrl("pwa", "5173");
        }
        await waitForJson(`${apiUrl}/health/ready`);
        await waitForJson(pwaUrl);
      },
      async start(...services) {
        await execFileAsync(docker, [...composeArgs, "start", ...services], {
          env: environment,
        });
        if (services.includes("web")) {
          apiUrl = await resolvePublishedUrl("web", "3000");
          await waitForJson(`${apiUrl}/health/ready`);
        }
        if (services.includes("pwa")) {
          pwaUrl = await resolvePublishedUrl("pwa", "5173");
          await waitForJson(pwaUrl);
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
