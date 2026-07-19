import { describe, it, expect, vi } from 'vitest';
import { platform } from 'os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadAdapter } from '../../../src/pty/adapters/base';
import { anthropicAdapter } from '../../../src/pty/adapters/anthropic';
import { openaiAdapter } from '../../../src/pty/adapters/openai';
import { googleAdapter } from '../../../src/pty/adapters/google';
import type { AgentConfig, CtxEnv } from '../../../src/types/index';

function makeEnv(agentDir: string): CtxEnv {
  return {
    instanceId: 'test',
    ctxRoot: '/tmp/ctx',
    frameworkRoot: '/tmp/framework',
    agentName: 'test-agent',
    org: 'test-org',
    agentDir,
    projectRoot: '/tmp/project',
  };
}

describe('loadAdapter', () => {
  it('returns anthropic adapter for undefined vendor (default)', () => {
    expect(loadAdapter(undefined)).toBe(anthropicAdapter);
  });

  it('returns anthropic adapter for "anthropic"', () => {
    expect(loadAdapter('anthropic')).toBe(anthropicAdapter);
  });

  it('returns openai adapter for "openai"', () => {
    expect(loadAdapter('openai')).toBe(openaiAdapter);
  });

  it('returns google adapter for "google"', () => {
    expect(loadAdapter('google')).toBe(googleAdapter);
  });

  it('throws for vendors outside MVP scope', () => {
    expect(() => loadAdapter('grok')).toThrow(/Unknown vendor.*grok/);
    expect(() => loadAdapter('xai')).toThrow(/Unknown vendor.*xai/);
  });
});

