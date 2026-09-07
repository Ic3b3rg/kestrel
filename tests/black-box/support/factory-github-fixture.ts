/** A task-owned subprocess provider, never a proxy to a real GitHub repository. */
export const factoryGitHubFixture = String.raw`#!/usr/local/bin/node
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const path = "/tmp/kestrel-factory-github.json";
// The OS releases this lock even when the CLI kills a cancelled child with SIGKILL.
const lock = new DatabaseSync(path + ".sqlite");
lock.exec("PRAGMA busy_timeout = 5000; BEGIN EXCLUSIVE");
process.on("exit", () => lock.close());
const args = process.argv.slice(2);
const state = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {
  issues: [12, 13, 14, 15, 16].map(number => ({ id: String(1000 + number), number, title: "Existing issue " + number,
    body: "Original source context " + number + ": preserve Unicode. <script>window.fixtureExecuted = true</script>",
    state: "open", isPullRequest: false, author: "fixture" })),
  comments: [], edges: [], calls: [], nextIssue: 100, nextComment: 200, controls: {},
};
const endpoint = args.find(value => value.startsWith("/")) ?? "";
const method = args[args.indexOf("--method") + 1] ?? "GET";
const input = args.includes("--input") ? JSON.parse(fs.readFileSync(0, "utf8")) : null;
const projection = args[args.indexOf("--jq") + 1] ?? "";
state.calls.push({ args, method, endpoint, input });
const save = () => {
  fs.writeFileSync(path + ".next", JSON.stringify(state));
  fs.renameSync(path + ".next", path);
};
function output(status, body, headers = {}) {
  save();
  if (status < 400 && projection.includes("issue_url")) {
    const project = ({ id, body, html_url, issue_url, author }) => ({ id, body, html_url, issue_url, author });
    body = Array.isArray(body) ? body.map(project) : project(body);
  } else if (status < 400 && projection.includes("isPullRequest") && !projection.includes("repository_url")) {
    const project = ({ id, number, title, html_url, isPullRequest }) => ({ id, number, title, html_url, isPullRequest });
    body = Array.isArray(body) ? body.map(project) : project(body);
  }
  if (args.includes("--include")) {
    process.stdout.write("HTTP/2.0 " + status + "\r\nContent-Type: application/json\r\n");
    for (const [name, value] of Object.entries(headers)) process.stdout.write(name + ": " + value + "\r\n");
    process.stdout.write("\r\n");
  }
  process.stdout.write(JSON.stringify(body));
  process.exit(status >= 400 ? 1 : 0);
}
if (args[0] === "version") { save(); process.stdout.write("gh version 2.86.0 (fixture)\n"); process.exit(0); }
if (args[0] === "search") output(200, []);
if (state.controls.auth) output(401, { message: "Bad credentials" });
if (endpoint === "/user") output(200, { login: "fixture" });
const uri = new URL(endpoint, "https://api.github.com");
const parts = uri.pathname.split("/").filter(Boolean);
const owner = parts[1] ?? "Ic3b3rg", name = parts[2] ?? "kestrel";
const repoUrl = "https://github.com/" + owner + "/" + name;
const apiUrl = "https://api.github.com/repos/" + owner + "/" + name;
const projectIssue = issue => ({ ...issue, html_url: repoUrl + "/issues/" + issue.number, repository_url: apiUrl });
if (parts.length === 3) {
  if (projection.includes("node_id")) output(200, { id: 424242, node_id: "R_fixture", name, owner: { login: owner } });
  output(200, { id: String(state.controls.repositoryId ?? 424242), owner, name });
}
if (parts[3] !== "issues") output(404, { message: "Not found" });
if (parts.length === 4) {
  if (method === "POST") {
    if (state.controls.rejectCreate) { state.controls.rejectCreate = false; output(401, { message: "Bad credentials" }); }
    const number = state.nextIssue++;
    const issue = { id: String(1000 + number), number, title: input.title, body: input.body,
      state: "open", isPullRequest: false, author: "fixture" };
    state.issues.push(issue);
    if (state.controls.uncertainCreate) { state.controls.uncertainCreate = false; output(500, { message: "Lost create response" }); }
    output(201, projectIssue(issue));
  }
  let issues = state.issues.filter(issue => uri.searchParams.get("state") === "all" || issue.state === "open").toReversed();
  if (state.controls.hideCreated) issues = issues.filter(issue => issue.number < 100);
  const page = Number(uri.searchParams.get("page") ?? 1), size = Number(uri.searchParams.get("per_page") ?? 20);
  const headers = issues.length > page * size ? { Link: "<" + apiUrl + "/issues?state=" + uri.searchParams.get("state") + "&per_page=" + size + "&page=" + (page + 1) + '>; rel="next"' } : {};
  output(200, issues.slice((page - 1) * size, page * size).map(projectIssue), headers);
}
if (parts[4] === "comments") {
  const comment = state.comments.find(item => item.id === parts[5]);
  if (!comment) output(404, { message: "Not found" });
  if (method === "PATCH") comment.body = input.body;
  output(200, comment);
}
const number = Number(parts[4]);
const issue = state.issues.find(candidate => candidate.number === number);
if (!issue) output(404, { message: "Not found" });
if (parts.length === 5) {
  if (method !== "GET") output(422, { message: "Fixture prohibits issue mutation" });
  output(200, projectIssue(issue));
}
if (parts[5] === "dependencies") {
  if (state.controls.unsupportedDependencies) output(501, { message: "Not implemented" });
  if (method === "POST") {
    if (!state.edges.some(edge => edge.number === number && edge.id === String(input.issue_id))) state.edges.push({ number, id: String(input.issue_id) });
    output(201, projectIssue(state.issues.find(candidate => candidate.id === String(input.issue_id))));
  }
  output(200, state.edges.filter(edge => edge.number === number).map(edge => projectIssue(state.issues.find(candidate => candidate.id === edge.id))));
}
if (parts[5] === "comments") {
  if (method === "POST") {
    const id = String(state.nextComment++);
    const comment = { id, body: input.body, html_url: repoUrl + "/issues/" + number + "#issuecomment-" + id,
      issue_url: apiUrl + "/issues/" + number, author: "fixture", number };
    state.comments.push(comment);
    if (state.controls.uncertainComment) { state.controls.uncertainComment = false; output(500, { message: "Lost comment response" }); }
    output(201, comment);
  }
  output(200, state.comments.filter(comment => comment.number === number));
}
output(404, { message: "Not found" });
`;
