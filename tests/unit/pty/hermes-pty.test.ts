import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get unlinkSync() { return fsMocks.unlinkSync; },
  };
});

// Stub node-pty so HermesPTY can be imported without a native addon
vi.mock('node-pty', () => ({
  spawn: vi.fn().mockReturnValue({
    pid: 99,
    write: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
  }),
}));

const { hermesDbExists, HermesPTY } = await import('../../../src/pty/hermes-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'hermes-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/hermes-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.writeFileSync.mockReset();
  fsMocks.unlinkSync.mockReset();
});

describe('hermesDbExists', () => {
  it('returns false when ~/.hermes/state.db does not exist', () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(hermesDbExists()).toBe(false);
  });

  it('returns true when ~/.hermes/state.db exists', () => {
    const expectedPath = join(homedir(), '.hermes', 'state.db');
    fsMocks.existsSync.mockImplementation((p: string) => p === expectedPath);
    expect(hermesDbExists()).toBe(true);
  });

  it('uses HERMES_HOME override when provided', () => {
    const customHome = '/custom/hermes';
    const expectedPath = join(customHome, 'state.db');
    fsMocks.existsSync.mockImplementation((p: string) => p === expectedPath);
    expect(hermesDbExists(customHome)).toBe(true);
  });

  it('returns false when HERMES_HOME is set but state.db is absent', () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(hermesDbExists('/custom/hermes')).toBe(false);
  });
});

describe('HermesPTY', () => {
  it('getBinaryName returns "hermes"', () => {
    const pty = new HermesPTY(mockEnv, {});
    // Access protected method via cast
    expect((pty as unknown as { getBinaryName(): string }).getBinaryName()).toBe('hermes');
  });

  it('buildClaudeArgs returns [] for fresh mode', () => {
    const pty = new HermesPTY(mockEnv, {});
    const args = (pty as unknown as { buildClaudeArgs(m: string, p: string): string[] })
      .buildClaudeArgs('fresh', 'hello');
    expect(args).toEqual([]);
  });

  it('buildClaudeArgs returns ["--continue"] for continue mode', () => {
    const pty = new HermesPTY(mockEnv, {});
    const args = (pty as unknown as { buildClaudeArgs(m: string, p: string): string[] })
      .buildClaudeArgs('continue', 'hello');
    expect(args).toEqual(['--continue']);
  });

  it('isBootstrapped() fires on "❯" in output', () => {
    const pty = new HermesPTY(mockEnv, {});
    pty.getOutputBuffer().push('⚔ ❯ ');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(true);
  });

  it('isBootstrapped() does not fire on output without "❯"', () => {
    const pty = new HermesPTY(mockEnv, {});
    pty.getOutputBuffer().push('loading...');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(false);
  });

  it('disables the trust-prompt auto-accept (Hermes has no trust prompt)', () => {
    // The base class's 5s/8s auto-accept timers match "Yes"/"trust" as
    // loose substrings; on Hermes they could fire a stray Enter right
    // after the startup-file injection. HermesPTY must opt out.
    const pty = new HermesPTY(mockEnv, {});
    expect(
      (pty as unknown as { needsTrustPromptAutoAccept(): boolean }).needsTrustPromptAutoAccept(),
    ).toBe(false);
  });
});

describe('HermesPTY startup-file robustness', () => {
  it('writeStartupFile writes the prompt to .cortextos-startup.md in the agent dir', () => {
    const pty = new HermesPTY(mockEnv, {});
    (pty as unknown as { writeStartupFile(p: string): void }).writeStartupFile('boot instructions');

    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      join(mockEnv.agentDir, '.cortextos-startup.md'),
      'boot instructions',
      'utf-8',
    );
    expect(fsMocks.unlinkSync).not.toHaveBeenCalled();
  });

  it('removes a stale startup file when the write fails (no outdated instructions)', () => {
    // If the write fails but a previous boot's file is still on disk,
    // Hermes would silently follow OUTDATED instructions. The failure
    // path must unlink the stale file so the read command fails loudly.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fsMocks.writeFileSync.mockImplementation(() => { throw new Error('EACCES: permission denied'); });
      const pty = new HermesPTY(mockEnv, {});
      expect(() =>
        (pty as unknown as { writeStartupFile(p: string): void }).writeStartupFile('new instructions'),
      ).not.toThrow();

      expect(fsMocks.unlinkSync).toHaveBeenCalledWith(
        join(mockEnv.agentDir, '.cortextos-startup.md'),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('survives unlink failure on the write-failure path', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fsMocks.writeFileSync.mockImplementation(() => { throw new Error('EACCES'); });
      fsMocks.unlinkSync.mockImplementation(() => { throw new Error('ENOENT'); });
      const pty = new HermesPTY(mockEnv, {});
      expect(() =>
        (pty as unknown as { writeStartupFile(p: string): void }).writeStartupFile('x'),
      ).not.toThrow();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('HermesPTY startup injection guards', () => {
  it('waitForPromptThenInject aborts without writing when the PTY is not alive', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const pty = new HermesPTY(mockEnv, {});
      // Never spawned → isAlive() is false. The old code blind-polled for
      // 30s then wrote to a null PTY (throw). The guard must return
      // immediately without attempting a write.
      const writeSpy = vi.spyOn(pty, 'write');
      await expect(
        (pty as unknown as { waitForPromptThenInject(t?: number): Promise<void> })
          .waitForPromptThenInject(2000),
      ).resolves.toBeUndefined();
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('injectStartupCommand swallows a write throw from a torn-down PTY', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const pty = new HermesPTY(mockEnv, {});
      // write() throws 'PTY not spawned' — must not propagate (it would
      // surface as an unhandled rejection inside the daemon).
      expect(() =>
        (pty as unknown as { injectStartupCommand(): void }).injectStartupCommand(),
      ).not.toThrow();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
