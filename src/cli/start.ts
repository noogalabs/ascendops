import { Command } from 'commander';
import { stripSessionCredentialFromEnv } from '../utils/env.js';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { execSync, spawn, spawnSync } from 'child_process';
import { IPCClient } from '../daemon/ipc-server.js';
import { requestKeepAlive } from './_finalize.js';
import { atomicWriteSync } from '../utils/atomic.js';

const IS_WINDOWS = platform() === 'win32';
const SAFE_CMD = /^[@a-z0-9._/-]+$/i;

function commandExists(cmd: string): boolean {
  if (!SAFE_CMD.test(cmd)) return false;
  const which = IS_WINDOWS ? 'where' : 'which';
  const result = spawnSync(which, [cmd], { stdio: 'pipe' });
  return result.status === 0;
}

export const startCommand = new Command('start')
  .argument('[agent]', 'Specific agent to start (starts all if omitted)')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--foreground', 'Run daemon in foreground (no PM2, for debugging)')
  .description('Start the cortextOS daemon and agents')
  .action(async (agent: string | undefined, options: { instance: string; foreground?: boolean }) => {
    const ipc = new IPCClient(options.instance);
    const daemonRunning = await ipc.isDaemonRunning();

    if (!daemonRunning) {
      const projectRoot = process.cwd();
      const daemonScript = join(projectRoot, 'dist', 'daemon.js');

      if (!existsSync(daemonScript)) {
        console.error('Daemon not built. Run: npm run build');
        process.exit(1);
      }

      const ctxRoot = join(homedir(), '.cortextos', options.instance);

      // Try reading org from enabled-agents.json
      let org = '';
      const enabledPath = join(ctxRoot, 'config', 'enabled-agents.json');
      if (existsSync(enabledPath)) {
        try {
          const agents = JSON.parse(readFileSync(enabledPath, 'utf-8'));
          const first = Object.values(agents as Record<string, any>)[0] as any;
          if (first?.org) org = first.org;
        } catch { /* ignore */ }
      }

      // The daemon is NOT an agent session. If this CLI was invoked from an agent
      // PTY, process.env carries the session credential; copying it here would
      // hand every daemon subprocess a liveness claim it did not earn.
      const daemonEnv = {
        ...stripSessionCredentialFromEnv(process.env),
        CTX_INSTANCE_ID: options.instance,
        CTX_ROOT: ctxRoot,
        CTX_FRAMEWORK_ROOT: projectRoot,
        CTX_PROJECT_ROOT: projectRoot,
        ...(org ? { CTX_ORG: org } : {}),
      };

      if (options.foreground) {
        // Run in foreground (blocking) — useful for debugging
        console.log('Starting cortextOS daemon in foreground...');
        console.log('(Press Ctrl+C to stop)\n');
        const child = spawn(process.execPath, [daemonScript, '--instance', options.instance], {
          stdio: 'inherit',
          env: daemonEnv,
        });
        child.on('exit', (code) => process.exit(code || 0));
        process.on('SIGINT', () => child.kill('SIGTERM'));
        process.on('SIGTERM', () => child.kill('SIGTERM'));
        process.on('exit', () => { try { child.kill(); } catch { /* already dead */ } });
        // This command intentionally stays attached to the foreground daemon
        // child. Opt out of the CLI's drain-safe forced exit (see _finalize.ts);
        // otherwise the entry's finalizeProcess(0) would fire when this action
        // returns and the process.on('exit') handler above would kill the daemon.
        requestKeepAlive();
        return;
      }

      if (commandExists('pm2')) {
        // PM2 available — use ecosystem or direct pm2 start
        const ecosystemPath = join(projectRoot, 'ecosystem.config.js');
        if (existsSync(ecosystemPath)) {
          // pm2 inherits the calling shell's env by design, so a daemon started from
          // an agent PTY would hand every PM2-managed process the session credential —
          // and the dashboard's completeTask path would then refresh a wedged agent's
          // heartbeat. There is no env option by default here, so inheritance is
          // IMPLICIT, which is why the census could not see these sites at all.
          console.log('Starting cortextOS daemon via PM2...');
          try {
            execSync('pm2 start ecosystem.config.js', { stdio: 'inherit', cwd: projectRoot, env: stripSessionCredentialFromEnv(process.env) });
            execSync('pm2 save', { stdio: 'inherit', cwd: projectRoot, env: stripSessionCredentialFromEnv(process.env) });
            console.log('\nDaemon started. Use `cortextos status` to check agents.');
            if (IS_WINDOWS) {
              console.log('\nFor auto-start on Windows boot:');
              console.log('  npm install -g pm2-windows-startup');
              console.log('  pm2-windows-startup install');
            }
          } catch {
            console.error('PM2 start failed. Try: pm2 start ecosystem.config.js');
          }
        } else {
          console.log('Generating ecosystem.config.js and starting...');
          try {
            execSync(`node ${JSON.stringify(join(projectRoot, 'dist', 'cli.js'))} ecosystem`, {
              stdio: 'inherit',
              cwd: projectRoot,
              env: daemonEnv,
            });
            execSync('pm2 start ecosystem.config.js', { stdio: 'inherit', cwd: projectRoot, env: stripSessionCredentialFromEnv(process.env) });
            execSync('pm2 save', { stdio: 'inherit', cwd: projectRoot, env: stripSessionCredentialFromEnv(process.env) });
            console.log('\nDaemon started. Use `cortextos status` to check agents.');
            if (IS_WINDOWS) {
              console.log('\nFor auto-start on Windows boot:');
              console.log('  npm install -g pm2-windows-startup');
              console.log('  pm2-windows-startup install');
            }
          } catch {
            console.error('Failed to generate ecosystem and start. Try manually:');
            console.error('  cortextos ecosystem && pm2 start ecosystem.config.js');
          }
        }
      } else {
        // No PM2 — spawn daemon detached in background
        console.log('PM2 not found. Starting daemon directly (background)...');
        console.log('(Install PM2 for persistence across reboots: npm install -g pm2)\n');

        const logDir = join(ctxRoot, 'logs');
        const logFile = join(logDir, 'daemon.log');

        // Spawn-with-retry: a detached spawn() succeeds from Node's POV even if
        // the child dies milliseconds later (bad state dir, permission denied
        // on logs, missing dist/daemon.js). Without retries, the user sees
        // "Daemon spawned" and assumes everything is fine while the daemon is
        // actually dead. Retry up to 2x with 2s backoff; if still not running,
        // exit non-zero so the operator gets an actionable error.
        const MAX_SPAWN_ATTEMPTS = 3;
        const SPAWN_RETRY_BACKOFF_MS = 2000;
        const ipc2 = new IPCClient(options.instance);
        let running = false;

        for (let attempt = 1; attempt <= MAX_SPAWN_ATTEMPTS && !running; attempt++) {
          const child = spawn(process.execPath, [daemonScript, '--instance', options.instance], {
            detached: true,
            stdio: ['ignore', 'ignore', 'ignore'],
            env: daemonEnv,
            cwd: projectRoot,
            windowsHide: true,
          });
          child.unref();

          // Give it a moment to bootstrap, then check.
          await new Promise(r => setTimeout(r, 1500));
          running = await ipc2.isDaemonRunning();
          if (!running && attempt < MAX_SPAWN_ATTEMPTS) {
            console.log(`Daemon spawn attempt ${attempt}/${MAX_SPAWN_ATTEMPTS} did not produce a running daemon. Retrying in ${SPAWN_RETRY_BACKOFF_MS / 1000}s...`);
            await new Promise(r => setTimeout(r, SPAWN_RETRY_BACKOFF_MS));
          }
        }

        if (running) {
          console.log('Daemon started successfully (background process).');
          console.log('Note: daemon will stop if you close this terminal session.');
          console.log('Install PM2 for persistence: npm install -g pm2');
        } else {
          console.error(`Daemon failed to start after ${MAX_SPAWN_ATTEMPTS} attempts.`);
          console.error('Check the daemon log for the root cause:');
          console.error(`  ${logFile}`);
          console.error('Common causes: missing dist/daemon.js (run `npm run build`), permission denied on logs dir, bad CTX_ROOT.');
          process.exit(1);
        }
      }
      return;
    }

    // Daemon already running
    if (agent) {
      // Auto-register in enabled-agents.json if not already present
      const ctxRoot = join(homedir(), '.cortextos', options.instance);
      const enabledPath = join(ctxRoot, 'config', 'enabled-agents.json');
      let enabledAgents: Record<string, any> = {};
      try {
        if (existsSync(enabledPath)) {
          enabledAgents = JSON.parse(readFileSync(enabledPath, 'utf-8'));
        }
      } catch { /* ignore */ }

      if (!enabledAgents[agent]) {
        // Try to detect org from existing entries or project structure
        const existingOrg = Object.values(enabledAgents as Record<string, any>).find((e: any) => e.org)?.org;
        enabledAgents[agent] = {
          enabled: true,
          status: 'configured',
          ...(existingOrg ? { org: existingOrg } : {}),
        };
        mkdirSync(join(ctxRoot, 'config'), { recursive: true });
        // Atomic temp-file + rename: a torn write to the fleet registry would
        // disable every agent on next boot. atomicWriteSync appends the newline.
        atomicWriteSync(enabledPath, JSON.stringify(enabledAgents, null, 2));
        console.log(`  Registered ${agent} in enabled-agents.json`);
      }

      console.log(`Starting agent: ${agent}`);
      const response = await ipc.send({ type: 'start-agent', agent, source: 'cortextos start' });
      if (response.success) {
        console.log(`  ${response.data}`);
      } else {
        console.error(`  Error: ${response.error}`);
        // Fail loud: the requested start did not happen. Drain-safe — only
        // human-readable lines were written, so set exitCode and let the
        // top-level finalizeProcess drain+exit (no raw process.exit).
        process.exitCode = 1;
      }
    } else {
      const response = await ipc.send({ type: 'status', source: 'cortextos start' });
      if (response.success) {
        const statuses = response.data as any[];
        if (statuses.length === 0) {
          console.log('No agents configured. Add one with: cortextos add-agent <name>');
        } else {
          console.log('Agent statuses:');
          for (const s of statuses) {
            console.log(`  ${s.name}: ${s.status} (pid: ${s.pid || '-'})`);
          }
        }
      }
    }
  });
