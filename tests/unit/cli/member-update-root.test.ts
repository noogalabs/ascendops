import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({ home: '', check: vi.fn() }));
vi.mock('os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => mocks.home,
}));
vi.mock('../../../src/bus/metrics.js', () => ({ checkUpstream: mocks.check }));
import { updateCommand } from '../../../src/cli/update.js';

describe('member update checkout resolution', () => {
  let root: string;
  let savedArgv: string[];
  function checkout(name: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'cortextos' }));
    return dir;
  }
  function run(binary = 'ascendops') {
    return new Command(binary).addCommand(updateCommand).parseAsync(['node', binary, 'update', '--check']);
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'member-update-'));
    mocks.home = root;
    vi.stubEnv('HOME', root);
    savedArgv = process.argv;
    process.argv = [process.execPath, join(root, 'unrelated', 'command.js')];
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
    process.argv = savedArgv;
    rmSync(root, { recursive: true, force: true });
  });
  it('checks and reports ~/ascendops from an unrelated cwd before legacy locations', async () => {
    const expected = checkout('ascendops');
    vi.stubEnv('CORTEXTOS_DIR', checkout('legacy-configured'));
    checkout('cortextos');
    await expect(run()).rejects.toThrow('exit');
    expect(mocks.check.mock.calls.map(([dir, options]) => [dir, options.apply])).toEqual([[expected, false]]);
    expect(console.log).toHaveBeenCalledWith('Already up to date — no upstream changes available.');
  });
  it('prefers ASCENDOPS_DIR to the default home checkout', async () => {
    checkout('ascendops');
    const expected = checkout('configured');
    vi.stubEnv('ASCENDOPS_DIR', expected);
    await expect(run()).rejects.toThrow('exit');
    expect(mocks.check.mock.calls.map(([dir, options]) => [dir, options.apply])).toEqual([[expected, false]]);
  });
  it('resolves the default install with no other checkout (A)', async () => {
    const expected = checkout('ascendops');
    await expect(run()).rejects.toThrow('exit');
    expect(mocks.check.mock.calls.map(([dir, options]) => [dir, options.apply])).toEqual([[expected, false]]);
  });
  it('keeps the inside-checkout control on the member install', async () => {
    const expected = checkout('ascendops');
    vi.mocked(process.cwd).mockReturnValue(expected);
    await expect(run()).rejects.toThrow('exit');
    expect(mocks.check.mock.calls.map(([dir, options]) => [dir, options.apply])).toEqual([[expected, false]]);
  });
  it('prefers the symlinked binary realpath git checkout over the home default', async () => {
    const expected = checkout('custom-install');
    execFileSync('git', ['init', expected], { stdio: 'ignore' });
    mkdirSync(join(expected, 'dist'));
    writeFileSync(join(expected, 'dist', 'ascendops.js'), '');
    const { symlinkSync } = await import('node:fs');
    checkout('ascendops');
    mkdirSync(join(root, 'bin'));
    const link = join(root, 'bin', 'ascendops');
    symlinkSync(join(expected, 'dist', 'ascendops.js'), link);
    process.argv[1] = link;
    // A non-default HOME install still follows the executable that npm linked.
    await expect(run()).rejects.toThrow('exit');
    expect(mocks.check.mock.calls.map(([dir, options]) => [dir, options.apply])).toEqual([[realpathSync(expected), false]]);
  });
  it('honors the member override ahead of the binary-owned checkout', async () => {
    const binaryRoot = checkout('binary-install');
    execFileSync('git', ['init', binaryRoot], { stdio: 'ignore' });
    mkdirSync(join(binaryRoot, 'dist'));
    writeFileSync(join(binaryRoot, 'dist', 'ascendops.js'), '');
    process.argv[1] = join(binaryRoot, 'dist', 'ascendops.js');
    const expected = checkout('override-install');
    vi.stubEnv('ASCENDOPS_DIR', expected);
    await expect(run()).rejects.toThrow('exit');
    expect(mocks.check.mock.calls.map(([dir, options]) => [dir, options.apply])).toEqual([[expected, false]]);
  });
  it('refuses legacy-only member mode even from inside the legacy checkout', async () => {
    const legacy = checkout('cortextos');
    vi.stubEnv('CORTEXTOS_DIR', legacy);
    vi.stubEnv('CTX_FRAMEWORK_ROOT', legacy);
    vi.mocked(process.cwd).mockReturnValue(legacy);
    await expect(run()).rejects.toThrow('AscendOps checkout not found');
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it('preserves the cortextos binary legacy resolver', async () => {
    checkout('ascendops');
    const expected = checkout('cortextos');
    vi.stubEnv('CORTEXTOS_DIR', expected);
    await expect(run('cortextos')).rejects.toThrow('exit');
    expect(mocks.check.mock.calls.map(([dir, options]) => [dir, options.apply])).toEqual([[expected, false]]);
  });
});
