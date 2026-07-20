import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

export interface FileSnapshot {
  path: string;
  state: 'absent' | 'present';
  mtimeMs?: number;
  size?: number;
  ino?: number;
  sha256?: string;
}

const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};
const realHome = homedir();
const realClaudePaths = [
  join(realHome, '.claude.json'),
  join(realHome, '.claude', 'settings.json'),
];
const baseline = realClaudePaths.map(captureFileSnapshot);
let sandboxHome: string | undefined;

export function captureFileSnapshot(filePath: string): FileSnapshot {
  if (!existsSync(filePath)) return { path: filePath, state: 'absent' };
  const stat = statSync(filePath);
  return {
    path: filePath,
    state: 'present',
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    ino: stat.ino,
    sha256: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
  };
}

export function assertFilesUnchanged(
  before: FileSnapshot[],
  after: FileSnapshot[],
): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  throw new Error(
    '[test-sandbox] real Claude config changed during the test run\n' +
    `before=${JSON.stringify(before)}\n` +
    `after=${JSON.stringify(after)}`,
  );
}

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export function setup(): void {
  sandboxHome = mkdtempSync(join(tmpdir(), 'cortextos-vitest-home-'));
  const claudeConfigDir = join(sandboxHome, '.claude');
  mkdirSync(claudeConfigDir, { recursive: true });
  writeFileSync(join(sandboxHome, '.vitest-sandbox-active'), 'active\n');

  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  process.env.CORTEXTOS_TEST_SANDBOX_HOME = sandboxHome;
  console.log(`[test-sandbox] HOME isolated at ${sandboxHome}`);
}

export function teardown(): void {
  try {
    const after = realClaudePaths.map(captureFileSnapshot);
    assertFilesUnchanged(baseline, after);
    console.log('[test-sandbox] real Claude config canary passed');
  } catch (error) {
    // Vitest 4.1.2 logs global teardown throws without failing the process.
    // The exit status is the enforcement boundary; keep the throw for detail.
    process.exitCode = 1;
    throw error;
  } finally {
    restoreEnv('HOME');
    restoreEnv('USERPROFILE');
    restoreEnv('CLAUDE_CONFIG_DIR');
    delete process.env.CORTEXTOS_TEST_SANDBOX_HOME;
    if (sandboxHome) rmSync(sandboxHome, { recursive: true, force: true });
  }
}
