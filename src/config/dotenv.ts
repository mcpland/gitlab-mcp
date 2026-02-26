import { config } from "dotenv";

const ENV_FILE_FLAG = "--env-file";

export function resolveEnvFilePathFromArgv(argv: readonly string[]): string | undefined {
  let envFilePath: string | undefined;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg) {
      continue;
    }

    if (arg === ENV_FILE_FLAG) {
      const next = argv[index + 1];
      if (!next) {
        throw new Error(`${ENV_FILE_FLAG} requires a file path`);
      }
      envFilePath = next;
      index += 1;
      continue;
    }

    if (arg.startsWith(`${ENV_FILE_FLAG}=`)) {
      const value = arg.slice(ENV_FILE_FLAG.length + 1).trim();
      if (!value) {
        throw new Error(`${ENV_FILE_FLAG} requires a file path`);
      }
      envFilePath = value;
    }
  }

  return envFilePath;
}

export function loadDotenvFromArgv(
  argv: readonly string[] = process.argv,
  processEnv: NodeJS.ProcessEnv = process.env
): void {
  const envFilePath = resolveEnvFilePathFromArgv(argv);

  if (!envFilePath) {
    config({ processEnv, quiet: true });
    return;
  }

  const result = config({ path: envFilePath, processEnv, quiet: true });

  if (result.error) {
    throw new Error(`Failed to load ${ENV_FILE_FLAG} '${envFilePath}': ${result.error.message}`);
  }
}
