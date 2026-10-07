import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync } from 'fs';
import { join } from 'path';
import { stripSessionCredentialFromEnv } from '../utils/env.js';

/** Build from the merged source without changing the installed runtime or dependencies. */
export function stageMemberRuntime(root: string, stateDirectory: string, sourceHead = 'HEAD'): string {
  const stage = mkdtempSync(join(stateDirectory, 'runtime-'));
  const env = { ...stripSessionCredentialFromEnv(process.env), ASCENDOPS_MEMBER_UPDATE: '1' };
  const archive = execFileSync('git', ['archive', sourceHead], { cwd: root, env, maxBuffer: 128 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', stage], { input: archive, env });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const options = { cwd: stage, env, stdio: 'inherit' as const, shell: process.platform === 'win32' };
  try { execFileSync(npm, ['ci'], options); }
  catch { throw new Error('Dependency installation failed in the staging checkout'); }
  // npm may omit node_modules when the lockfile has no dependencies.
  if (!existsSync(join(stage, 'node_modules'))) mkdirSync(join(stage, 'node_modules'));
  try { execFileSync(npm, ['run', 'build'], options); }
  catch { throw new Error('Build failed in the staging checkout'); }
  for (const name of ['dist', 'node_modules']) {
    const path = join(stage, name);
    if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
      throw new Error(`Staged ${name} is missing or unsafe`);
    }
  }
  return stage;
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
