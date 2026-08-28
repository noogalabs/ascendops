import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  success: true,
  error: undefined as string | undefined,
}));

vi.mock('../../../src/daemon/ipc-server.js', () => ({
  IPCClient: class {
    async send(): Promise<{ success: boolean; error?: string }> {
      return { success: ipc.success, error: ipc.error };
    }
  },
}));

const { spawnWorkerCommand, terminateWorkerCommand } = await import('../../../src/cli/workers.js');

describe('worker commands propagate daemon outcomes to the CLI exit code', () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = 0;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = previousExitCode;
    ipc.success = true;
    ipc.error = undefined;
  });

  it('terminate-worker revocation failure prints the reason and exits non-zero', async () => {
    ipc.success = false;
    ipc.error = 'SESSION REVOCATION UNKNOWN for worker w1';

    await terminateWorkerCommand.parseAsync(['w1'], { from: 'user' });

    expect(console.error).toHaveBeenCalledWith(`Error: ${ipc.error}`);
    expect(process.exitCode).toBe(1);
  });

  it('spawn-worker tombstone refusal prints the reason and exits non-zero', async () => {
    ipc.success = false;
    ipc.error = 'Worker "w1" cannot start: SESSION REVOCATION UNKNOWN';

    await spawnWorkerCommand.parseAsync([
      'w1', '--dir', process.cwd(), '--prompt', 'work',
    ], { from: 'user' });

    expect(console.error).toHaveBeenCalledWith(`Error: ${ipc.error}`);
    expect(process.exitCode).toBe(1);
  });
});
