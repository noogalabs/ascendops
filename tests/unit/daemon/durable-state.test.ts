import { describe, expect, it, vi } from 'vitest';
import {
  durableReplace,
  durableRelease,
  type DurableFs,
} from '../../../src/daemon/durable-state';

function recordingFs(failAt?: string): { fs: DurableFs; calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => {
    calls.push(name);
    if (name === failAt) throw new Error(`crash:${name}`);
  };
  return {
    calls,
    fs: {
      writeTemp(path, _data, mode) { record(`write:${path}:${mode.toString(8)}`); },
      fsyncFile(path) { record(`fsync-file:${path}`); },
      fullFsyncFile(path) { record(`full-fsync-file:${path}`); },
      rename(from, to) { record(`rename:${from}->${to}`); },
      unlink(path) { record(`unlink:${path}`); },
      fsyncDirectory(path) { record(`fsync-dir:${path}`); },
      exists() { return true; },
    },
  };
}

describe('durable state linearization', () => {
  it('publishes only after temp write, file fsync, rename, and parent fsync', () => {
    const { fs, calls } = recordingFs();
    const published = vi.fn();

    durableReplace({
      targetPath: '/state/receipt.json',
      tempPath: '/state/.receipt.req-1.try-1.tmp',
      data: '{"state":"deferred"}\n',
      platform: 'linux',
      fs,
      onPublished: published,
    });

    expect(calls).toEqual([
      'write:/state/.receipt.req-1.try-1.tmp:600',
      'fsync-file:/state/.receipt.req-1.try-1.tmp',
      'rename:/state/.receipt.req-1.try-1.tmp->/state/receipt.json',
      'fsync-dir:/state',
    ]);
    expect(published).toHaveBeenCalledOnce();
  });

  it.each([
    'write:/state/.receipt.req-1.try-1.tmp:600',
    'fsync-file:/state/.receipt.req-1.try-1.tmp',
    'rename:/state/.receipt.req-1.try-1.tmp->/state/receipt.json',
    'fsync-dir:/state',
  ])('never publishes when the durable sequence fails at %s', (failure) => {
    const { fs } = recordingFs(failure);
    const published = vi.fn();

    expect(() => durableReplace({
      targetPath: '/state/receipt.json',
      tempPath: '/state/.receipt.req-1.try-1.tmp',
      data: '{}\n',
      platform: 'linux',
      fs,
      onPublished: published,
    })).toThrow(`crash:${failure}`);
    expect(published).not.toHaveBeenCalled();
  });

  it('uses F_FULLFSYNC on macOS before rename', () => {
    const { fs, calls } = recordingFs();
    durableReplace({
      targetPath: '/state/lease.json',
      tempPath: '/state/.lease.req-2.try-4.tmp',
      data: '{}\n',
      platform: 'darwin',
      fs,
    });

    expect(calls).toContain('full-fsync-file:/state/.lease.req-2.try-4.tmp');
    expect(calls).not.toContain('fsync-file:/state/.lease.req-2.try-4.tmp');
  });

  it('linearizes release only after token check, unlink, and parent fsync', () => {
    const { fs, calls } = recordingFs();
    const released = vi.fn();

    durableRelease({
      targetPath: '/state/lease.json',
      parentPath: '/state',
      tokenMatches: () => true,
      fs,
      onReleased: released,
    });

    expect(calls).toEqual(['unlink:/state/lease.json', 'fsync-dir:/state']);
    expect(released).toHaveBeenCalledOnce();
  });

  it('refuses release when the token does not match', () => {
    const { fs, calls } = recordingFs();
    expect(() => durableRelease({
      targetPath: '/state/lease.json',
      parentPath: '/state',
      tokenMatches: () => false,
      fs,
    })).toThrow('release-token-mismatch');
    expect(calls).toEqual([]);
  });
});
