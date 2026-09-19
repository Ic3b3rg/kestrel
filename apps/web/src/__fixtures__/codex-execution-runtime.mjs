import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const [mode, logPath] = process.argv.slice(2);
const log = (entry) => appendFileSync(logPath, JSON.stringify(entry) + "\n");
log({
  cwd: process.cwd(),
  args: process.argv.slice(4),
  remoteOnly: /^ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/u.test(
    process.env.CODEX_EXEC_SERVER_URL ?? "",
  ),
  inheritedApiKey: process.env.OPENAI_API_KEY !== undefined,
  hostProfile:
    process.env.CODEX_HOME === undefined
      ? null
      : {
          codexHome: process.env.CODEX_HOME,
          home: process.env.HOME,
          xdgConfigHome: process.env.XDG_CONFIG_HOME,
          entries: readdirSync(process.env.CODEX_HOME).sort(),
          config: readFileSync(`${process.env.CODEX_HOME}/config.toml`, "utf8"),
          authenticationPresent: existsSync(`${process.env.CODEX_HOME}/auth.json`),
        },
});
if (mode === "bridge_probe") {
  const target = new URL(process.env.CODEX_EXEC_SERVER_URL);
  await new Promise((resolve, reject) => {
    const socket = connect(Number(target.port), target.hostname);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Unauthenticated bridge connection was not closed"));
    }, 2_000);
    socket.once("connect", () => {
      socket.write(`GET /wrong-capability HTTP/1.1\r\nHost: ${target.host}\r\n\r\n`);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", reject);
  });
  log({ unauthorizedBridgeClosed: true });
}
if (mode === "bridge_authorized_probe") {
  const target = new URL(process.env.CODEX_EXEC_SERVER_URL);
  await new Promise((resolve, reject) => {
    const socket = connect(Number(target.port), target.hostname);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Authorized bridge connection did not return bytes"));
    }, 2_000);
    socket.once("connect", () => {
      socket.write(`GET ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\n\r\n`);
    });
    socket.once("data", (bytes) => {
      clearTimeout(timer);
      log({ bridgeForwardedRoot: bytes.toString().startsWith("GET / HTTP/1.1\r\n") });
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}
let output = Promise.resolve();
function send(message) {
  output = output.then(async () => {
    const bytes = Buffer.from(JSON.stringify(message) + "\n");
    const index = bytes.indexOf(Buffer.from("🪶"));
    const split = index < 0 ? 11 : index + 1;
    process.stdout.write(bytes.subarray(0, split));
    await delay(1);
    process.stdout.write(bytes.subarray(split));
  });
  return output;
}
const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const message = JSON.parse(line);
  log(message);
  if (message.method === "initialize")
    await send({
      id: message.id,
      result: { userAgent: "codex/0.155.1", codexHome: process.env.CODEX_HOME },
    });
  if (message.method === "environment/status")
    await send({
      id: message.id,
      result: { status: mode === "local_enabled" ? "ready" : "unknown" },
    });
  if (message.method === "environment/info")
    await send({ id: message.id, result: { cwd: "file:///workspace" } });
  if (message.method === "config/read")
    await send({
      id: message.id,
      result: {
        config: {
          features: {
            ...Object.fromEntries(
              [
                "apps",
                "plugins",
                "hooks",
                "browser_use",
                "browser_use_external",
                "in_app_browser",
                "multi_agent",
                "multi_agent_v2",
                "code_mode",
                "code_mode_only",
                "shell_snapshot",
                "shell_snapshot_v2",
                "auth_elicitation",
                "mentions_v2",
                "remote_plugin",
                "tool_suggest",
                "shell_tool",
                "skip_host_skill_discovery",
              ].map((name) => [name, ["shell_tool", "skip_host_skill_discovery"].includes(name)]),
            ),
            ...(mode === "unknown_feature" ? { future_network_tool: true } : {}),
          },
          web_search: "disabled",
          allow_login_shell: false,
          model: null,
          model_provider: null,
          model_providers: {},
          model_instructions_file: null,
          instructions: null,
          project_doc_max_bytes:
            mode === "project_docs_enabled" || process.env.CODEX_HOME === undefined ? 32768 : 0,
          notify: [],
          sandbox_mode: "read-only",
          approval_policy: "never",
          approvals_reviewer: "user",
          mcp_servers:
            process.env.CODEX_HOME === undefined
              ? { "private.connector": { http_headers: { Authorization: "secret_fixture_value" } } }
              : {},
        },
      },
    });
  if (message.method === "thread/start")
    await send({
      id: message.id,
      result: {
        thread: { id: "execution-thread" },
        cwd: message.params.cwd,
        model: message.params.model,
        modelProvider: "openai",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false },
        runtimeWorkspaceRoots: ["/workspace"],
      },
    });
  if (message.method === "turn/start") {
    const threadId = "execution-thread",
      turnId = "execution-turn";
    if (mode === "authentication") {
      await send({ id: message.id, error: { code: 401, message: "secret_fixture_value" } });
      return;
    }
    await send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    await send({
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    });
    if (mode === "stall") return;
    if (mode === "malformed") {
      process.stdout.write("bad-json\n");
      return;
    }
    if (mode === "question" || mode === "secret_question") {
      await send({
        id: "question",
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          questions: [
            { question: "Which export format is approved?", isSecret: mode === "secret_question" },
          ],
        },
      });
      return;
    }
    if (mode === "permission") {
      await send({
        id: "permission",
        method: "item/permissions/requestApproval",
        params: { threadId, turnId, permissions: { network: { enabled: true } } },
      });
      return;
    }
    if (mode === "exit") process.exit(1);
    if (mode === "wrong_turn") {
      await send({
        method: "item/started",
        params: {
          threadId,
          turnId: "another-turn",
          item: { id: "command", type: "commandExecution" },
        },
      });
      return;
    }
    if (mode === "forbidden_tool") {
      await send({
        method: "item/started",
        params: { threadId, turnId, item: { id: "tool", type: "mcpToolCall" } },
      });
      return;
    }
    await send({
      method: "item/started",
      params: {
        threadId,
        turnId,
        item: { id: "command", type: "commandExecution", command: "node --test" },
      },
    });
    await send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: "command", type: "commandExecution", command: "node --test", exitCode: 0 },
      },
    });
    await send({
      method: "item/completed",
      params: { threadId, turnId, item: { id: "change", type: "fileChange", changes: [] } },
    });
    await send({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, delta: "Discard partial text" },
    });
    if (mode !== "only_delta")
      await send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            id: "answer",
            type: "agentMessage",
            phase: "final_answer",
            text: "Implemented. 🪶",
          },
        },
      });
    await send({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } },
    });
  }
});
lines.on("close", () => log({ closed: true }));
