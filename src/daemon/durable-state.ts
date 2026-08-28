import { dirname } from 'path';

export type DurableFs = {
  writeTemp(path: string, data: string | Buffer, mode: number): void;
  fsyncFile(path: string): void;
  fullFsyncFile(path: string): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  fsyncDirectory(path: string): void;
  exists(path: string): boolean;
};

type DurableReplaceOptions = {
  targetPath: string;
  tempPath: string;
  data: string | Buffer;
  platform: NodeJS.Platform | string;
  fs: DurableFs;
  onPublished?: () => void;
};

type DurableReleaseOptions = {
  targetPath: string;
  parentPath?: string;
  tokenMatches: () => boolean;
  fs: DurableFs;
  onReleased?: () => void;
};

/**
 * Publish a durable state transition. The callback is the linearization
 * boundary visible to callers: it is unreachable until both the file and its
 * directory entry are durable.
 */
export function durableReplace(options: DurableReplaceOptions): void {
  const { fs, tempPath, targetPath } = options;
  fs.writeTemp(tempPath, options.data, 0o600);
  if (options.platform === 'darwin') fs.fullFsyncFile(tempPath);
  else fs.fsyncFile(tempPath);
  fs.rename(tempPath, targetPath);
  fs.fsyncDirectory(dirname(targetPath));
  options.onPublished?.();
}

/**
 * Remove durable state only after the caller has revalidated the capability
 * token. A successful return means the absent directory entry is durable.
 */
export function durableRelease(options: DurableReleaseOptions): void {
  if (!options.tokenMatches()) throw new Error('release-token-mismatch');
  options.fs.unlink(options.targetPath);
  options.fs.fsyncDirectory(options.parentPath ?? dirname(options.targetPath));
  options.onReleased?.();
}
