import { describe, expect, it } from 'vitest';
import {
  readProcessIdentity,
  type ProcessIdentityReader,
} from '../../../src/daemon/process-identity';

function linuxReader(files: Record<string, string | Error>): ProcessIdentityReader {
  return {
    platform: 'linux',
    readText(path) {
      const value = files[path];
      if (value instanceof Error) throw value;
      if (value === undefined) {
        const error = new Error(`missing ${path}`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return value;
    },
  };
}

describe('process identity', () => {
  it('binds Linux identity to boot ID and stat field 22 even when comm contains spaces and parentheses', () => {
    const reader = linuxReader({
      '/proc/sys/kernel/random/boot_id': 'boot-a\n',
      '/proc/41/stat': '41 (worker name (nested)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242 20 21',
    });

    expect(readProcessIdentity(41, reader)).toEqual({
      kind: 'known',
      pid: 41,
      platform: 'linux',
      kernelToken: 'boot-a:424242',
    });
  });

  it('classifies a vanished process as vanished rather than UNKNOWN', () => {
    const vanished = Object.assign(new Error('gone'), { code: 'ENOENT' });
    const reader = linuxReader({
      '/proc/sys/kernel/random/boot_id': 'boot-a\n',
      '/proc/42/stat': vanished,
    });

    expect(readProcessIdentity(42, reader)).toEqual({ kind: 'vanished', pid: 42 });
  });

  it('fails closed when a live process identity is unreadable', () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const reader = linuxReader({
      '/proc/sys/kernel/random/boot_id': 'boot-a\n',
      '/proc/43/stat': denied,
    });

    expect(readProcessIdentity(43, reader)).toMatchObject({
      kind: 'unknown',
      pid: 43,
      reason: expect.stringContaining('EACCES'),
    });
  });

  it('fails closed instead of falling back to ps lstart on an unsupported platform', () => {
    const reader: ProcessIdentityReader = {
      platform: 'freebsd',
      readText() {
        throw new Error('must not read procfs');
      },
    };

    expect(readProcessIdentity(44, reader)).toMatchObject({
      kind: 'unknown',
      pid: 44,
      reason: expect.stringContaining('unsupported'),
    });
  });

  it('uses the macOS high-resolution proc_pidinfo token without an lstart fallback', () => {
    const reader: ProcessIdentityReader = {
      platform: 'darwin',
      readText() {
        throw new Error('must not read procfs');
      },
      readMacProcessStart(pid) {
        expect(pid).toBe(45);
        return { seconds: 1_723_000_000, microseconds: 123_456 };
      },
    };

    expect(readProcessIdentity(45, reader)).toEqual({
      kind: 'known',
      pid: 45,
      platform: 'darwin',
      kernelToken: '1723000000:123456',
    });
  });
});
