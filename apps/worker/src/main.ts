const shutdown = new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
const keepAlive = setInterval(() => undefined, 60_000);

console.log(
  JSON.stringify({
    event: "worker.started",
    level: "info",
    service: "worker",
    timestamp: new Date().toISOString(),
  }),
);

try {
  await shutdown;
} finally {
  clearInterval(keepAlive);
}
