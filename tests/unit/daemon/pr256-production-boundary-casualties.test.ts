import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'net';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { AgentProcess } from '../../../src/daemon/agent-process';
import { CodexAppServerPTY } from '../../../src/pty/codex-app-server-pty';
import { AgentPTY } from '../../../src/pty/agent-pty';
import { isSessionNonceLive, recordSessionNonce } from '../../../src/bus/heartbeat-session-store';
import * as heartbeatSessionStore from '../../../src/bus/heartbeat-session-store';

const REPO = resolve(__dirname, '../../..');

describe('PR256 production boundary casualties', () => {
  let root: string;
  let exitHandler: ((code: number, signal?: number) => void) | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pr256-production-'));
    mkdirSync(join(root, 'state', 'kit'), { recursive: true });
    exitHandler = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function codexProcess(mode: 'ok' | 'throw' | 'exit-during-spawn' = 'ok'): AgentProcess {
    const nonce = 'codex-production-owned-nonce-0001';
    vi.spyOn(CodexAppServerPTY.prototype, 'spawn').mockImplementation(async function () {
      (this as unknown as { _mintedSessionNonce: string })._mintedSessionNonce = nonce;
      recordSessionNonce(root, 'kit', nonce);
      if (mode === 'throw') throw new Error('spawn failed after mint');
      if (mode === 'exit-during-spawn') exitHandler?.(1, 0);
    });
    vi.spyOn(CodexAppServerPTY.prototype, 'onExit').mockImplementation((_cb) => { exitHandler = _cb; });
    vi.spyOn(CodexAppServerPTY.prototype, 'getPid').mockReturnValue(process.pid);
    vi.spyOn(CodexAppServerPTY.prototype, 'isAlive').mockReturnValue(true);
    vi.spyOn(CodexAppServerPTY.prototype, 'kill').mockImplementation(() => { exitHandler?.(0, 0); });
    vi.spyOn(CodexAppServerPTY.prototype, 'write').mockImplementation(() => {});

    return new AgentProcess('kit', {
      instanceId: 'test', ctxRoot: root, frameworkRoot: REPO,
      agentName: 'kit', agentDir: root, org: 'ascendops', projectRoot: REPO,
    } as never, { runtime: 'codex-app-server', max_crashes_per_day: 0 } as never, () => {});
  }

  it('production AgentProcess revokes the Codex-minted nonce after stop', async () => {
    const proc = codexProcess();
    await proc.start();
    expect(isSessionNonceLive(root, 'kit', 'codex-production-owned-nonce-0001')).toBe(true);
    await proc.stop();
    expect(isSessionNonceLive(root, 'kit', 'codex-production-owned-nonce-0001')).toBe(false);
  });

  it('production AgentProcess revokes the Codex-minted nonce after exit', async () => {
    const proc = codexProcess();
    await proc.start();
    expect(isSessionNonceLive(root, 'kit', 'codex-production-owned-nonce-0001')).toBe(true);
    exitHandler?.(0, 0);
    expect(isSessionNonceLive(root, 'kit', 'codex-production-owned-nonce-0001')).toBe(false);
  });

  it('production AgentProcess clears a Codex nonce when spawn fails after minting', async () => {
    const proc = codexProcess('throw');
    await expect(proc.start()).rejects.toThrow('spawn failed after mint');
    expect(isSessionNonceLive(root, 'kit', 'codex-production-owned-nonce-0001')).toBe(false);
  });

  it('production AgentProcess clears a Codex nonce when the PTY exits during spawn', async () => {
    const proc = codexProcess('exit-during-spawn');
    await proc.start();
    expect(isSessionNonceLive(root, 'kit', 'codex-production-owned-nonce-0001')).toBe(false);
  });

  it('a null-returning PTY contract drives a clean production AgentProcess lifecycle', async () => {
    const clearNonce = vi.spyOn(heartbeatSessionStore, 'clearSessionNonce');
    vi.spyOn(AgentPTY.prototype, 'spawn').mockResolvedValue(undefined);
    vi.spyOn(AgentPTY.prototype, 'sessionNonce').mockReturnValue(null);
    vi.spyOn(AgentPTY.prototype, 'onExit').mockImplementation((_cb) => { exitHandler = _cb; });
    vi.spyOn(AgentPTY.prototype, 'getPid').mockReturnValue(process.pid);
    vi.spyOn(AgentPTY.prototype, 'isAlive').mockReturnValue(true);
    vi.spyOn(AgentPTY.prototype, 'kill').mockImplementation(() => { exitHandler?.(0, 0); });
    vi.spyOn(AgentPTY.prototype, 'write').mockImplementation(() => {});

    const proc = new AgentProcess('kit', {
      instanceId: 'test', ctxRoot: root, frameworkRoot: REPO,
      agentName: 'kit', agentDir: root, org: 'ascendops', projectRoot: REPO,
    } as never, { max_crashes_per_day: 0 } as never, () => {});

    await expect(proc.start()).resolves.toBeUndefined();
    expect(proc.getStatus().status).toBe('running');
    expect(existsSync(join(root, 'state', 'kit', 'heartbeat-sessions'))).toBe(false);

    await expect(proc.stop()).resolves.toBeUndefined();
    expect(proc.getStatus().status).toBe('stopped');
    expect(existsSync(join(root, 'state', 'kit', 'heartbeat-sessions'))).toBe(false);
    expect(clearNonce).not.toHaveBeenCalled();
  });

  it('a rejected duplicate preserves the original daemon pid bytes exactly', async () => {
    const instance = `pr256-${process.pid}-${Date.now()}`;
    const home = mkdtempSync('/tmp/p256-home-');
    const frameworkRoot = join(root, 'framework');
    const agentDir = join(frameworkRoot, 'orgs', 'ascendops', 'agents', 'operator');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, '.env'), 'BOT_TOKEN=test-token\nCHAT_ID=1\n');
    const ctxRoot = join(home, '.cortextos', instance);
    mkdirSync(ctxRoot, { recursive: true });
    const pidPath = join(ctxRoot, 'daemon.pid');
    const original = Buffer.from('314159\n', 'utf8');
    writeFileSync(pidPath, original);

    const socketPath = join(ctxRoot, 'daemon.sock');
    const server: Server = createServer(socket => socket.end());
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolveListen);
    });

    let child: ChildProcess | undefined;
    try {
      let output = '';
      child = spawn(process.execPath, ['-r', 'tsx/cjs', 'src/daemon/index.ts'], {
        cwd: REPO,
        env: {
          ...process.env,
          HOME: home,
          CTX_INSTANCE_ID: instance,
          CTX_FRAMEWORK_ROOT: frameworkRoot,
          CTX_ORG: 'ascendops',
          CTX_OPERATOR_CHAT_ID: '1',
          CTX_OPERATOR_BOT_TOKEN: 'test-token',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', chunk => { output += String(chunk); });
      child.stderr?.on('data', chunk => { output += String(chunk); });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const exited = new Promise<void>((resolveExit, rejectExit) => {
        child!.once('error', error => rejectExit(new Error(`duplicate daemon failed to spawn: ${error.message}`)));
        child!.once('exit', () => resolveExit());
      });
      try {
        await Promise.race([
          exited,
          new Promise<never>((_resolve, rejectTimeout) => {
            timeout = setTimeout(() => {
              child?.kill('SIGKILL');
              rejectTimeout(new Error(`duplicate daemon did not exit within 5s\n${output}`));
            }, 5_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      expect(output).toContain('another daemon is already running for this instance');
      expect(readFileSync(pidPath)).toEqual(original);
    } finally {
      child?.kill('SIGKILL');
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});
