import { Command } from 'commander';
import { IPCClient } from '../daemon/ipc-server';

export const checkWorktreeLeaseCommand = new Command('check-worktree-lease')
  .description('Fail unless the supplied opaque repository lease is currently held')
  .requiredOption('--scope <scope>')
  .requiredOption('--request-id <id>')
  .requiredOption('--token <token>')
  .option('--instance <id>', 'cortextOS instance ID', 'default')
  .action(async (options: { scope: string; requestId: string; token: string; instance: string }) => {
    const response = await new IPCClient(options.instance).send({
      type: 'check-worktree-lease',
      source: 'cortextos check-worktree-lease',
      data: { scopeKey: options.scope, requestId: options.requestId, token: options.token },
    });
    if (!response.success) {
      console.error(`REFUSED: ${response.error ?? 'lease check failed'}`);
      process.exitCode = 1;
    }
  });
