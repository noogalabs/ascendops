import { Command } from 'commander';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { initCommand } from './init.js';
import { addAgentCommand } from './add-agent.js';
import { materializeOnboardingCommand } from './onboarding-skill.js';
import { startCommand } from './start.js';
import { stopCommand } from './stop.js';
import { restartCommand } from './restart.js';
import { statusCommand } from './status.js';
import { doctorCommand } from './doctor.js';
import { busCommand } from './bus.js';
import { listAgentsCommand } from './list-agents.js';
import { notifyAgentCommand } from './notify-agent.js';
import { listSkillsCommand } from './list-skills.js';
import { installCommand } from './install.js';
import { enableAgentCommand, disableAgentCommand } from './enable-agent.js';
import { ecosystemCommand } from './ecosystem.js';
import { uninstallCommand } from './uninstall.js';
import { dashboardCommand } from './dashboard.js';
import { tunnelCommand } from './tunnel.js';
import { getConfigCommand } from './get-config.js';
import { goalsCommand } from './goals.js';
import { setupCommand } from './setup.js';
import { configureCommand } from './configure.js';
import { spawnWorkerCommand, terminateWorkerCommand, listWorkersCommand, injectWorkerCommand } from './workers.js';
import { importAgentCommand } from './import-agent.js';
import { botCommand } from './bot.js';
import { detectChatIdCommand } from './detect-chat-id.js';
import { finalizeProcess } from './_finalize.js';
import { updateCommand } from './update.js';
import { supportAccessCommand } from './support-access.js';
import { reapWorktreesCommand } from './reap-worktrees.js';
import { withWorktreeLeaseCommand } from './with-worktree-lease.js';
import { checkWorktreeLeaseCommand } from './check-worktree-lease.js';
import { buzzCommand } from './buzz.js';
import { lifecycleCommand } from './lifecycle.js';

const program = new Command();

program
  .name('cortextos')
  .description('Persistent 24/7 Claude Code agents with multi-agent orchestration')
  .version('0.1.1');

program.addCommand(initCommand);
program.addCommand(installCommand);
program.addCommand(addAgentCommand);
program.addCommand(materializeOnboardingCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(restartCommand);
program.addCommand(statusCommand);
program.addCommand(doctorCommand);
program.addCommand(busCommand);
program.addCommand(listAgentsCommand);
program.addCommand(notifyAgentCommand);
program.addCommand(listSkillsCommand);
program.addCommand(enableAgentCommand);
program.addCommand(disableAgentCommand);
program.addCommand(ecosystemCommand);
program.addCommand(uninstallCommand);
program.addCommand(dashboardCommand);
program.addCommand(tunnelCommand);
program.addCommand(getConfigCommand);
program.addCommand(goalsCommand);
program.addCommand(setupCommand);
program.addCommand(configureCommand);
program.addCommand(spawnWorkerCommand);
program.addCommand(terminateWorkerCommand);
program.addCommand(listWorkersCommand);
program.addCommand(injectWorkerCommand);
program.addCommand(importAgentCommand);
program.addCommand(botCommand);
program.addCommand(updateCommand);
program.addCommand(detectChatIdCommand);
program.addCommand(supportAccessCommand);
program.addCommand(reapWorktreesCommand);
program.addCommand(withWorktreeLeaseCommand);
program.addCommand(checkWorktreeLeaseCommand);
program.addCommand(buzzCommand);
program.addCommand(lifecycleCommand);

// crash-alert: SessionEnd hook — cross-platform replacement for crash-alert.sh
const crashAlertCommand = new Command('crash-alert')
  .description('SessionEnd hook: send crash/restart notification via Telegram (cross-platform)')
  .action(() => {
    const hookPath = join(__dirname, 'hooks/hook-crash-alert.js');
    const result = spawnSync(process.execPath, [hookPath], { stdio: 'inherit' });
    process.exit(result.status ?? 0);
  });
program.addCommand(crashAlertCommand);

// Drain-safe process exit — forces a clean exit after the command's work
// completes, working around Node 25 keeping an inherited socket/pipe stdin
// handle ref'd (the intermittent "bus command hangs until stdin EOF" bug)
// without truncating un-flushed piped stdout. See ./_finalize.ts.
program
  .parseAsync(process.argv)
  // Respect a handler-set non-zero exit code (e.g. emitResult / fail-loud
  // handlers set process.exitCode = 1 instead of a raw process.exit so the
  // piped stdout envelope is drained before exit — see ./_finalize.ts).
  .then(() => finalizeProcess(typeof process.exitCode === 'number' ? process.exitCode : 0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    finalizeProcess(1);
  });
