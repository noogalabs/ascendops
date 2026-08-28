export type KnownProcessIdentity = {
  kind: 'known';
  pid: number;
  platform: 'linux' | 'darwin';
  kernelToken: string;
};

export type ProcessIdentity =
  | KnownProcessIdentity
  | { kind: 'vanished'; pid: number }
  | { kind: 'unknown'; pid: number; reason: string };

export type ProcessIdentityReader = {
  platform: NodeJS.Platform | string;
  readText(path: string): string;
  readMacProcessStart?(pid: number): { seconds: number; microseconds: number };
};

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function unknown(pid: number, reason: string): ProcessIdentity {
  return { kind: 'unknown', pid, reason };
}

function readLinuxIdentity(pid: number, reader: ProcessIdentityReader): ProcessIdentity {
  let bootId: string;
  try {
    bootId = reader.readText('/proc/sys/kernel/random/boot_id').trim();
  } catch (error) {
    return unknown(pid, `boot-id-${errorCode(error) ?? 'unreadable'}`);
  }

  let stat: string;
  try {
    stat = reader.readText(`/proc/${pid}/stat`);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ESRCH') return { kind: 'vanished', pid };
    return unknown(pid, `process-stat-${code ?? 'unreadable'}`);
  }

  // `/proc/<pid>/stat` field 2 is parenthesized and may itself contain spaces
  // and parentheses. The final `)` is therefore the only safe split point.
  const commEnd = stat.lastIndexOf(')');
  if (commEnd < 0) return unknown(pid, 'process-stat-malformed-comm');
  const fieldsFromState = stat.slice(commEnd + 1).trim().split(/\s+/);
  const startTicks = fieldsFromState[19]; // field 22, with state at index 0
  if (!bootId || !startTicks || !/^\d+$/.test(startTicks)) {
    return unknown(pid, 'process-stat-malformed-starttime');
  }

  return {
    kind: 'known',
    pid,
    platform: 'linux',
    kernelToken: `${bootId}:${startTicks}`,
  };
}

function readMacIdentity(pid: number, reader: ProcessIdentityReader): ProcessIdentity {
  if (!reader.readMacProcessStart) {
    return unknown(pid, 'proc-pidinfo-unavailable');
  }
  try {
    const start = reader.readMacProcessStart(pid);
    if (!Number.isSafeInteger(start.seconds) || !Number.isSafeInteger(start.microseconds)) {
      return unknown(pid, 'proc-pidinfo-malformed');
    }
    return {
      kind: 'known',
      pid,
      platform: 'darwin',
      kernelToken: `${start.seconds}:${start.microseconds}`,
    };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ESRCH') return { kind: 'vanished', pid };
    return unknown(pid, `proc-pidinfo-${code ?? 'unreadable'}`);
  }
}

export function readProcessIdentity(pid: number, reader: ProcessIdentityReader): ProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) return unknown(pid, 'invalid-pid');
  if (reader.platform === 'linux') return readLinuxIdentity(pid, reader);
  if (reader.platform === 'darwin') return readMacIdentity(pid, reader);
  return unknown(pid, `unsupported-platform-${reader.platform}`);
}
