import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const [mode, logPath] = process.argv.slice(2);
const log = (entry) => appendFileSync(logPath, JSON.stringify(entry) + "\n");
log({
  cwd: process.cwd(),
  args: process.argv.slice(4),
  remoteOnly: /^ws:\/\/127\.0\.0\.1:\d+$/u.test(process.env.CODEX_EXEC_SERVER_URL ?? ""),
  inheritedApiKey: process.env.OPENAI_API_KEY !== undefined,
});
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
    await send({ id: message.id, result: { userAgent: "codex/0.153.4" } });
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
          features: Object.fromEntries(
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
              "shell_tool",
            ].map((name) => [name, name === "shell_tool"]),
          ),
          web_search: "disabled",
          allow_login_shell: false,
          mcp_servers: {
            "private.connector": { http_headers: { Authorization: "secret_fixture_value" } },
          },
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
