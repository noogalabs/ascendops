/**
 * `cortextos update` — customer-friendly opt-in update mechanism MVP.
 *
 * Wraps the existing `cortextos bus check-upstream` machinery with a
 * confirmation prompt before applying. Per David's directive (locked
 * 2026-05): the customer must opt in to each apply; updates do NOT run
 * automatically. The daily 06:23 ET cron only CHECKS (no --apply); this
 * command is how the customer hits "yes" when there's something to pull.
 *
 * Flow:
 *   1. Run check-upstream in dry-run mode (--apply NOT set).
 *   2. Pretty-print the result:
 *      - up_to_date: print a one-liner, exit 0
 *      - error: print error + hint, exit 1 (preserves operator awareness)
 *      - updates_available: print commit count + diff stat, prompt y/N
 *   3. On y, require a clean checkout, merge, install locked dependencies,
 *      and rebuild before reporting success. Failures retain recovery guidance.
 *   4. On N or anything else, exit 0 without applying.
 *
 * Flags:
 *   --yes / -y       skip the confirmation prompt (for scripted use)
 *   --check          only check; never apply (alias for the daily cron)
 */
import { isDefaultBranch } from '../../scripts/build-branch.mjs';
import { Command } from 'commander';
import { createInterface, type Interface } from 'readline';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, lstatSync, chmodSync, writeFileSync, rmSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { generateEcosystem } from './ecosystem.js';
import { checkUpstream } from '../bus/metrics.js';
import { resolveMemberCheckout } from './member-checkout.js';
import { stripSessionCredentialFromEnv } from '../utils/env.js';

function rl(): Interface {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(iface: Interface, question: string): Promise<string> {
  return new Promise(resolve => iface.question(question, answer => resolve(answer.trim())));
}

function findFrameworkRoot(memberMode: boolean): string {
  if (memberMode) return resolveMemberCheckout();
  const candidates = [
    process.env.CTX_FRAMEWORK_ROOT,
    process.env.CORTEXTOS_DIR,
    process.env.CTX_PROJECT_ROOT,
    process.cwd(),
    join(homedir(), 'cortextos'),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(join(c, 'package.json'))) {
      // Verify it's actually cortextos (not a random package.json).
      try {
        const pkg = JSON.parse(readFileSync(join(c, 'package.json'), 'utf-8'));
        if (pkg.name === 'cortextos' || pkg.name === 'ascendops') return c;
      } catch { /* ignore */ }
    }
  }
  // Fall back to process.cwd anyway — let checkUpstream surface the not-a-repo error.
  return process.cwd();
}

interface UpdateOptions {
  yes?: boolean;
  check?: boolean;
}

