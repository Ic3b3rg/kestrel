import {
  previewSourceAuthorization,
  confirmSourceAuthorization,
} from "../packages/local-source/src/index.js";

async function main(): Promise<void> {
  const preview = await previewSourceAuthorization(
    process.argv[2] ?? process.env.INIT_CWD ?? process.cwd(),
  );
  for (const repository of preview.repositories)
    process.stdout.write(`Repository: ${repository.displayName}\n`);
  await confirmSourceAuthorization(preview);
  process.stdout.write(`Authorized repositories (${String(preview.repositories.length)} added).\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Repository authorization failed"}\n`,
  );
  process.exitCode = 1;
});