describe('anthropicAdapter — zero behavior change', () => {
  it('binary is platform-correct (claude / claude.cmd)', () => {
    const expected = platform() === 'win32' ? 'claude.cmd' : 'claude';
    expect(anthropicAdapter.binary).toBe(expected);
  });

  it('exposes 2-Enter bracketed-paste count for Claude TUI', () => {
    expect(anthropicAdapter.pasteEnterCount).toBe(2);
  });

  it('extractionRetries is 0 for Claude (no Ink-renderer spinner issue)', () => {
    expect(anthropicAdapter.extractionRetries).toBe(0);
  });

  it('envFilter is identity (Claude needs no env stripping)', () => {
    const env = { FOO: 'bar', CLAUDE_CODE_SKIP_AUTH: 'yes' };
    expect(anthropicAdapter.envFilter(env)).toEqual(env);
  });

  describe('buildArgs — same args as pre-refactor agent-pty.ts', () => {
    const config: AgentConfig = { model: 'claude-opus-4-7' };
    const env = makeEnv('/nonexistent-agent-dir');

    it('fresh mode: --dangerously-skip-permissions + --model + prompt', () => {
      const args = anthropicAdapter.buildArgs('fresh', 'hello', { config, env });
      expect(args).toEqual([
        '--dangerously-skip-permissions',
        '--model', 'claude-opus-4-7',
        'hello',
      ]);
    });

    it('continue mode: prepends --continue', () => {
      const args = anthropicAdapter.buildArgs('continue', 'resume', { config, env });
      expect(args).toEqual([
        '--continue',
        '--dangerously-skip-permissions',
        '--model', 'claude-opus-4-7',
        'resume',
      ]);
    });

    it('omits --model when unset', () => {
      const argsNoModel = anthropicAdapter.buildArgs(
        'fresh',
        'p',
        { config: {}, env },
      );
      expect(argsNoModel).toEqual([
        '--dangerously-skip-permissions',
        'p',
      ]);
    });

    it('appends local/*.md files as --append-system-prompt when present', () => {
      const tmpAgent = mkdtempSync(join(tmpdir(), 'aussie-adapter-test-'));
      try {
        const localDir = join(tmpAgent, 'local');
        mkdirSync(localDir);
        writeFileSync(join(localDir, '01-first.md'), 'FIRST');
        writeFileSync(join(localDir, '02-second.md'), 'SECOND');
        writeFileSync(join(localDir, 'ignored.txt'), 'NOT_MD');

        const args = anthropicAdapter.buildArgs(
          'fresh',
          'p',
          { config: {}, env: makeEnv(tmpAgent) },
        );

        const idx = args.indexOf('--append-system-prompt');
        expect(idx).toBeGreaterThan(-1);
        expect(args[idx + 1]).toBe('FIRST\n\nSECOND');
        expect(args[args.length - 1]).toBe('p');
      } finally {
        rmSync(tmpAgent, { recursive: true, force: true });
      }
    });

    it('skips --append-system-prompt when local/ dir is missing', () => {
      const args = anthropicAdapter.buildArgs(
        'fresh',
        'p',
        { config: {}, env },
      );
      expect(args).not.toContain('--append-system-prompt');
    });
  });

  describe('buildArgs — dangerously_skip_permissions toggle (#593)', () => {
    const env = makeEnv('/nonexistent-agent-dir');

    it('includes --dangerously-skip-permissions by default (back-compat: undefined → skip ON)', () => {
      const args = anthropicAdapter.buildArgs('fresh', 'p', { config: {}, env });
      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('includes --dangerously-skip-permissions when explicitly true', () => {
      const args = anthropicAdapter.buildArgs(
        'fresh',
        'p',
        { config: { dangerously_skip_permissions: true }, env },
      );
      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('omits --dangerously-skip-permissions when dangerously_skip_permissions is false (permission gate engaged)', () => {
      const args = anthropicAdapter.buildArgs(
        'fresh',
        'p',
        { config: { dangerously_skip_permissions: false }, env },
      );
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('keeps --dangerously-skip-permissions and emits a warning when dangerously_skip_permissions is a non-boolean (typo-safe fallback)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // A typo'd string must NOT silently disable the skip flag.
        const args = anthropicAdapter.buildArgs(
          'fresh',
          'p',
          { config: { dangerously_skip_permissions: 'false' as unknown as boolean }, env },
        );
        expect(args).toContain('--dangerously-skip-permissions');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('dangerously_skip_permissions must be true or false'));
      } finally {
        warn.mockRestore();
      }
    });
  });
});

describe('openaiAdapter', () => {
  const env = makeEnv('/nonexistent-agent-dir');

  it('binary is "codex" (no platform-specific .cmd suffix)', () => {
    expect(openaiAdapter.binary).toBe('codex');
  });

  it('exposes 1-Enter bracketed-paste count for Codex TUI', () => {
    expect(openaiAdapter.pasteEnterCount).toBe(1);
  });

  it('extractionRetries is 0 (no Ink-renderer spinner like Gemini)', () => {
    expect(openaiAdapter.extractionRetries).toBe(0);
  });

  describe('envFilter — strips CLAUDE_* leakage', () => {
    it('removes CLAUDE_CODE_SKIP_*_AUTH (corrupts Codex auth detection)', () => {
      const out = openaiAdapter.envFilter({
        CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
        CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
        CLAUDE_API_KEY: 'sk-test',
        CLAUDE_OPUS_MODEL: 'opus-4-7',
      });
      expect(out).toEqual({});
    });

    it('passes through OPENAI_KEY, CODEX_HOME, and other non-Claude vars', () => {
      const out = openaiAdapter.envFilter({
        OPENAI_KEY: 'sk-openai',
        CODEX_HOME: '/Users/me/.codex-seats/seat-a',
        PATH: '/usr/bin',
        CLAUDE_CODE_SKIP_AUTH: '1',
      });
      expect(out).toEqual({
        OPENAI_KEY: 'sk-openai',
        CODEX_HOME: '/Users/me/.codex-seats/seat-a',
        PATH: '/usr/bin',
      });
    });
  });

  describe('buildArgs', () => {
    const config: AgentConfig = { model: 'gpt-5.5' };

    it('fresh mode: bypass flags + --model + prompt (no resume)', () => {
      const args = openaiAdapter.buildArgs('fresh', 'hello', { config, env });
      expect(args).toEqual([
        '--dangerously-bypass-approvals-and-sandbox',
        '--no-alt-screen',
        '--disable', 'shell_snapshot',
        '--model', 'gpt-5.5',
        'hello',
      ]);
    });

    it('continue mode: prepends "resume --last" subcommand', () => {
      const args = openaiAdapter.buildArgs('continue', 'resume me', { config, env });
      expect(args).toEqual([
        'resume', '--last',
        '--dangerously-bypass-approvals-and-sandbox',
        '--no-alt-screen',
        '--disable', 'shell_snapshot',
        '--model', 'gpt-5.5',
        'resume me',
      ]);
    });

    it('omits --model when unset (codex picks default)', () => {
      const args = openaiAdapter.buildArgs('fresh', 'p', { config: {}, env });
      expect(args).toEqual([
        '--dangerously-bypass-approvals-and-sandbox',
        '--no-alt-screen',
        '--disable', 'shell_snapshot',
        'p',
      ]);
    });

    it('always includes the bypass triple for SIGTTIN/TTY safety', () => {
      const fresh = openaiAdapter.buildArgs('fresh', 'p', { config: {}, env });
      const cont = openaiAdapter.buildArgs('continue', 'p', { config: {}, env });
      for (const args of [fresh, cont]) {
        expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
        expect(args).toContain('--no-alt-screen');
        expect(args).toContain('--disable');
        expect(args).toContain('shell_snapshot');
      }
    });
  });
});

describe('googleAdapter', () => {
  const env = makeEnv('/nonexistent-agent-dir');

  it('binary is "gemini"', () => {
    expect(googleAdapter.binary).toBe('gemini');
  });

  it('exposes 2-Enter bracketed-paste count for Gemini Ink TUI', () => {
    expect(googleAdapter.pasteEnterCount).toBe(2);
  });

  it('extractionRetries is 2 (Ink notification spinners obscure output)', () => {
    expect(googleAdapter.extractionRetries).toBe(2);
  });

  describe('envFilter — strips CLAUDE_* leakage', () => {
    it('removes CLAUDE_CODE_SKIP_*_AUTH (corrupts Gemini auth detection)', () => {
      const out = googleAdapter.envFilter({
        CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
        CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
        CLAUDE_API_KEY: 'sk-test',
      });
      expect(out).toEqual({});
    });

    it('passes through GEMINI_API_KEY, GOOGLE_APPLICATION_CREDENTIALS, and other non-Claude vars', () => {
      const out = googleAdapter.envFilter({
        GEMINI_API_KEY: 'gemini-key',
        GOOGLE_APPLICATION_CREDENTIALS: '/Users/me/.gemini/app_creds.json',
        PATH: '/usr/bin',
        CLAUDE_CODE_SKIP_AUTH: '1',
      });
      expect(out).toEqual({
        GEMINI_API_KEY: 'gemini-key',
        GOOGLE_APPLICATION_CREDENTIALS: '/Users/me/.gemini/app_creds.json',
        PATH: '/usr/bin',
      });
    });
  });

  describe('buildArgs', () => {
    const config: AgentConfig = { model: 'gemini-2.5-pro' };

    it('fresh mode: bypass flags + --model + prompt', () => {
      const args = googleAdapter.buildArgs('fresh', 'hello', { config, env });
      expect(args).toEqual([
        '--yolo',
        '--sandbox', 'false',
        '--model', 'gemini-2.5-pro',
        'hello',
      ]);
    });

    it('continue mode falls back to fresh args (Gemini has no CLI session-resume)', () => {
      const fresh = googleAdapter.buildArgs('fresh', 'p', { config, env });
      const cont = googleAdapter.buildArgs('continue', 'p', { config, env });
      expect(cont).toEqual(fresh);
    });

    it('omits --model when unset (gemini picks default)', () => {
      const args = googleAdapter.buildArgs('fresh', 'p', { config: {}, env });
      expect(args).toEqual([
        '--yolo',
        '--sandbox', 'false',
        'p',
      ]);
    });

    it('reads model from ctx.config.model', () => {
      const args = googleAdapter.buildArgs(
        'fresh',
        'p',
        { config: { model: 'gemini-2.0-flash' }, env },
      );
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('gemini-2.0-flash');
    });

    it('always includes the bypass pair (--yolo + --sandbox false) for both modes', () => {
      const fresh = googleAdapter.buildArgs('fresh', 'p', { config: {}, env });
      const cont = googleAdapter.buildArgs('continue', 'p', { config: {}, env });
      for (const args of [fresh, cont]) {
        expect(args).toContain('--yolo');
        expect(args).toContain('--sandbox');
        expect(args[args.indexOf('--sandbox') + 1]).toBe('false');
      }
    });

    it('places prompt last in the arg list', () => {
      const args = googleAdapter.buildArgs(
        'fresh',
        'final-prompt',
        { config: { model: 'gemini-2.5-pro' }, env },
      );
      expect(args[args.length - 1]).toBe('final-prompt');
    });
  });
});
