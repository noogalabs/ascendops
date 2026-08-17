import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  claudeProjectDirName,
  resolveClaudeProjectDir,
} from '../../../src/utils/claude-project-dir.js';

describe('Claude project-directory resolution', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'claude-project-dir-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it.each([
    ['/tmp/agents/bob', '-tmp-agents-bob'],
    ['/tmp/.claude-mem/observer/sessions', '-tmp--claude-mem-observer-sessions'],
    ['/tmp/orgs/my_org/agents/bob', '-tmp-orgs-my-org-agents-bob'],
    ['/tmp/My Agents/bob', '-tmp-My-Agents-bob'],
    [String.raw`C:\Users\X\agents\bob`, 'C--Users-X-agents-bob'],
  ])('predicts Claude project directory for %s', (launchDir, expected) => {
    expect(claudeProjectDirName(launchDir)).toBe(expected);
  });

  it('deliberately mirrors Claude many-to-one punctuation collisions', () => {
    expect([
      claudeProjectDirName('/tmp/my_org'),
      claudeProjectDirName('/tmp/my-org'),
      claudeProjectDirName('/tmp/my.org'),
    ]).toEqual(['-tmp-my-org', '-tmp-my-org', '-tmp-my-org']);
  });

  it('uses the predicted directory without scanning or logging', () => {
    const launchDir = '/tmp/.claude-mem/observer/sessions';
    const predictedDir = join(homeDir, '.claude', 'projects', claudeProjectDirName(launchDir));
    mkdirSync(predictedDir, { recursive: true });
    const log = vi.fn();

    expect(resolveClaudeProjectDir(launchDir, homeDir, log)).toBe(predictedDir);
    expect(log).not.toHaveBeenCalled();
  });

  it('discovers a renamed directory by JSON-escaped Windows cwd and logs drift loudly', () => {
    const launchDir = String.raw`C:\Users\X\agents\bob`;
    const discoveredDir = join(homeDir, '.claude', 'projects', 'private-hash-name');
    mkdirSync(discoveredDir, { recursive: true });
    writeFileSync(join(discoveredDir, 'session.jsonl'), `${JSON.stringify({ cwd: launchDir })}\n`);
    const log = vi.fn();

    expect(resolveClaudeProjectDir(launchDir, homeDir, log)).toBe(discoveredDir);
    expect(log).toHaveBeenCalledWith(
      'projects-dir naming drift: predicted C--Users-X-agents-bob, found private-hash-name',
    );
  });

  it('discovers private long-path naming without copying Claude hash behavior', () => {
    const launchDir = `/tmp/${'segment.'.repeat(40)}agent`;
    const discoveredDir = join(homeDir, '.claude', 'projects', 'truncated-private-hash');
    mkdirSync(discoveredDir, { recursive: true });
    writeFileSync(join(discoveredDir, 'session.jsonl'), `${JSON.stringify({ cwd: launchDir })}\n`);

    expect(resolveClaudeProjectDir(launchDir, homeDir, vi.fn())).toBe(discoveredDir);
  });

  it('returns null when no transcript head identifies the launch directory', () => {
    const candidateDir = join(homeDir, '.claude', 'projects', 'unrelated-project');
    mkdirSync(candidateDir, { recursive: true });
    writeFileSync(join(candidateDir, 'session.jsonl'), `${JSON.stringify({ cwd: '/tmp/other' })}\n`);
    const log = vi.fn();

    expect(resolveClaudeProjectDir('/tmp/missing', homeDir, log)).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'claude-projects lookup MISS for /tmp/missing (predicted -tmp-missing, discovery found nothing) - session treated as fresh; --continue context will not be preserved',
    );
  });

  it('logs a miss when the Claude projects directory does not exist', () => {
    const log = vi.fn();

    expect(resolveClaudeProjectDir('/tmp/no-projects', homeDir, log)).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'claude-projects lookup MISS for /tmp/no-projects (predicted -tmp-no-projects, discovery found nothing) - session treated as fresh; --continue context will not be preserved',
    );
  });

  it('memoizes discovery misses for five minutes before rescanning', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    try {
      const launchDir = '/tmp/cache-miss';
      const projectsDir = join(homeDir, '.claude', 'projects');
      mkdirSync(projectsDir, { recursive: true });

      expect(resolveClaudeProjectDir(launchDir, homeDir, vi.fn())).toBeNull();

      const discoveredDir = join(projectsDir, 'private-hash-name');
      mkdirSync(discoveredDir);
      writeFileSync(join(discoveredDir, 'session.jsonl'), `${JSON.stringify({ cwd: launchDir })}\n`);

      expect(resolveClaudeProjectDir(launchDir, homeDir, vi.fn())).toBeNull();

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(resolveClaudeProjectDir(launchDir, homeDir, vi.fn())).toBe(discoveredDir);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses a discovered directory and rescans if that directory disappears', () => {
    const launchDir = '/tmp/discovery-cache';
    const projectsDir = join(homeDir, '.claude', 'projects');
    const firstDir = join(projectsDir, 'private-hash-one');
    mkdirSync(firstDir, { recursive: true });
    const firstTranscript = join(firstDir, 'session.jsonl');
    writeFileSync(firstTranscript, `${JSON.stringify({ cwd: launchDir })}\n`);

    expect(resolveClaudeProjectDir(launchDir, homeDir, vi.fn())).toBe(firstDir);

    rmSync(firstTranscript);
    expect(resolveClaudeProjectDir(launchDir, homeDir, vi.fn())).toBe(firstDir);

    rmSync(firstDir, { recursive: true });
    const replacementDir = join(projectsDir, 'private-hash-two');
    mkdirSync(replacementDir);
    writeFileSync(join(replacementDir, 'session.jsonl'), `${JSON.stringify({ cwd: launchDir })}\n`);

    expect(resolveClaudeProjectDir(launchDir, homeDir, vi.fn())).toBe(replacementDir);
  });

  it('lets a predicted directory bypass a negative discovery cache', () => {
    const launchDir = '/tmp/predicted-after-miss';
    const predictedDir = join(homeDir, '.claude', 'projects', claudeProjectDirName(launchDir));

    expect(resolveClaudeProjectDir(launchDir, homeDir, vi.fn())).toBeNull();
    mkdirSync(predictedDir, { recursive: true });

    expect(resolveClaudeProjectDir(launchDir, homeDir, vi.fn())).toBe(predictedDir);
  });
});
