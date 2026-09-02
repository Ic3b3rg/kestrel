import {
  readLocalSourceConfig,
  readRepositoryRootConfiguration,
  writeRepositoryRootConfiguration,
} from "../packages/local-source/src/index.js";

async function main(): Promise<void> {
  const repositoryRoot = process.argv[2];
  const configurationPath = process.env.LOCAL_REPOSITORY_ROOTS_FILE;
  if (repositoryRoot === undefined || configurationPath === undefined) {
    throw new Error("Usage: npm run authorize-repository-root -- /absolute/path");
  }

  const existingRoots = await readRepositoryRootConfiguration(configurationPath);
  const validationEnvironment = { ...process.env };
  delete validationEnvironment.LOCAL_REPOSITORY_ROOTS_FILE;
  validationEnvironment.LOCAL_REPOSITORY_ROOTS = JSON.stringify([...existingRoots, repositoryRoot]);
  const config = await readLocalSourceConfig(validationEnvironment);
  await writeRepositoryRootConfiguration(
    configurationPath,
    config.repositoryRoots.map(({ path }) => path),
  );
  process.stdout.write(
    `Authorized repository root (${String(config.repositoryRoots.length)} configured).\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Repository root authorization failed"}\n`,
  );
  process.exitCode = 1;
});
