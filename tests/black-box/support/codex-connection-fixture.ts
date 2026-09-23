// The connected catalog allows profile authorization. Turns deliberately fail so
// recovery journeys exercise the real worker's unavailable-runtime boundary.
export const codexConnectionFixture = `#!/usr/local/bin/node
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  const results = {
    initialize: { codexHome: "/tmp/codex-fixture", platformFamily: "unix", platformOs: "macos", userAgent: "kestrel/0.155.1 (Linux; arm64) terminal (kestrel; 0.0.0)" },
    "account/read": { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true },
    "model/list": { data: ["controlled-model", "gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-terra"].map((model, index) => ({
      id: model, model, displayName: model, description: "Deterministic acceptance fixture", hidden: false, isDefault: index === 0,
      defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }, { reasoningEffort: "high", description: "High" }],
      defaultServiceTier: null, serviceTiers: [{ id: "fast", name: "Fast", description: "Fast" }]
    })), nextCursor: null },
    "account/rateLimits/read": { rateLimits: { planType: "plus", primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: null, rateLimitReachedType: null, spendControlReached: false } }
  };
  console.log(JSON.stringify(Object.hasOwn(results, method)
    ? { id, result: results[method] }
    : { id, error: { code: -32603, message: "Runtime unavailable" } }));
});
`;
