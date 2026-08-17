import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { claudeProjectDirName } from '../../../src/utils/claude-project-dir.js';

const mocks = vi.hoisted(() => ({
  homeDir: '',
  pty: {
    spawn: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn(),
    write: vi.fn(),
    getPid: vi.fn().mockReturnValue(process.pid),
    isAlive: vi.fn().mockReturnValue(true),
    getOutputBuffer: vi.fn().mockReturnValue({ hasRateLimitSignature: () => false }),
    onExit: vi.fn(),
  },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => mocks.homeDir };
});

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mocks.pty; },
}));

vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return mocks.pty; },
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mocks.pty; },
  hermesDbExists: mocks.hermesDbExists,
}));

vi.mock('../../../src/pty/opencode-pty.js', () => ({
  OpencodePTY: function OpencodePTY() { return mocks.pty; },
  opencodeSessionExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/atomic.js', () => ({ ensureDir: vi.fn() }));
vi.mock('../../../src/utils/env.js', () => ({ writeCortextosEnv: vi.fn() }));
vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockImplementation(() => ({ stateDir: join(mocks.homeDir, 'state', 'alice') })),
}));
vi.mock('../../../src/bus/reminders.js', () => ({ getOverdueReminders: vi.fn().mockReturnValue([]) }));

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

describe('AgentProcess Claude project-directory continuity', () => {
  let rootDir: string;
  let ctxRoot: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'agent-process-claude-dir-'));
    mocks.homeDir = join(rootDir, 'home');
    ctxRoot = join(rootDir, 'ctx');
    mkdirSync(mocks.homeDir, { recursive: true });
    mocks.pty.spawn.mockClear();
    mocks.pty.onExit.mockClear();
    mocks.hermesDbExists.mockReset().mockReturnValue(false);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function envFor(launchDir: string) {
    return {
      instanceId: 'test',
      ctxRoot,
      frameworkRoot: rootDir,
      agentName: 'alice',
      agentDir: launchDir,
      org: 'acme',
      projectRoot: rootDir,
    };
  }

  function writeTranscript(projectDirName: string, launchDir: string): void {
    const projectDir = join(mocks.homeDir, '.claude', 'projects', projectDirName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'session.jsonl'), `${JSON.stringify({ cwd: launchDir })}\n`);
  }

  it('continues when the predicted Claude project directory contains a transcript', async () => {
    const launchDir = '/tmp/.claude-mem/observer/sessions';
    writeTranscript(claudeProjectDirName(launchDir), launchDir);

    await new AgentProcess('alice', envFor(launchDir), {}).start();

    expect(mocks.pty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
  });

  it('continues from a discovered directory and emits the naming-drift log', async () => {
    const launchDir = String.raw`C:\Users\X\agents\bob`;
    writeTranscript('private-hash-name', launchDir);
    const log = vi.fn();

    await new AgentProcess('alice', envFor(launchDir), {}, log).start();

    expect(mocks.pty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
    expect(log).toHaveBeenCalledWith(
      'projects-dir naming drift: predicted C--Users-X-agents-bob, found private-hash-name',
    );
  });

  it('starts fresh when prediction and discovery find no matching transcript', async () => {
    const launchDir = '/tmp/My Agents/bob';
    writeTranscript('unrelated-project', '/tmp/someone-else');

    await new AgentProcess('alice', envFor(launchDir), {}).start();

    expect(mocks.pty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
  });

  it('keeps force-fresh precedence even when a predicted transcript exists', async () => {
    const launchDir = '/tmp/orgs/my_org/agents/bob';
    writeTranscript(claudeProjectDirName(launchDir), launchDir);
    const forceFresh = join(ctxRoot, 'state', 'alice', '.force-fresh');
    mkdirSync(join(ctxRoot, 'state', 'alice'), { recursive: true });
    writeFileSync(forceFresh, 'forced by test');

    await new AgentProcess('alice', envFor(launchDir), {}).start();

    expect(mocks.pty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
    expect(existsSync(forceFresh)).toBe(false);
  });

  it('preserves the Hermes continuity branch without consulting Claude projects', async () => {
    const launchDir = '/tmp/hermes-agent';
    mocks.hermesDbExists.mockReturnValue(true);

    await new AgentProcess('alice', envFor(launchDir), { runtime: 'hermes' }).start();

    expect(mocks.hermesDbExists).toHaveBeenCalledOnce();
    expect(mocks.pty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
  });
});
