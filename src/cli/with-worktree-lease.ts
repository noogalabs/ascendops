import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { DurableLeaseRequest } from '../daemon/durable-lease-request';
import { IPCClient } from '../daemon/ipc-server';
import { runNativeFullFsync } from '../daemon/native-peer-credential-helper';
import { createNodeDurableFs } from '../daemon/node-durable-state';
import { superviseLeaseSpan } from '../daemon/worktree-lease-supervisor';

function repositoryScope(repoRoot: string): string {
  const common = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
  return `repo:${realpathSync(resolve(repoRoot, common))}`;
}

export const withWorktreeLeaseCommand = new Command('with-worktree-lease')
  .description('Run a repository writer while holding the daemon worktree lease')
  .requiredOption('--owner <agent>')
  .requiredOption('--repo <path>')
  .option('--instance <id>', 'cortextOS instance ID', 'default')
  .allowUnknownOption(true)
  .argument('<command...>')
  .action(async (command: string[], options: { owner: string; repo: string; instance: string }) => {
    const repoRoot = realpathSync(options.repo);
    const scopeKey = repositoryScope(repoRoot);
    const ctxRoot = join(homedir(), '.cortextos', options.instance);
    const helper = join(repoRoot, 'dist', 'native', 'peer-credentials');
    const request = new DurableLeaseRequest({
      directory: join(ctxRoot, 'state', '.worktree-lease-requests'),
      scopeKey,
      owner: options.owner,
      platform: process.platform,
      fs: createNodeDurableFs({ fullFsync: path => runNativeFullFsync(path, helper) }),
      createRequestId: randomUUID,
      createAttemptNonce: randomUUID,
    });
    const ipc = new IPCClient(options.instance);
    const existing = request.loadExisting();
    const result = await superviseLeaseSpan({ scopeKey, owner: options.owner, command }, {
      createRequestId: () => existing ?? randomUUID(),
      persistRequestId: async id => { request.persist(id); },
      acquire: async acquire => {
        const response = await ipc.send({ type: 'acquire-worktree-lease', source: 'cortextos with-worktree-lease', data: acquire });
        if (!response.success) return { kind: 'refused' as const, reason: response.error ?? 'UNKNOWN' };
        return response.data as { kind: 'granted'; token: string };
      },
      bindChild: async binding => {
        const response = await ipc.send({ type: 'bind-worktree-lease-child', source: 'cortextos with-worktree-lease', data: binding });
        return response.success
          ? { kind: 'bound' as const }
          : { kind: 'refused' as const, reason: response.error ?? 'UNKNOWN' };
      },
      spawnProtectedChild: (argv, lease) => {
        const child = spawn('bash', ['-c', 'holder=$PPID; pgid=$$; (while kill -0 "$holder" 2>/dev/null && kill -0 "$pgid" 2>/dev/null; do sleep 0.1; done; kill -0 "$holder" 2>/dev/null || kill -TERM -- "-$pgid" 2>/dev/null) & kill -STOP $$; exec "$@"', 'lease-child', ...argv], {
          cwd: repoRoot,
          stdio: 'inherit',
          detached: true,
          env: {
            ...process.env,
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
        const response = await ipc.send({ type: 'release-worktree-lease', source: 'cortextos with-worktree-lease', data: release });
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
