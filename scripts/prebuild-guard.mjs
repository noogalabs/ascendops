#!/usr/bin/env node

/**
 * Protect the deployed checkout from feature-branch build/dev commands that
 * would replace its shared dist output. The guard keys on live-tree identity,
 * not branch name, so isolated feature clones remain buildable.
 *
 * Known limit: direct `npx tsup` bypasses npm lifecycle hooks.
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { dirname, join, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

export function getRepoRoot() {
  return realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf-8', ...options });
}

function resultError(label, result, allowedAbsenceStatuses = new Set()) {
  if (result.error) return `${label}: ${result.error.message}`;
  if (result.status !== 0 && !allowedAbsenceStatuses.has(result.status)) {
    return `${label}: exited ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ''}`;
  }
  return null;
}

function containedBy(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function detectLiveTree(repoRoot) {
  const root = realpathSync(repoRoot);
  const signals = [];
  const errors = [];

  try {
    const packageName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).name;
    const result = run('npm', ['root', '-g'], { shell: process.platform === 'win32' });
    const error = resultError('D1 global-package identity', result);
    if (error) errors.push(error);
    else if (result.status === 0 && packageName) {
      const globalPackage = join(result.stdout.trim(), packageName);
      if (existsSync(globalPackage) && realpathSync(globalPackage) === root) {
        signals.push('D1 global-package identity');
      }
    }
  } catch (error) {
    errors.push(`D1 global-package identity: ${error}`);
  }

  try {
    const result = process.platform === 'win32'
      ? run('where', ['cortextos'])
      : run('/bin/sh', ['-c', 'command -v cortextos']);
    const error = resultError('D2 global-bin containment', result, new Set([1, 126, 127]));
    if (error) errors.push(error);
    else if (result.status === 0) {
      const commandPath = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (commandPath && containedBy(realpathSync(commandPath), root)) {
        signals.push('D2 global-bin containment');
      }
    }
  } catch (error) {
    errors.push(`D2 global-bin containment: ${error}`);
  }

  try {
    if (existsSync(join(root, '.cortextos-live-tree'))) {
      signals.push('D3 explicit marker');
    }
  } catch (error) {
    errors.push(`D3 explicit marker: ${error}`);
  }

  return { live: signals.length > 0, signals, errors };
}

export function decide({ ci, live, branch, override }) {
  if (ci) {
    return { allow: true, code: 'ci', messages: ['CI environment detected; build allowed.'] };
  }
  if (!live) {
    return { allow: true, code: 'isolated', messages: ['Build allowed in isolated checkout.'] };
  }
  if (branch === 'main') {
    return { allow: true, code: 'live-main', messages: ['Build allowed in live main checkout.'] };
  }
  if (override) {
    return {
      allow: true,
      code: 'live-feature-override',
      messages: [`WARNING: DANGER override accepted for live checkout branch ${branch}.`],
    };
  }
  return {
    allow: false,
    code: 'live-feature-blocked',
    messages: [
      `BLOCKED: refusing to build the live checkout from branch ${branch}; switch to main or use an isolated clone.`,
      'For a compile-only check run: npx tsc --noEmit',
      'DANGER override, only with explicit authorization: ALLOW_FEATURE_BUILD=1 npm run build',
    ],
  };
}

function currentBranch(repoRoot, errors) {
  const result = run('git', ['-C', repoRoot, 'branch', '--show-current']);
  const error = resultError('branch detection', result);
  if (error) errors.push(error);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : 'detached';
}

export function main() {
  const repoRoot = getRepoRoot();
  const detection = detectLiveTree(repoRoot);
  const branch = currentBranch(repoRoot, detection.errors);
  const decision = decide({
    ci: process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true',
    live: detection.live,
    branch,
    override: process.env.ALLOW_FEATURE_BUILD === '1',
  });
  const lines = [
    `[prebuild-guard] decision=${decision.code} branch=${branch}`,
    `[prebuild-guard] live detectors: ${detection.signals.length ? detection.signals.join(', ') : 'none'}`,
    `[prebuild-guard] detector errors: ${detection.errors.length ? detection.errors.join(' | ') : 'none'}`,
    ...decision.messages.map((message) => `[prebuild-guard] ${message}`),
  ];
  const print = decision.allow ? console.log : console.error;
  for (const line of lines) print(line);
  return decision.allow ? 0 : 1;
}

export function isDirectRun(argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argvPath);
  } catch {
    return import.meta.url === pathToFileURL(argvPath).href;
  }
}

if (isDirectRun()) {
  process.exitCode = main();
}
