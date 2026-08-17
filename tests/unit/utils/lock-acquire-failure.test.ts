import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fsMock = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  fsMock.writeFileSync.mockImplementation(actual.writeFileSync);
  return {
    ...actual,
    writeFileSync: fsMock.writeFileSync,
  };
});

import { acquireLock, releaseLock } from '../../../src/utils/lock';

describe('lock acquisition failure cleanup', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-enospc-'));
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('removes the partial lock directory when writing the pid fails with ENOSPC', () => {
    const enospc = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const actualWriteFileSync = fsMock.writeFileSync.getMockImplementation()!;
    let failed = false;
    fsMock.writeFileSync.mockImplementation(((target, ...rest) => {
      if (!failed && String(target).endsWith('.pending')) {
        failed = true;
        throw enospc;
      }
      return actualWriteFileSync(target, ...rest);
    }) as typeof import('fs').writeFileSync);

    expect(() => acquireLock(testDir)).toThrow(enospc);
    expect(existsSync(join(testDir, '.lock.d'))).toBe(false);

    const handle = acquireLock(testDir);
    expect(handle).not.toBe(false);
    if (!handle) throw new Error('expected lock handle');
    expect(releaseLock(handle)).toBe(true);
  });
});
