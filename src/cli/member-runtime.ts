import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, readdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname, relative, isAbsolute, sep } from 'path';
import { stripSessionCredentialFromEnv } from '../utils/env.js';

/** Build from the merged source without changing the installed runtime or dependencies. */
export function stageMemberRuntime(root: string, stateDirectory: string, sourceHead = 'HEAD'): string {
  const stage = mkdtempSync(join(stateDirectory, 'runtime-'));
  try {
  const env = { ...stripSessionCredentialFromEnv(process.env), ASCENDOPS_MEMBER_UPDATE: '1' };
  const archive = execFileSync('git', ['archive', sourceHead], { cwd: root, env, maxBuffer: 128 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', stage], { input: archive, env });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const options = { cwd: stage, env, stdio: 'inherit' as const, shell: process.platform === 'win32' };
  try { execFileSync(npm, ['ci', '--include=dev'], options); }
  catch { throw new Error('Dependency installation failed in the staging checkout'); }
  // npm may omit node_modules when the lockfile has no dependencies.
  if (!existsSync(join(stage, 'node_modules'))) mkdirSync(join(stage, 'node_modules'));
  // npm run adds ancestor .bin directories to PATH. Require every declared
  // package binary to exist in this stage before it can borrow an installed tool.
  try {
    const pkg = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
    const modules = realpathSync(join(stage, 'node_modules'));
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const installed = JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8'));
      const bins = typeof installed.bin === 'string'
        ? { [(installed.name || name).split('/').pop()!]: installed.bin } : installed.bin || {};
      for (const bin of Object.keys(bins)) {
        const path = join(modules, '.bin', bin + (process.platform === 'win32' ? '.cmd' : ''));
        const target = realpathSync(path);
        const within = relative(modules, target);
        if (isAbsolute(within) || within === '..' || within.startsWith('..' + sep)) throw new Error('binary outside stage');
      }
    }
  } catch { throw new Error('Build failed: staging dependencies or package binaries are missing or unsafe'); }
  try { execFileSync(npm, ['run', 'build'], options); }
  catch { throw new Error('Build failed in the staging checkout'); }
  for (const name of ['dist', 'node_modules']) {
    const path = join(stage, name);
    if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
      throw new Error(`Staged ${name} is missing or unsafe`);
    }
  }
  return stage;
  } catch (error) {
    // Only failed or previously published stages are eligible for later cleanup.
    // An in-progress stage must never be mistaken for an abandoned one.
    try { writeFileSync(join(stage, '.failed-runtime'), '', { flag: 'wx', mode: 0o600 }); } catch { /* preserve on uncertainty */ }
    throw error;
  }
}

/** After publication retain exactly the latest previous pair; cleanup never gates success. */
export function pruneMemberRuntimeStages(root: string, currentStage: string): void {
  try {
    const state = join(root, '.ascendops-update-backups');
    if (lstatSync(state).isSymbolicLink() || lstatSync(currentStage).isSymbolicLink()) throw new Error('unsafe recovery directory');
    const canonicalState = realpathSync(state);
    const current = realpathSync(currentStage);
    if (dirname(current) !== canonicalState || !lstatSync(join(current, 'previous-runtime')).isDirectory()) throw new Error('current recovery pair missing');
    for (const name of readdirSync(state)) {
      if (!/^runtime-[A-Za-z0-9]+$/.test(name)) continue;
      const candidate = join(state, name);
      try {
        const entry = lstatSync(candidate);
        if (entry.isSymbolicLink() || !entry.isDirectory() || realpathSync(candidate) === current) continue;
        const published = lstatSync(join(candidate, 'previous-runtime'), { throwIfNoEntry: false });
        const failed = lstatSync(join(candidate, '.failed-runtime'), { throwIfNoEntry: false });
        if (!(published?.isDirectory() && !published.isSymbolicLink()) && !(failed?.isFile() && !failed.isSymbolicLink())) continue;
        rmSync(candidate, { recursive: true });
      } catch { console.error(`Update recovery cleanup skipped for ${name}; retained for manual inspection.`); }
    }
  } catch { console.error('Update recovery cleanup skipped; recovery directories retained for manual inspection.'); }
}

/** Retain the previous pair and restore it if either publication rename fails. */
export function publishMemberRuntime(root: string, stage: string): void {
  const saved = join(stage, 'previous-runtime');
  mkdirSync(saved, { mode: 0o700 });
  const moved: string[] = [];
  const installed: string[] = [];
  try {
    for (const name of ['node_modules', 'dist']) {
      const target = join(root, name);
      if (existsSync(target)) { renameSync(target, join(saved, name)); moved.push(name); }
      renameSync(join(stage, name), target); installed.push(name);
    }
  } catch (error) {
    for (const name of installed.reverse()) renameSync(join(root, name), join(stage, name));
    for (const name of moved.reverse()) renameSync(join(saved, name), join(root, name));
    throw error;
  }
}
