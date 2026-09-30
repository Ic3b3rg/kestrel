export interface PreparedFactoryImage {
  imageId: string;
  docker: string;
}

export function prepareFactoryExecutionImage(
  environment?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<PreparedFactoryImage>;

export function ensureFactoryExecutionImage(
  environment?: NodeJS.ProcessEnv,
  prepare?: typeof prepareFactoryExecutionImage,
  signal?: AbortSignal,
): Promise<PreparedFactoryImage>;
