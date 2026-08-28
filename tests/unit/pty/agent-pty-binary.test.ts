import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = {
  existsSync: vi.fn<(path: string) => boolean>().mockReturnValue(false),
  readFileSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    platform: () => 'win32',
  };
});

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'kit',
  agentDir: '/tmp/fw/orgs/acme/agents/kit',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  vi.resetModules();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset().mockReturnValue('');
  process.env.PATH = 'C:\\Tools;C:\\Users\\me\\AppData\\Local\\Programs\\Claude';
});

describe('AgentPTY.getBinaryName', () => {
  it('runs the Windows Claude probe even when the adapter reports claude.cmd', async () => {
    fsMocks.existsSync.mockImplementation((p: string) => p.endsWith('claude.exe'));

    const { AgentPTY } = await import('../../../src/pty/agent-pty.js');
    const pty = new AgentPTY(mockEnv, { vendor: 'anthropic' });

    expect((pty as unknown as { getBinaryName(): string }).getBinaryName()).toBe('claude.exe');
  });

  it('falls back to claude.cmd when neither Claude binary is present on PATH', async () => {
    const { AgentPTY } = await import('../../../src/pty/agent-pty.js');
    const pty = new AgentPTY(mockEnv, { vendor: 'anthropic' });

    expect((pty as unknown as { getBinaryName(): string }).getBinaryName()).toBe('claude.cmd');
  });

  it('preserves PATH precedence: earlier-PATH claude.cmd beats later-PATH claude.exe', async () => {
    // PATH = "C:\\Tools;C:\\Users\\me\\AppData\\Local\\Programs\\Claude"
    // C:\Tools has claude.cmd (the intended shim), the later dir has claude.exe.
    // Windows resolves command name by directory order first, extension within
    // each directory — so the correct answer is the .cmd in C:\Tools, not the
    // .exe in the later dir. The inverted (outer=ext) form would return .exe.
    fsMocks.existsSync.mockImplementation((p: string) => {
      const path = String(p);
      if (path.startsWith('C:\\Tools') && path.endsWith('claude.cmd')) return true;
      if (path.startsWith('C:\\Users') && path.endsWith('claude.exe')) return true;
      return false;
    });

    const { AgentPTY } = await import('../../../src/pty/agent-pty.js');
    const pty = new AgentPTY(mockEnv, { vendor: 'anthropic' });

    expect((pty as unknown as { getBinaryName(): string }).getBinaryName()).toBe('claude.cmd');
  });
});