async function runUpdate(opts: UpdateOptions, command: Command): Promise<void> {
  const memberMode = command.parent?.name() === 'ascendops';
  const frameworkRoot = findFrameworkRoot(memberMode);

  const backupRoot = join(frameworkRoot, '.ascendops-update-backups');
  const pendingBuild = join(backupRoot, 'merged-not-built.json');
  let retryBuild = false;
  try {
    if (existsSync(pendingBuild) && !lstatSync(backupRoot).isSymbolicLink() && !lstatSync(pendingBuild).isSymbolicLink()) {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: frameworkRoot, encoding: 'utf8', env: stripSessionCredentialFromEnv(process.env) }).trim();
      retryBuild = JSON.parse(readFileSync(pendingBuild, 'utf8')).head === head;
    }
  } catch { /* A missing or invalid marker cannot authorize a rebuild. */ }
  // Step 1: check (no apply).
  const status = checkUpstream(frameworkRoot, { apply: false }) as any;

  if (status.status === 'error') {
    console.error(`Error: ${status.error}`);
    if (status.hint) console.error(`  Hint: ${status.hint}`);
    process.exit(1);
  }

  if (status.status === 'up_to_date') {
    console.log('Already up to date — no upstream changes available.');
    if (opts.check || !retryBuild) process.exit(0);
    console.log('Reinstalling and rebuilding the current checkout.');
  }

  // Updates available.
  const commitCount = status.commits ?? '?';
  const diffStat = status.diff_stat || '';
  console.log('');
  console.log(`Upstream updates available: ${commitCount} commit(s) behind.`);
  if (diffStat) console.log(`  ${diffStat}`);
  console.log('');

  if (opts.check) {
    console.log('--check mode — exiting without applying.');
    process.exit(0);
  }

  let confirmed = !!opts.yes;
  if (!confirmed) {
    const iface = rl();
    try {
      const answer = await ask(iface, 'Apply the upstream updates now? [y/N]: ');
      confirmed = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
    } finally {
      iface.close();
    }
  }

  if (!confirmed) {
    console.log('Aborted — no updates applied. Re-run when ready.');
    process.exit(0);
  }

  console.log('');
  console.log('Applying upstream updates...');
  const execOptions = { cwd: frameworkRoot, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], env: stripSessionCredentialFromEnv(process.env) };
  let previousHead: string;
  let generatedConfig: { instance: string; org: string; backup: string } | undefined;
  function restoreGeneratedConfig(): void {
    if (!generatedConfig) return;
    try {
      copyFileSync(generatedConfig.backup, join(frameworkRoot, 'ecosystem.config.js'));
    } catch {
      console.error(`Could not restore the generated PM2 config. Restore it from ${generatedConfig.backup} before restarting.`);
    }
  }
  function interrupt(signal: 'SIGINT' | 'SIGTERM'): void {
    restoreGeneratedConfig();
    console.error(`Update interrupted (${signal}). Saved PM2 config backup: ${generatedConfig?.backup}. Recover the checkout before restarting agents.`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }
  const onSigint = () => interrupt('SIGINT');
  const onSigterm = () => interrupt('SIGTERM');
  try {
  try {
    if (memberMode) {
      const branch = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], execOptions).trim();
      let hasOrigin = false;
      try { execFileSync('git', ['remote', 'get-url', 'origin'], execOptions); hasOrigin = true; } catch { /* upstream-only install */ }
      const expectedTracking = hasOrigin ? 'origin/main' : 'upstream/main';
      const tracking = execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], execOptions).trim();
      const operationPending = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply'].some(name =>
        existsSync(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', name], execOptions).trim()));
      if (!isDefaultBranch(branch) || tracking !== expectedTracking || operationPending) {
        throw new Error(`Member updates require main tracking ${expectedTracking}, with no merge or rebase in progress. Finish your current work and switch to the tracked main branch before retrying.`);
      }
    }
    if (existsSync(backupRoot) && (!lstatSync(backupRoot).isDirectory() || lstatSync(backupRoot).isSymbolicLink())) throw new Error('invalid backup directory');
    if (existsSync(pendingBuild) && (!lstatSync(pendingBuild).isFile() || lstatSync(pendingBuild).isSymbolicLink())) throw new Error('invalid rebuild marker');
    const dirt = execFileSync('git', ['status', '--porcelain'], execOptions).trimEnd();
    if (dirt === ' M ecosystem.config.js') {
      // Only exact generator output is disposable; edited or staged configs are work.
      const original = readFileSync(join(frameworkRoot, 'ecosystem.config.js'), 'utf8');
      const instanceMatch = original.match(/args: '--instance ' \+ \(process\.env\.CTX_INSTANCE_ID \|\| ("(?:[^"\\]|\\.)*")\)/);
      const orgMatch = original.match(/CTX_ORG: process\.env\.CTX_ORG \|\| ("(?:[^"\\]|\\.)*")/);
      if (instanceMatch && orgMatch) {
        const instance: string = JSON.parse(instanceMatch[1]);
        const org: string = JSON.parse(orgMatch[1]);
        if (!existsSync(backupRoot)) mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
        if (!lstatSync(backupRoot).isDirectory() || lstatSync(backupRoot).isSymbolicLink()) throw new Error('invalid backup directory');
        chmodSync(backupRoot, 0o700);
        const savedDir = mkdtempSync(join(backupRoot, 'update-'));
        const probe = join(savedDir, 'generated.js');
        generateEcosystem({ instance, org, output: probe, quiet: true }, frameworkRoot);
        if (existsSync(probe) && readFileSync(probe, 'utf8') === original) {
          const backup = join(savedDir, 'ecosystem.config.js');
          writeFileSync(backup, original, { mode: 0o600 });
          generatedConfig = { instance, org, backup };
          console.log(`Saved generated PM2 config before update: ${backup}`);
          process.once('SIGINT', onSigint);
          process.once('SIGTERM', onSigterm);
          execFileSync('git', ['restore', '--source=HEAD', '--worktree', '--', 'ecosystem.config.js'], execOptions);
        } else rmSync(savedDir, { recursive: true, force: true });
      }
    }
    if (dirt.trim() && !generatedConfig) {
      console.error('Update refused: checkout has uncommitted changes. Commit or stash your work, then retry update.');
      process.exit(1);
    }
    previousHead = execFileSync('git', ['rev-parse', 'HEAD'], execOptions).trim();
    if (!/^[0-9a-f]{40}$/.test(previousHead)) throw new Error('invalid HEAD');
  } catch (error) {
    restoreGeneratedConfig();
    if (generatedConfig) console.error(`Your generated PM2 config is saved at ${generatedConfig.backup}.`);
    console.error(`Update refused during preflight: ${error instanceof Error ? error.message : "invalid checkout"}. Verify the checkout and retry update.${generatedConfig ? ` Saved PM2 config backup: ${generatedConfig.backup}.` : ''}`);
    process.exit(1);
  }
  // checkUpstream's apply path gates on CORTEXTOS_CONFIRM_UPSTREAM_MERGE — the
  // customer's interactive `y` (or --yes flag) IS that confirmation, so set it
  // here before calling. Without this, apply short-circuits with a refusal.
  const previousConfirmation = process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE;
  let applied: any;
  try {
    process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE = 'yes';
    applied = status.status === 'up_to_date' ? { status: 'merged' } : checkUpstream(frameworkRoot, { apply: true });
  } catch {
    applied = { status: 'error' };
  } finally {
    if (previousConfirmation === undefined) delete process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE;
    else process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE = previousConfirmation;
  }
  function recovery(stage: string, detail: string): void {
    restoreGeneratedConfig();
    const state = applied.status !== 'merged' ? 'The update merge did not complete.' : stage === 'PM2 config regeneration' ? 'The runtime is rebuilt but the PM2 config was not regenerated.' : 'The checkout is merged but the runtime is not rebuilt.';
    if (generatedConfig) console.error(`Your generated PM2 config is saved at ${generatedConfig.backup}.`);
    console.error(`${stage} failed. ${state} In ${frameworkRoot}, ${detail}; retry with ${memberMode ? "ascendops" : "cortextos"} update. To roll back, first save any new work, then run: git reset --hard ${previousHead}. This returns source only; no rollback build is instructed. The rolled-back checkout is behind upstream until the next update. The installed build and dependencies may be inconsistent, including after source rollback. Do not restart your agents until a successful retry finishes installation and rebuild. Saved update state directory: ${backupRoot}.${generatedConfig ? ` Saved PM2 config backup: ${generatedConfig.backup}.` : ''}`);
  }
  if (applied.status !== 'merged') {
    if (applied.status === 'conflict') {
      // checkUpstream already attempts abort; retry for a caller that left a merge pending.
      try { execFileSync('git', ['merge', '--abort'], execOptions); } catch { /* may already be aborted */ }
    }
    recovery('Upstream merge', 'resolve the merge error and retry update');
    process.exit(1);
  }
  try {
    if (!existsSync(backupRoot)) mkdirSync(backupRoot, { mode: 0o700 });
    chmodSync(backupRoot, 0o700);
    const mergedHead = execFileSync('git', ['rev-parse', 'HEAD'], execOptions).trim();
    writeFileSync(pendingBuild, JSON.stringify({ head: mergedHead }), { mode: 0o600 });
  } catch {
    recovery('Rebuild checkpoint', 'restore write access to the member update backup directory');
    process.exit(1);
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmOptions = { cwd: frameworkRoot, stdio: 'inherit' as const, shell: process.platform === 'win32', env: { ...stripSessionCredentialFromEnv(process.env), ASCENDOPS_MEMBER_UPDATE: memberMode ? '1' : '' } };
  try {
    execFileSync(npm, ['ci'], npmOptions);
  } catch {
    recovery('Dependency installation', 'fix the dependency installation error');
    process.exit(1);
  }
  try {
    execFileSync(npm, ['run', 'build'], npmOptions);
  } catch {
    recovery('Build', 'fix the build error');
    process.exit(1);
  }
  if (generatedConfig) {
    try {
      const regenerated = join(dirname(generatedConfig.backup), 'regenerated.js');
      execFileSync(process.execPath, [join(frameworkRoot, 'dist', 'cli.js'), 'ecosystem', '--instance', generatedConfig.instance, '--org', generatedConfig.org, '--output', regenerated, '--quiet'], {
        ...npmOptions,
        env: { ...stripSessionCredentialFromEnv(process.env), CTX_FRAMEWORK_ROOT: frameworkRoot, CTX_PROJECT_ROOT: frameworkRoot },
      });
      if (!existsSync(regenerated)) throw new Error('config missing');
      copyFileSync(regenerated, join(frameworkRoot, 'ecosystem.config.js'));
      console.log(`Regenerated PM2 config; previous generated config is saved at ${generatedConfig.backup}.`);
    } catch {
      recovery('PM2 config regeneration', 'retry the ecosystem command before restarting');
      process.exit(1);
    }
  }
  rmSync(pendingBuild, { force: true });
  const cli = command.parent?.name() === 'ascendops' ? 'ascendops' : 'cortextos';
  console.log(`Updates applied, dependencies installed, and runtime rebuilt. Restart your agents with ${cli} restart <agent> and restart the daemon (for PM2: pm2 restart cortextos-daemon) to use the new runtime.`);
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

export const updateCommand = new Command('update')
  .description('Check for and (with confirmation) apply framework updates from upstream')
  .option('-y, --yes', 'Skip the confirmation prompt (apply without asking)')
  .option('--check', 'Only check — never apply, even with --yes')
  .action(runUpdate);
