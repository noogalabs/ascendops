import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readProcessIdentity, type ProcessIdentity, type ProcessIdentityReader } from './process-identity';

type HelperOutput = {
  platform: 'linux' | 'darwin';
  pid: number;
  startSeconds?: number;
  startMicroseconds?: number;
};

export type NativeMeasuredPeer = Readonly<{
  platform: 'linux' | 'darwin';
  pid: number;
  processStartIdentity: string;
}>;

function defaultReader(output: HelperOutput): ProcessIdentityReader {
  return {
    platform: output.platform,
    readText(path) {
      return readFileSync(path, 'utf8');
    },
    readMacProcessStart(pid) {
      if (pid !== output.pid || output.startSeconds === undefined || output.startMicroseconds === undefined) {
        const error = new Error('proc_pidinfo result unavailable') as NodeJS.ErrnoException;
        error.code = 'ENOTSUP';
        throw error;
      }
      return { seconds: output.startSeconds, microseconds: output.startMicroseconds };
    },
  };
}

export async function readNativePeerCredentials(
  socketFd: number,
  binaryPath: string,
): Promise<NativeMeasuredPeer> {
  if (!Number.isSafeInteger(socketFd) || socketFd < 0) throw new Error('invalid-socket-fd');
  const result = spawnSync(binaryPath, [], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe', socketFd],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`peer-credential-helper-failed:${result.status}:${String(result.stderr).trim()}`);
  }
  let output: HelperOutput;
  try {
    output = JSON.parse(String(result.stdout)) as HelperOutput;
  } catch {
    throw new Error('peer-credential-helper-invalid-json');
  }
  if (!Number.isSafeInteger(output.pid) || output.pid <= 0
    || (output.platform !== 'linux' && output.platform !== 'darwin')) {
    throw new Error('peer-credential-helper-invalid-output');
  }
  const identity = readProcessIdentity(output.pid, defaultReader(output));
  if (identity.kind !== 'known') {
    throw new Error(`peer-credential-identity-${identity.kind}`);
  }
  return {
    platform: output.platform,
    pid: output.pid,
    processStartIdentity: identity.kernelToken,
  };
}

export function runNativeFullFsync(path: string, binaryPath: string): void {
  if (process.platform !== 'darwin') {
    throw new Error('F_FULLFSYNC is only available on macOS');
  }
  const result = spawnSync(binaryPath, ['--full-fsync', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`full-fsync-helper-failed:${result.status}:${String(result.stderr).trim()}`);
  }
}

export function readNativeProcessIdentity(pid: number, binaryPath: string): ProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { kind: 'unknown', pid, reason: 'invalid-pid' };
  }
  if (process.platform === 'linux') {
    return readProcessIdentity(pid, {
      platform: 'linux',
      readText(path) { return readFileSync(path, 'utf8'); },
    });
  }
  if (process.platform !== 'darwin') {
    return { kind: 'unknown', pid, reason: `unsupported-platform-${process.platform}` };
  }
  const result = spawnSync(binaryPath, ['--process-start', String(pid)], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return { kind: 'unknown', pid, reason: 'proc-pidinfo-helper-error' };
  if (result.status !== 0) {
    return result.status === 2 && String(result.stderr).includes('No such process')
      ? { kind: 'vanished', pid }
      : { kind: 'unknown', pid, reason: 'proc-pidinfo-helper-failed' };
  }
  try {
    const output = JSON.parse(String(result.stdout)) as HelperOutput;
    return readProcessIdentity(pid, defaultReader(output));
  } catch {
    return { kind: 'unknown', pid, reason: 'proc-pidinfo-helper-invalid-output' };
  }
}

export function readNativeParentPid(pid: number): number {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('invalid-process-for-parent-read');
  if (process.platform === 'linux') {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) throw new Error('invalid-proc-stat');
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    const parent = Number(fields[1]);
    if (!Number.isSafeInteger(parent) || parent <= 0) throw new Error('invalid-parent-pid');
    return parent;
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    const parent = Number(String(result.stdout).trim());
    if (result.status !== 0 || !Number.isSafeInteger(parent) || parent <= 0) {
      throw new Error('parent-pid-unavailable');
    }
    return parent;
  }
  throw new Error(`parent-pid-unsupported-${process.platform}`);
}
