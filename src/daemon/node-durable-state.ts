import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { DurableFs } from './durable-state';

export type NodeDurableFsOptions = {
  /** Native `fcntl(fd, F_FULLFSYNC)` adapter on macOS. */
  fullFsync(path: string): void;
};

function fsyncPath(path: string, flags: string): void {
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function createNodeDurableFs(options: NodeDurableFsOptions): DurableFs {
  return {
    writeTemp(path, data, mode) {
      // Exclusive creation makes unattributed debris a visible refusal rather
      // than silently overwriting evidence from an earlier crashed attempt.
      writeFileSync(path, data, { mode, flag: 'wx' });
    },
    fsyncFile(path) {
      fsyncPath(path, 'r+');
    },
    fullFsyncFile(path) {
      options.fullFsync(path);
    },
    rename(from, to) {
      renameSync(from, to);
    },
    unlink(path) {
      unlinkSync(path);
    },
    fsyncDirectory(path) {
      fsyncPath(path, 'r');
    },
    exists(path) {
      return existsSync(path);
    },
  };
}
