import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer, type Server } from 'net';
import * as sessionStore from '../../../src/bus/heartbeat-session-store';

/**
 * Behavioral replacement for PATH 4/PATH 5 in worker-session-nonce.test.ts,
 * which check only that `clearSessionNonce` and the throw appear in the right
 * TEXT ORDER — not that every attempt's record is actually gone from disk.
 *
 * Runs the REAL retry loop (startAppServerWithRetry) against REAL files, on an
 * uninstrumented CodexAppServerPTY. The only injected seam is `_spawnFn`
 * (already private/injectable in production for the same reason node-pty needs
 * a fake in every other test in this suite) — everything else, including the
 * genuine 1000ms/4000ms inter-attempt delays and every `buildEnv()` mint/record
 * call, runs unmocked. Runtime ~5s; this is the cost of a true behavioral proof
 * on a loop with real backoff delays, not a simulated one.
 *
 * Reverting the per-attempt clear (removing it from the catch block, matching
 * the code before this fix) makes `remaining session files after exhaustion`
 * go from `[]` to two leaked files — attempts 1 and 2's nonces, orphaned
 * because an end-of-loop clear could only ever name the LAST attempt's nonce.
 * Verified directly: this test dies on that exact reversion.
 */
describe('codex app-server retry: every attempt clears its own record on real disk', () => {
  it('exhausting all three retries leaves ZERO session files behind, not just the last', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-retry-behavioral-'));
    mkdirSync(join(root, 'state', 'codex-app-agent'), { recursive: true });
    try {
      const { CodexAppServerPTY } = await import('../../../src/pty/codex-app-server-pty');
      const env = {
        instanceId: 'test', ctxRoot: root, frameworkRoot: root,
        agentName: 'codex-app-agent', agentDir: root, org: 'acme', projectRoot: root,
      };
      const pty = new CodexAppServerPTY(env as never, {} as never);
      let spawnAttempts = 0;
      (pty as unknown as { _spawnFn: () => never })._spawnFn = () => {
        spawnAttempts += 1;
        throw new Error('spawn failed for real');
      };

      await expect(
        (pty as unknown as { startAppServerWithRetry(): Promise<void> }).startAppServerWithRetry(),
      ).rejects.toThrow('spawn failed for real');

      // All three attempts genuinely ran (proves the real backoff loop executed,
      // not a short-circuited stub).
      expect(spawnAttempts).toBe(3);

      const sessionsDir = join(root, 'state', 'codex-app-agent', 'heartbeat-sessions');
      let remaining: string[] = [];
      try { remaining = readdirSync(sessionsDir); } catch { /* dir absent is also zero-leak */ }
      expect(remaining).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  it('an intermediate clear failure is retried before the next mint so only the surviving attempt remains', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-retry-intermediate-clear-'));
    mkdirSync(join(root, 'state', 'codex-app-agent'), { recursive: true });
    let server: Server | null = null;
    const originalClear = sessionStore.clearSessionNonce;
    let clearCalls = 0;
    const clear = vi.spyOn(sessionStore, 'clearSessionNonce').mockImplementation((...args) => {
      clearCalls += 1;
      if (clearCalls === 2) throw Object.assign(new Error('transient revoke failure'), { code: 'EACCES' });
      return originalClear(...args);
    });
    try {
      const { CodexAppServerPTY } = await import('../../../src/pty/codex-app-server-pty');
      const env = {
        instanceId: 'test', ctxRoot: root, frameworkRoot: root,
        agentName: 'codex-app-agent', agentDir: root, org: 'acme', projectRoot: root,
      };
      const pty = new CodexAppServerPTY(env as never, {} as never);
      let spawnAttempts = 0;
      (pty as unknown as { _spawnFn: (...args: unknown[]) => unknown })._spawnFn = (_cmd, args) => {
        spawnAttempts += 1;
        if (spawnAttempts < 3) throw new Error(`spawn attempt ${spawnAttempts} failed`);
        const listen = (args as string[])[2];
        const port = Number(new URL(listen).port);
        server = createServer(() => {});
        server.listen(port, '127.0.0.1');
        return {
          pid: process.pid,
          onData: () => {},
          onExit: () => {},
          kill: () => server?.close(),
        };
      };

      await (pty as unknown as { startAppServerWithRetry(): Promise<void> }).startAppServerWithRetry();

      expect(spawnAttempts).toBe(3);
      const records = readdirSync(join(root, 'state', 'codex-app-agent', 'heartbeat-sessions'));
      expect(records).toHaveLength(1);
      expect(clearCalls).toBeGreaterThanOrEqual(3);
    } finally {
      clear.mockRestore();
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

  it('a final-attempt clear failure is retried by the same owner and the original spawn error survives', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-retry-terminal-clear-'));
    mkdirSync(join(root, 'state', 'codex-app-agent'), { recursive: true });
    const originalClear = sessionStore.clearSessionNonce;
    let clearCalls = 0;
    const clear = vi.spyOn(sessionStore, 'clearSessionNonce').mockImplementation((...args) => {
      clearCalls += 1;
      if (clearCalls === 3) throw Object.assign(new Error('final transient revoke failure'), { code: 'EACCES' });
      return originalClear(...args);
    });
    try {
      const { CodexAppServerPTY } = await import('../../../src/pty/codex-app-server-pty');
      const env = {
        instanceId: 'test', ctxRoot: root, frameworkRoot: root,
        agentName: 'codex-app-agent', agentDir: root, org: 'acme', projectRoot: root,
      };
      const pty = new CodexAppServerPTY(env as never, {} as never);
      let spawnAttempts = 0;
      (pty as unknown as { _spawnFn: () => never })._spawnFn = () => {
        spawnAttempts += 1;
        throw new Error(`root spawn failure ${spawnAttempts}`);
      };

      await expect(
        (pty as unknown as { startAppServerWithRetry(): Promise<void> }).startAppServerWithRetry(),
      ).rejects.toThrow('root spawn failure 3');

      expect(spawnAttempts).toBe(3);
      expect(clearCalls).toBe(4);
      const records = readdirSync(join(root, 'state', 'codex-app-agent', 'heartbeat-sessions'));
      expect(records).toEqual([]);
    } finally {
      clear.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  it('a terminal owner retry failure retains the exact record, announces twice, and preserves the original spawn error as cause', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-retry-terminal-unknown-'));
    mkdirSync(join(root, 'state', 'codex-app-agent'), { recursive: true });
    const originalClear = sessionStore.clearSessionNonce;
    let clearCalls = 0;
    const clear = vi.spyOn(sessionStore, 'clearSessionNonce').mockImplementation((...args) => {
      clearCalls += 1;
      if (clearCalls >= 3) throw Object.assign(new Error(`revoke failure ${clearCalls}`), { code: 'EACCES' });
      return originalClear(...args);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { CodexAppServerPTY } = await import('../../../src/pty/codex-app-server-pty');
      const env = {
        instanceId: 'test', ctxRoot: root, frameworkRoot: root,
        agentName: 'codex-app-agent', agentDir: root, org: 'acme', projectRoot: root,
      };
      const pty = new CodexAppServerPTY(env as never, {} as never);
      let spawnAttempts = 0;
      (pty as unknown as { _spawnFn: () => never })._spawnFn = () => {
        spawnAttempts += 1;
        throw new Error(`root spawn failure ${spawnAttempts}`);
      };

      const thrown = await (
        pty as unknown as { startAppServerWithRetry(): Promise<void> }
      ).startAppServerWithRetry().catch((caught: unknown) => caught as Error);

      expect(spawnAttempts).toBe(3);
      expect(clearCalls).toBe(4);
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).toContain('root spawn failure 3');
      expect((thrown.cause as Error).message).toBe('root spawn failure 3');
      expect(error).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('SESSION REVOCATION UNKNOWN'));
      const records = readdirSync(join(root, 'state', 'codex-app-agent', 'heartbeat-sessions'));
      expect(records).toHaveLength(1);
    } finally {
      error.mockRestore();
      clear.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
});
