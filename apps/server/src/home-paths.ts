import {
  expandHomePrefix,
  resolveDefaultLogsDir as resolveSharedDefaultLogsDir,
  resolveDefaultSecretsKeyFilePath as resolveSharedDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir as resolveSharedDefaultStorageDir,
  resolveHomeAwarePath,
  resolvePaperclipInstanceConfigPath,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot,
} from "@paperclipai/shared/home-paths";

export {
  expandHomePrefix,
  resolveHomeAwarePath,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot,
};

export function resolveDefaultConfigPath(): string {
  return resolvePaperclipInstanceConfigPath();
}

export function resolveDefaultLogsDir(): string {
  return resolveSharedDefaultLogsDir();
}

export function resolveDefaultSecretsKeyFilePath(): string {
  return resolveSharedDefaultSecretsKeyFilePath();
}

export function resolveDefaultStorageDir(): string {
  return resolveSharedDefaultStorageDir();
}
