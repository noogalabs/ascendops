import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { Command } from 'commander';
import { IPCClient } from '../daemon/ipc-server';
import { DurableLeaseRequest } from '../daemon/durable-lease-request';
import { createNodeDurableFs } from '../daemon/node-durable-state';
import { runNativeFullFsync } from '../daemon/native-peer-credential-helper';
import { superviseLeaseSpan } from '../daemon/worktree-lease-supervisor';

function canonicalRepositoryScope(repoRoot: string): string {
  const common = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const absolute = resolve(repoRoot, common);
  return `repo:${realpathSync(absolute)}`;
}

export const reapWorktreesCommand = new Command('reap-worktrees')
  .description('Safely reap eligible agent scratch worktrees (dry-run by default)')
  .requiredOption('--owner <agent>', 'Only consider scratch worktrees owned by this agent')
  .option('--delete', 'Execute removals; otherwise print the dry-run plan', false)
  .option('--instance <id>', 'cortextOS instance ID', 'default')
  .option('--repo <path>', 'Repository/framework root', process.cwd())
  .action(async (options: { owner: string; delete: boolean; instance: string; repo: string }) => {
    if (process.platform === 'win32') {
      console.error('worktree-reaper-disabled-no-measured-win32-identity');
      process.exitCode = 2;
      return;
    }
    const repoRoot = realpathSync(options.repo);
    const scopeKey = canonicalRepositoryScope(repoRoot);
    const ctxRoot = join(homedir(), '.cortextos', options.instance);
    const nativeHelper = join(repoRoot, 'dist', 'native', 'peer-credentials');
    const request = new DurableLeaseRequest({
      directory: join(ctxRoot, 'state', '.worktree-lease-requests'),
      scopeKey,
      owner: options.owner,
      platform: process.platform,
      fs: createNodeDurableFs({ fullFsync: path => runNativeFullFsync(path, nativeHelper) }),
      createRequestId: randomUUID,
      createAttemptNonce: randomUUID,
    });
    const existingRequestId = request.loadExisting();
    const ipc = new IPCClient(options.instance);
    const result = await superviseLeaseSpan({
      scopeKey,
      owner: options.owner,
      command: [
        'bash',
        join(repoRoot, 'scripts', 'worktree', 'reap-agent-worktrees.sh'),
        '--owner', options.owner,
        '--instance', options.instance,
        ...(options.delete ? ['--delete'] : []),
      ],
    }, {
      createRequestId: () => existingRequestId ?? randomUUID(),
      persistRequestId: async requestId => { request.persist(requestId); },
      acquire: async acquire => {
        const response = await ipc.send({
          type: 'acquire-worktree-lease',
          source: 'cortextos reap-worktrees',
          data: acquire,
        });
        if (!response.success) return { kind: 'refused' as const, reason: response.error ?? 'UNKNOWN' };
        const data = response.data as { kind: 'granted'; token: string };
        return { kind: 'granted' as const, token: data.token };
      },
      bindChild: async binding => {
        const response = await ipc.send({
          type: 'bind-worktree-lease-child',
          source: 'cortextos reap-worktrees',
          data: binding,
        });
        return response.success
          ? { kind: 'bound' as const }
          : { kind: 'refused' as const, reason: response.error ?? 'UNKNOWN' };
      },
      spawnProtectedChild: (command, lease) => {
        const child = spawn('bash', ['-c', 'holder=$PPID; pgid=$$; (while kill -0 "$holder" 2>/dev/null && kill -0 "$pgid" 2>/dev/null; do sleep 0.1; done; kill -0 "$holder" 2>/dev/null || kill -TERM -- "-$pgid" 2>/dev/null) & kill -STOP $$; exec "$@"', 'lease-child', ...command], {
          cwd: repoRoot,
          stdio: 'inherit',
          detached: true,
          env: {
            ...process.env,
            CTX_FRAMEWORK_ROOT: repoRoot,
            CTX_INSTANCE_ID: options.instance,
            CTX_WORKTREE_LEASE_SCOPE: lease.scopeKey,
            CTX_WORKTREE_LEASE_REQUEST_ID: lease.requestId,
            CTX_WORKTREE_LEASE_TOKEN: lease.token,
          },
        });
        if (!child.pid) throw new Error('protected child pid unavailable');
        const childPid = child.pid;
        return {
          pid: childPid,
          settled: new Promise<number>((resolveExit, reject) => {
            child.once('error', reject);
            child.once('exit', code => resolveExit(code ?? 1));
          }),
          resume: () => process.kill(-childPid, 'SIGCONT'),
          terminate: () => process.kill(-childPid, 'SIGTERM'),
        };
      },
      release: async release => {
        const response = await ipc.send({
          type: 'release-worktree-lease',
          source: 'cortextos reap-worktrees',
          data: release,
        });
        if (!response.success) throw new Error(response.error ?? 'lease release failed');
      },
      removeRequestId: async () => { request.removeAfterRelease(); },
      supervisorDeath: new Promise<void>(() => {}),
    });
    if (result.kind === 'refused') {
      console.error(`REFUSED: ${result.reason}`);
      process.exitCode = 1;
    } else if (result.kind === 'supervisor-died') {
      process.exitCode = 2;
    } else {
      process.exitCode = result.exitCode;
    }
  });
