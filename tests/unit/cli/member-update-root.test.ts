import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mocks = vi.hoisted(() => ({ home: '', check: vi.fn() }));
vi.mock('os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => mocks.home,
}));
vi.mock('../../../src/bus/metrics.js', () => ({ checkUpstream: mocks.check }));
import { updateCommand } from '../../../src/cli/update.js';

describe('member update checkout resolution', () => {
  let root: string;
  function checkout(name: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ascendops' }));
    return dir;
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'member-update-'));
    mocks.home = root;
    for (const key of ['CTX_FRAMEWORK_ROOT', 'ASCENDOPS_DIR', 'CORTEXTOS_DIR', 'CTX_PROJECT_ROOT']) {
      vi.stubEnv(key, '');
    }
    const unrelated = join(root, 'unrelated');
    mkdirSync(unrelated);
    vi.spyOn(process, 'cwd').mockReturnValue(unrelated);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.check.mockReset().mockReturnValue({ status: 'up_to_date' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  it('checks and reports ~/ascendops from an unrelated cwd before legacy locations', async () => {
    const expected = checkout('ascendops');
    vi.stubEnv('CORTEXTOS_DIR', checkout('legacy-configured'));
    checkout('cortextos');
    await expect(updateCommand.parseAsync(['node', 'ascendops', '--check'])).rejects.toThrow('exit');
    expect(mocks.check).toHaveBeenCalledExactlyOnceWith(expected, { apply: false });
    expect(console.log).toHaveBeenCalledWith('Already up to date — no upstream changes available.');
  });
  it('prefers ASCENDOPS_DIR to the default home checkout', async () => {
    checkout('ascendops');
    const expected = checkout('configured');
    vi.stubEnv('ASCENDOPS_DIR', expected);
    await expect(updateCommand.parseAsync(['node', 'ascendops', '--check'])).rejects.toThrow('exit');
    expect(mocks.check).toHaveBeenCalledExactlyOnceWith(expected, { apply: false });
  });
});
