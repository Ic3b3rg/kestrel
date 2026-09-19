import {
  createCodexExecutionRuntime,
  type CodexExecutionRuntime,
  type CodexExecutionRuntimeOptions,
} from "./codex-execution-runtime.js";

export type CodexReviewRuntime = Pick<CodexExecutionRuntime, "runTurn">;
export const CERTIFIED_CODEX_REVIEW_VERSION = "0.155.1";

const REVIEW_INSTRUCTIONS = `Perform an independent conceptual review of the frozen Feature revision mounted at /workspace.
Inspect /workspace/base and /workspace/head with read-only shell commands. The initial prompt intentionally contains no source text.
Account for every approved outcome and trace it through human Behavioral Steps to exact source evidence and any problems.
Do not implement, repair, modify, execute project code, access external services, request permissions, or use Git metadata.
Return only the requested structured result. Source evidence must cite real retained paths and inclusive line ranges.`;

export function createCodexReviewRuntime(
  options: CodexExecutionRuntimeOptions,
): CodexReviewRuntime {
  return createCodexExecutionRuntime({
    ...options,
    workspaceReadonly: true,
    allowFileChanges: false,
    isolateHostProfile: true,
    developerInstructions: REVIEW_INSTRUCTIONS,
  });
}
