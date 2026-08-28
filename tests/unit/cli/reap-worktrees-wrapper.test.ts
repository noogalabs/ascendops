import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  argv: [] as string[],
  env: {} as NodeJS.ProcessEnv,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(() => '.git\n'),
    spawn: vi.fn((_command: string, argv: string[], options: { env?: NodeJS.ProcessEnv }) => {
      captured.argv = [...argv];
      captured.env = { ...options.env };
      const child = new EventEmitter() as EventEmitter & { pid: number; kill(): boolean };
      child.pid = 4242;
      child.kill = () => true;
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    }),
  };
});

vi.mock('../../../src/daemon/ipc-server.js', () => ({
  IPCClient: class {
    async send(request: { type: string }) {
      return request.type === 'acquire-worktree-lease'
        ? { success: true, data: { kind: 'granted', token: 'lease-token' } }
        : { success: true };
    }
  },
}));

vi.mock('../../../src/daemon/durable-lease-request.js', () => ({
  DurableLeaseRequest: class {
    loadExisting() { return '00000000-0000-4000-8000-000000000001'; }
    persist() {}
    removeAfterRelease() {}
  },
}));

vi.mock('../../../src/daemon/worktree-lease-supervisor.js', () => ({
  superviseLeaseSpan: async (
    input: { scopeKey: string; owner: string; command: string[] },
    dependencies: {
      createRequestId(): string;
      persistRequestId(id: string): Promise<void>;
      acquire(request: { scopeKey: string; owner: string; requestId: string }): Promise<{ kind: string; token?: string }>;
      bindChild(request: { scopeKey: string; requestId: string; token: string; childPid: number }): Promise<{ kind: string }>;
      spawnProtectedChild(command: string[], lease: { scopeKey: string; requestId: string; token: string }): { pid: number; settled: Promise<number>; resume(): void };
      release(request: { scopeKey: string; requestId: string; token: string }): Promise<void>;
      removeRequestId(): Promise<void>;
    },
  ) => {
    const requestId = dependencies.createRequestId();
    await dependencies.persistRequestId(requestId);
    const grant = await dependencies.acquire({ scopeKey: input.scopeKey, owner: input.owner, requestId });
    if (grant.kind !== 'granted' || !grant.token) return { kind: 'refused', reason: 'UNKNOWN' };
    const lease = { scopeKey: input.scopeKey, requestId, token: grant.token };
    const child = dependencies.spawnProtectedChild(input.command, lease);
    await dependencies.bindChild({ ...lease, childPid: child.pid });
    child.resume();
    const exitCode = await child.settled;
    await dependencies.release(lease);
    await dependencies.removeRequestId();
    return { kind: 'completed', exitCode };
  },
}));

const { reapWorktreesCommand } = await import('../../../src/cli/reap-worktrees.js');

describe('reap-worktrees wrapper custody', () => {
  beforeEach(() => {
    captured.argv = [];
    captured.env = {};
    process.exitCode = undefined;
    vi.spyOn(process, 'kill').mockReturnValue(true);
  });

  it('W01 propagates the selected instance to the protected child command', async () => {
    await reapWorktreesCommand.parseAsync([
      '--owner', 'fixture', '--instance', 'isolated-fixture', '--repo', process.cwd(),
    ], { from: 'user' });

    expect(captured.argv).toContain('--instance');
    expect(captured.argv).toContain('isolated-fixture');
    expect(captured.env.CTX_INSTANCE_ID).toBe('isolated-fixture');
  });

  it('W02 binds the protected child framework root to the selected repository', async () => {
    await reapWorktreesCommand.parseAsync([
      '--owner', 'fixture', '--instance', 'isolated-fixture', '--repo', process.cwd(),
    ], { from: 'user' });

    expect(captured.env.CTX_FRAMEWORK_ROOT).toBe(process.cwd());
  });
});
