/**
 * tests/unit/cli/daemon-lifecycle-exit-codes.test.ts
 *
 * Part-2 fails-loud sweep — daemon-lifecycle sites (start / disable).
 *
 * Contract: when the daemon IPC op the user asked for did not happen
 * (response.success === false), the CLI must FAIL LOUD (process.exitCode = 1).
 * success === true stays exit 0. Drain-safe: only human-readable lines are
 * written, so we set process.exitCode and let the top-level finalizeProcess
 * drain — never a raw process.exit after the message.
 *
 * IPCClient is mocked so we can inject success=false / success=true without a
 * live daemon. HOME is redirected to a tmp dir so the enabled-agents.json write
 * in the start path is isolated.
 *
 * NOTE on the `enable` site: its action runs a live Telegram credential probe +
 * .env preconditions before reaching the IPC branch, which is impractical to
 * drive in a pure unit test. The enable else-branch is the SAME one-line
 * `process.exitCode = 1` pattern proven here for start; it is additionally
 * covered by the daemon-lifecycle consumer-scan gated on deploy (Nova).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Mock IPCClient BEFORE importing the command modules --------------------
const ipcState: { running: boolean; success: boolean; error?: string; data?: unknown } = {
  running: true,
  success: true,
  data: 'started',
};

vi.mock('../../../src/daemon/ipc-server.js', () => {
  return {
    IPCClient: class {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      constructor(_instance: string) {}
      async isDaemonRunning(): Promise<boolean> {
        return ipcState.running;
      }
      async send(): Promise<{ success: boolean; error?: string; data?: unknown }> {
        return { success: ipcState.success, error: ipcState.error, data: ipcState.data };
      }
    },
  };
});

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Import AFTER the mock is registered.
const { startCommand } = await import('../../../src/cli/start.js');
const { disableAgentCommand } = await import('../../../src/cli/enable-agent.js');

describe('Part-2 fails-loud daemon-lifecycle exit codes', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let prevExitCode: number | string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'daemon-lc-'));
    process.env.HOME = tmpHome;
    prevExitCode = process.exitCode;
    process.exitCode = 0;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ipcState.running = true;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = prevExitCode;
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('start <agent> (daemon running)', () => {
    it('IPC success=false → exit 1, no raw process.exit', async () => {
      ipcState.success = false;
      ipcState.error = 'boom';
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_c?: number) => undefined) as never);
      await startCommand.parseAsync(['som'], { from: 'user' });
      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();
      exitSpy.mockRestore();
    });

    it('IPC success=true → exit 0', async () => {
      ipcState.success = true;
      ipcState.data = 'started ok';
      await startCommand.parseAsync(['som2'], { from: 'user' });
      expect(process.exitCode).toBe(0);
    });
  });

  describe('disable <agent> (daemon running)', () => {
    it('stop IPC success=false → exit 1 (disabled-but-still-running is broken)', async () => {
      ipcState.success = false;
      ipcState.error = 'stop failed';
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_c?: number) => undefined) as never);
      await disableAgentCommand.parseAsync(['somx'], { from: 'user' });
      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();
      exitSpy.mockRestore();
    });

    it('stop IPC success=true → exit 0', async () => {
      ipcState.success = true;
      await disableAgentCommand.parseAsync(['somy'], { from: 'user' });
      expect(process.exitCode).toBe(0);
    });
  });
});
