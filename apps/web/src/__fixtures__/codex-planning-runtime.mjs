import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const [mode, logPath] = process.argv.slice(2);
const log = (entry) => appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
log({
  args: process.argv.slice(4),
  pid: process.pid,
  inheritedApiKey: Object.hasOwn(process.env, "OPENAI_API_KEY"),
});
let output = Promise.resolve();
function send(message) {
  output = output.then(async () => {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
    const unicode = bytes.indexOf(Buffer.from("🪶"));
    const split = unicode < 0 ? 9 : unicode + 1;
    process.stdout.write(bytes.subarray(0, split));
    await delay(2);
    process.stdout.write(bytes.subarray(split));
  });
  return output;
}

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const message = JSON.parse(line);
  log(message);
  if (message.method === "initialize") {
    await send({ id: message.id, result: { userAgent: "kestrel/0.153.4" } });
  } else if (message.method === "config/read") {
    const mcp =
      mode === "no_mcp"
        ? {}
        : {
            mcp_servers: {
              "private.connector": {
                url: "https://private.invalid",
                http_headers: { Authorization: "secret_fixture_token" },
              },
              local: { command: "untrusted-program" },
            },
          };
    await send({
      id: message.id,
      result: {
        config: {
          features: {
            apps: false,
            plugins: false,
            hooks: false,
            browser_use: false,
            browser_use_external: false,
            shell_tool: mode === "unsafe_tools",
          },
          web_search: "disabled",
          allow_login_shell: false,
          ...mcp,
        },
      },
    });
  } else if (message.method === "thread/start" || message.method === "thread/resume") {
    await send({
      id: message.id,
      result: {
        thread: { id: message.params.threadId ?? "thread-planning" },
        cwd: message.params.cwd,
        sandbox:
          mode === "unsafe_workspace"
            ? { type: "workspaceWrite", networkAccess: false, writableRoots: [] }
            : { type: "readOnly", networkAccess: mode === "unsafe_network" },
        approvalPolicy: "never",
        approvalsReviewer: "user",
        model: mode === "wrong_model" ? "unexpected-model" : message.params.model,
        modelProvider: mode === "wrong_provider" ? "unexpected-provider" : "openai",
      },
    });
  } else if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    const turnId = "turn-planning";
    if (mode === "authentication" || mode === "usage_limit") {
      await send({
        id: message.id,
        error: {
          code: -32000,
          message: "secret_fixture_token",
          data: {
            codexErrorInfo:
              mode === "authentication"
                ? { httpConnectionFailed: { httpStatusCode: 401 } }
                : "usageLimitExceeded",
          },
        },
      });
      return;
    }
    await send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    if (mode === "exit") process.exit(1);
    if (mode === "stall") return;
    if (mode === "malformed") {
      process.stdout.write("invalid-json\n");
      return;
    }
    if (mode === "oversize") {
      process.stdout.write("x".repeat(2 * 1024 * 1024 + 1));
      return;
    }
    if (mode === "permission_required") {
      await send({
        id: "permission-1",
        method: "item/permissions/requestApproval",
        params: { threadId, turnId, permissions: { network: { enabled: true } } },
      });
      return;
    }
    if (mode === "tool") {
      await send({
        method: "item/started",
        params: { threadId, turnId, item: { type: "commandExecution", id: "command-1" } },
      });
      return;
    }
    if (mode === "input_required") {
      await send({
        id: "question-1",
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: "input-1",
          isBlocking: true,
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Quale risultato deve essere verificabile?",
              options: [
                { label: "Export", description: "Esportare i dati." },
                { label: "Search", description: "Cercare i dati." },
              ],
            },
          ],
        },
      });
      return;
    }
    await send({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, delta: "Discard this partial text" },
    });
    if (mode !== "only_delta") {
      await send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            id: "answer",
            phase: "final_answer",
            text: "Quale risultato deve verificare il piano? 🪶",
          },
        },
      });
    }
    const turn =
      mode === "failed_after_answer"
        ? {
            id: turnId,
            status: "failed",
            items: [],
            error: { message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" },
          }
        : {
            id: mode === "wrong_turn" ? "another-turn" : turnId,
            status: "completed",
            items: [],
            error: null,
          };
    await send({ method: "turn/completed", params: { threadId, turn } });
  }
});
lines.on("close", () => log({ cleanedUp: true, mode }));
