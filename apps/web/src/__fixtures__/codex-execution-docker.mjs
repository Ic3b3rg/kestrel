import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.env.KESTREL_TEST_ROOT;
const mode = process.env.KESTREL_TEST_MODE;
const path = join(root, "container.json");
const args = process.argv.slice(2);
appendFileSync(join(root, "docker.jsonl"), JSON.stringify(args) + "\n");
const id = "a".repeat(64);
const state = () => JSON.parse(readFileSync(path, "utf8"));
const save = (value) => writeFileSync(path, JSON.stringify(value));
const value = (flag) => args[args.indexOf(flag) + 1];
if (args[0] === "image") {
  if (mode === "image_missing") process.exit(1);
  console.log("sha256:" + "1".repeat(64));
} else if (args[0] === "create") {
  const mounts = args.flatMap((arg, index) =>
    arg === "--mount"
      ? [Object.fromEntries(args[index + 1].split(",").map((part) => part.split("=")))]
      : [],
  );
  save({
    id,
    name: "/" + value("--name"),
    running: false,
    exitCode: 0,
    image: "sha256:" + "1".repeat(64),
    network: mode === "unsafe_container" ? "host" : value("--network"),
    readonly: args.includes("--read-only"),
    privileged: false,
    pidMode: "",
    restart: value("--restart"),
    capDrop: [value("--cap-drop")],
    securityOpt: [value("--security-opt")],
    mounts: mounts.map((mount) => ({
      Type: mount.type,
      Source: mount.source,
      Destination: mount.target,
      RW: !Object.hasOwn(mount, "readonly"),
    })),
    labels: { "kestrel.factory.execution": value("--label").split("=")[1] },
  });
  if (mode === "create_uncertain") process.exit(1);
  console.log(id);
} else if (args[0] === "inspect") {
  console.log(
    JSON.stringify(
      mode === "foreign_container"
        ? { ...state(), name: "/foreign-container", labels: {} }
        : state(),
    ),
  );
} else if (args[0] === "start") {
  const current = state();
  if (args.includes("--attach")) {
    const exitCode = mode === "verification_failed" ? 7 : 0;
    save({ ...current, running: false, exitCode });
    if (mode === "output_cap") {
      process.stdout.write("x".repeat(70_000));
      process.stderr.write("y".repeat(70_000));
    } else {
      console.log("verified 🪶");
      process.stderr.write("check details\n");
    }
    if (mode === "verification_stall") {
      save({ ...current, running: true });
      setInterval(() => {}, 1_000);
    } else process.exitCode = exitCode;
  } else {
    save({ ...current, running: true });
    console.log(id);
  }
} else if (args[0] === "exec") {
  // A real child transports bytes when the runtime's loopback proxy is exercised.
  if (args.includes("-i")) process.stdin.pipe(process.stdout);
} else if (args[0] === "rm") {
  if (mode === "shutdown_uncertain") process.exit(1);
  if (existsSync(path)) save({ ...state(), running: false, removed: true });
} else if (args[0] === "container" && args[1] === "ls") {
  if (existsSync(path) && !state().removed) console.log(id);
} else {
  rmSync(join(root, "unexpected"), { force: true });
  process.exit(2);
}
