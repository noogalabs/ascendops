import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeDurableFs } from '../../../src/daemon/node-durable-state';
import { durableRelease, durableReplace } from '../../../src/daemon/durable-state';

const dirs: string[] = [];
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('node durable state adapter', () => {
  it('persists replacement and durable release on a real filesystem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-durable-'));
    dirs.push(dir);
    const target = join(dir, 'state.json');
    const temp = join(dir, '.state.request.try.tmp');
    const fs = createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } });

    durableReplace({ targetPath: target, tempPath: temp, data: '{"ok":true}\n', platform: 'linux', fs });
    expect(readFileSync(target, 'utf8')).toBe('{"ok":true}\n');
    durableRelease({ targetPath: target, tokenMatches: () => true, fs });
    expect(fs.exists(target)).toBe(false);
  });

  it('delegates macOS F_FULLFSYNC to the native durability helper', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-durable-'));
    dirs.push(dir);
    const target = join(dir, 'state.json');
    const temp = join(dir, '.state.request.try.tmp');
    const fullFsync = vi.fn();
    const fs = createNodeDurableFs({ fullFsync });

    durableReplace({ targetPath: target, tempPath: temp, data: '{}\n', platform: 'darwin', fs });
    expect(fullFsync).toHaveBeenCalledOnce();
    expect(fullFsync).toHaveBeenCalledWith(temp);
  });
});
