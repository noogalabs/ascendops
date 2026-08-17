import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { selfRestart, hardRestart, autoCommit, checkGoalStaleness, postActivity } from '../../../src/bus/system';
import { acquireAutoCommitLease, getAutoCommitLeaseStatus } from '../../../src/bus/auto-commit-lease';
import type { BusPaths } from '../../../src/types';

function makePaths(testDir: string, agent: string = 'test-agent'): BusPaths {
  return {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox', agent),
    inflight: join(testDir, 'inflight', agent),
    processed: join(testDir, 'processed', agent),
    logDir: join(testDir, 'logs', agent),
    stateDir: join(testDir, 'state', agent),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
}

describe('Bus System', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-system-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('selfRestart', () => {
    it('creates marker file and appends to restarts.log', () => {
      const paths = makePaths(testDir);
      selfRestart(paths, 'test-agent', 'config reload needed');

      // Check marker file
      const markerPath = join(paths.stateDir, '.restart-planned');
      expect(existsSync(markerPath)).toBe(true);
      const markerContent = readFileSync(markerPath, 'utf-8').trim();
      expect(markerContent).toBe('config reload needed');

      // Check restarts.log
      const logPath = join(paths.logDir, 'restarts.log');
      expect(existsSync(logPath)).toBe(true);
      const logContent = readFileSync(logPath, 'utf-8');
      expect(logContent).toContain('SELF-RESTART: config reload needed');
      expect(logContent).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
    });

    it('uses default reason when none provided', () => {
      const paths = makePaths(testDir);
      selfRestart(paths, 'test-agent');

      const logPath = join(paths.logDir, 'restarts.log');
      const logContent = readFileSync(logPath, 'utf-8');
      expect(logContent).toContain('SELF-RESTART: no reason specified');
    });
  });

  describe('hardRestart', () => {
    it('creates .force-fresh and .restart-planned markers', () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent', 'context handoff');

      expect(existsSync(join(paths.stateDir, '.force-fresh'))).toBe(true);
      expect(existsSync(join(paths.stateDir, '.restart-planned'))).toBe(true);
      const logContent = readFileSync(join(paths.logDir, 'restarts.log'), 'utf-8');
      expect(logContent).toContain('HARD-RESTART: context handoff');
    });

    it('uses default reason when none provided', () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent');
      const logContent = readFileSync(join(paths.logDir, 'restarts.log'), 'utf-8');
      expect(logContent).toContain('HARD-RESTART: no reason specified');
    });
  });

  describe('autoCommit', () => {
    let gitDir: string;
    const scope = { org: 'acme', agent: 'alice' };

    function writeAgentFile(relativePath: string, content: string): void {
      const fullPath = join(gitDir, 'orgs', scope.org, 'agents', scope.agent, relativePath);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content);
    }

    function runAutoCommit(dryRun: boolean = false) {
      return (autoCommit as (...args: unknown[]) => ReturnType<typeof autoCommit>)(
        gitDir,
        dryRun,
        scope,
        { ctxRoot: testDir, now: 1_000, token: 'test-lease-token' },
      );
    }

    beforeEach(() => {
      gitDir = mkdtempSync(join(tmpdir(), 'cortextos-autocommit-test-'));
      execSync('git init', { cwd: gitDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: gitDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: gitDir, stdio: 'pipe' });
      // Create initial commit so git status works properly
      writeFileSync(join(gitDir, '.gitkeep'), '');
      execSync('git add .gitkeep && git commit -m "init"', { cwd: gitDir, stdio: 'pipe' });
    });

    afterEach(() => {
      rmSync(gitDir, { recursive: true, force: true });
    });

    it('filters out files with credential patterns', () => {
      writeAgentFile('config.json', '{"token=abc123"}');
      writeAgentFile('MEMORY.md', 'just a readme');

      const report = runAutoCommit(true);
      expect(report.blocked.some(b => b.includes('config.json') && b.includes('credential'))).toBe(true);
      expect(report.staged).toContain('orgs/acme/agents/alice/MEMORY.md');
    });

    it('dry-run does not stage files', () => {
      writeAgentFile('GOALS.md', 'content');

      const report = runAutoCommit(true);
      expect(report.status).toBe('dry_run');
      expect(report.lease.status).toBe('released');
      expect(getAutoCommitLeaseStatus(testDir)).toEqual({ status: 'none' });

      // Verify nothing is staged
      const staged = execSync('git diff --cached --name-only', { cwd: gitDir, encoding: 'utf-8' });
      expect(staged.trim()).toBe('');
    });

    it('requires and contends on the lease before dry-run index inspection', () => {
      acquireAutoCommitLease({
        ctxRoot: testDir,
        holder: { org: 'acme', agent: 'bob' },
        now: 1_000,
        ttlMs: 600_000,
        token: 'bob-token',
      });
      writeAgentFile('MEMORY.md', 'dry-run candidate');

      const report = runAutoCommit(true);

      expect(report.status).toBe('error');
      expect(report.lease).toEqual({
        status: 'contended',
        holder: { org: 'acme', agent: 'bob' },
        expires_at: 601_000,
      });
      expect(report.staged).toEqual([]);
    });

    it('refuses missing lease context before repository inspection', () => {
      writeAgentFile('MEMORY.md', 'must remain uninspected');

      const report = autoCommit(gitDir, false, scope);

      expect(report.status).toBe('error');
      expect(report.error).toContain('requires state-side lease context before index inspection');
      expect(report.lease).toEqual({ status: 'not_acquired', reason: 'missing_lease_context' });
    });

    it('returns clean when no changes', () => {
      const report = runAutoCommit();
      expect(report.status).toBe('clean');
      expect(report.lease.status).toBe('released');
      expect(getAutoCommitLeaseStatus(testDir)).toEqual({ status: 'none' });
    });

    it('stages safe files when not dry-run', () => {
      writeAgentFile('MEMORY.md', 'content');

      const report = runAutoCommit();
      expect(report.status).toBe('staged');
      expect(report.staged).toContain('orgs/acme/agents/alice/MEMORY.md');
      expect(report.lease).toEqual({
        status: 'held',
        holder: scope,
        token: 'test-lease-token',
        expires_at: 601_000,
      });
      expect(getAutoCommitLeaseStatus(testDir, 2_000).status).toBe('active');

      // Verify file is actually staged
      const staged = execSync('git diff --cached --name-only', { cwd: gitDir, encoding: 'utf-8' });
      expect(staged.trim()).toContain('orgs/acme/agents/alice/MEMORY.md');
    });

    it('returns nothing_to_stage when all files blocked', () => {
      writeAgentFile('config.json', 'key=123');

      const report = runAutoCommit();
      expect(report.status).toBe('nothing_to_stage');
      expect(report.blocked.length).toBeGreaterThan(0);
      expect(report.lease.status).toBe('released');
      expect(getAutoCommitLeaseStatus(testDir)).toEqual({ status: 'none' });
    });

    it('refuses the known-bad broad workspace set and stages only invoking-agent state', () => {
      writeAgentFile('memory/2026-07-31.md', 'safe state');
      writeAgentFile('MEMORY.md', 'safe durable state');
      writeAgentFile('GOALS.md', 'safe goals');
      writeAgentFile('config.json', '{"enabled":true}');
      writeAgentFile('AGENTS.md', 'broad bootstrap content');
      const otherAgentMemory = join(gitDir, 'orgs', 'acme', 'agents', 'bob', 'memory');
      mkdirSync(otherAgentMemory, { recursive: true });
      writeFileSync(join(otherAgentMemory, '2026-07-31.md'), 'other agent state');
      mkdirSync(join(gitDir, 'dashboard'), { recursive: true });
      writeFileSync(join(gitDir, 'dashboard', 'cortextos.db'), 'sqlite');
      writeFileSync(join(gitDir, 'dashboard', 'cortextos.db-wal'), 'wal');
      mkdirSync(join(gitDir, '__pycache__'), { recursive: true });
      writeFileSync(join(gitDir, '__pycache__', 'worker.pyc'), 'bytecode');
      mkdirSync(join(gitDir, 'dist.rollback-20260717'), { recursive: true });
      writeFileSync(join(gitDir, 'dist.rollback-20260717', 'cli.js'), 'generated');

      const report = runAutoCommit();
      const actualIndex = execSync('git diff --cached --name-only', {
        cwd: gitDir,
        encoding: 'utf-8',
      }).trim().split('\n').filter(Boolean);

      expect(report.status).toBe('staged');
      expect(report.staged.sort()).toEqual(actualIndex.sort());
      expect(actualIndex.sort()).toEqual([
        'orgs/acme/agents/alice/GOALS.md',
        'orgs/acme/agents/alice/MEMORY.md',
        'orgs/acme/agents/alice/config.json',
      ]);
      expect(report.blocked).toEqual(expect.arrayContaining([
        expect.stringContaining('dashboard/cortextos.db:outside_agent_state_scope'),
        expect.stringContaining('dashboard/cortextos.db-wal:outside_agent_state_scope'),
        expect.stringContaining('__pycache__/worker.pyc:outside_agent_state_scope'),
        expect.stringContaining('dist.rollback-20260717/cli.js:outside_agent_state_scope'),
        expect.stringContaining('orgs/acme/agents/alice/AGENTS.md:outside_agent_state_scope'),
        expect.stringContaining('orgs/acme/agents/alice/memory/2026-07-31.md:outside_agent_state_scope'),
        expect.stringContaining('orgs/acme/agents/bob/memory/2026-07-31.md:outside_agent_state_scope'),
      ]));
    });

    it('refuses a force-tracked daily memory file outside the three-class scope', () => {
      const dailyMemory = 'orgs/acme/agents/alice/memory/2026-08-01.md';
      writeFileSync(join(gitDir, '.gitignore'), 'orgs/*/agents/*/memory/\n');
      writeAgentFile('memory/2026-08-01.md', 'tracked baseline');
      execSync(`git add .gitignore && git add -f ${dailyMemory} && git commit -m "track legacy daily memory"`, {
        cwd: gitDir,
        stdio: 'pipe',
      });
      expect(execSync(`git check-ignore --no-index ${dailyMemory}`, {
        cwd: gitDir,
        encoding: 'utf-8',
      }).trim()).toBe(dailyMemory);
      writeAgentFile('memory/2026-08-01.md', 'changed daily memory');

      const report = runAutoCommit();
      const actualIndex = execSync('git diff --cached --name-only', {
        cwd: gitDir,
        encoding: 'utf-8',
      });

      expect(actualIndex.trim()).toBe('');
      expect(report.staged).toEqual([]);
      expect(report.status).toBe('nothing_to_stage');
      expect(report.blocked).toContain(`${dailyMemory}:outside_agent_state_scope`);
    });

    it('fails loud and reports the actual empty index when git add fails', () => {
      writeAgentFile('GOALS.md', 'safe state');
      writeFileSync(join(gitDir, '.git', 'index.lock'), 'held');

      const report = runAutoCommit();
      const actualIndex = execSync('git diff --cached --name-only', {
        cwd: gitDir,
        encoding: 'utf-8',
      });

      expect(report.status).toBe('error');
      expect(report.staged).toEqual([]);
      expect(actualIndex.trim()).toBe('');
      expect(report.lease.status).toBe('held');
      expect(getAutoCommitLeaseStatus(testDir, 2_000).status).toBe('active');
    });

    it('refuses a nonempty index atomically and names the staged paths', () => {
      writeAgentFile('MEMORY.md', 'existing index state');
      execSync('git add orgs/acme/agents/alice/MEMORY.md', { cwd: gitDir });
      writeAgentFile('GOALS.md', 'must remain unstaged');

      const report = runAutoCommit();
      const actualIndex = execSync('git diff --cached --name-only', {
        cwd: gitDir,
        encoding: 'utf-8',
      }).trim().split('\n').filter(Boolean);

      expect(report.status).toBe('error');
      expect(report.error).toContain('1 staged path');
      expect(report.error).toContain('orgs/acme/agents/alice/MEMORY.md');
      expect(report.staged).toEqual(actualIndex);
      expect(actualIndex).not.toContain('orgs/acme/agents/alice/GOALS.md');
      expect(report.lease.status).toBe('released');
      expect(getAutoCommitLeaseStatus(testDir)).toEqual({ status: 'none' });
    });

    it('refuses a second agent on the lease before inspecting the staged index', () => {
      writeAgentFile('MEMORY.md', 'alice state');
      const first = runAutoCommit();
      expect(first.status).toBe('staged');

      const second = autoCommit(gitDir, false, { org: 'acme', agent: 'bob' }, {
        ctxRoot: testDir,
        now: 2_000,
        token: 'bob-token',
      });

      expect(second.status).toBe('error');
      expect(second.error).toContain('auto-commit lease held by acme/alice until');
      expect(second.error).not.toContain('existing index');
      expect(second.lease).toEqual({
        status: 'contended',
        holder: scope,
        expires_at: 601_000,
      });
    });

    it('records an expired-lease takeover before repository inspection', () => {
      expect(acquireAutoCommitLease({
        ctxRoot: testDir,
        holder: { org: 'acme', agent: 'bob' },
        now: 100,
        ttlMs: 300_000,
        token: 'expired-token',
      }).status).toBe('acquired');
      const takeovers: unknown[] = [];

      const report = autoCommit(gitDir, false, scope, {
        ctxRoot: testDir,
        now: 300_100,
        token: 'replacement-token',
        onTakeover: takeover => takeovers.push(takeover),
      });

      expect(takeovers).toEqual([{
        previous_holder: { org: 'acme', agent: 'bob' },
        previous_expires_at: 300_100,
      }]);
      expect(report.status).toBe('clean');
      expect(report.lease_takeover).toEqual(takeovers[0]);
    });

    it('fails closed and releases the lease when takeover auditing fails', () => {
      acquireAutoCommitLease({
        ctxRoot: testDir,
        holder: { org: 'acme', agent: 'bob' },
        now: 100,
        ttlMs: 300_000,
        token: 'expired-token',
      });
      writeAgentFile('MEMORY.md', 'must remain unstaged');

      const report = autoCommit(gitDir, false, scope, {
        ctxRoot: testDir,
        now: 300_100,
        token: 'replacement-token',
        onTakeover: () => { throw new Error('audit unavailable'); },
      });
      const actualIndex = execSync('git diff --cached --name-only', {
        cwd: gitDir,
        encoding: 'utf-8',
      });

      expect(report.status).toBe('error');
      expect(report.error).toContain('takeover audit failed before index inspection');
      expect(actualIndex.trim()).toBe('');
      expect(report.lease.status).toBe('released');
      expect(getAutoCommitLeaseStatus(testDir)).toEqual({ status: 'none' });
    });
  });

  describe('checkGoalStaleness', () => {
    it('identifies stale goals', () => {
      // Create org/agent structure with old timestamp
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });

      const oldDate = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
      writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${oldDate}\n\nSome goal`);

      const report = checkGoalStaleness(testDir, 7);
      expect(report.summary.total).toBe(1);
      expect(report.summary.stale).toBe(1);
      expect(report.agents[0].status).toBe('stale');
      expect(report.agents[0].agent).toBe('worker');
      expect(report.agents[0].org).toBe('myorg');
      expect(report.agents[0].stale).toBe(true);
    });

    it('identifies fresh goals', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });

      const recentDate = new Date().toISOString();
      writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${recentDate}\n\nSome goal`);

      const report = checkGoalStaleness(testDir, 7);
      expect(report.summary.fresh).toBe(1);
      expect(report.agents[0].status).toBe('fresh');
      expect(report.agents[0].stale).toBe(false);
    });

    it('handles missing GOALS.md', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      // No GOALS.md created

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('missing');
      expect(report.agents[0].stale).toBe(true);
      expect(report.agents[0].reason).toContain('no GOALS.md');
    });

    it('handles missing timestamp in GOALS.md', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'GOALS.md'), '# Goals\n\nJust some text without updated section');

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('no_timestamp');
      expect(report.agents[0].stale).toBe(true);
    });

    it('handles unparseable timestamp', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'GOALS.md'), '# Goals\n\n## Updated\nnot-a-date\n');

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('parse_error');
      expect(report.agents[0].stale).toBe(true);
    });

    it('strips "(by <author>)" suffix from generated-md timestamps', () => {
      // `cortextos goals generate-md` writes `2026-05-18T11:35:27Z (by dane)`.
      // Without the strip, Date() returns Invalid Date and the cron sees
      // parse_error on every agent.
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      const recentDate = new Date(Date.now() - 86400000).toISOString();
      writeFileSync(
        join(agentDir, 'GOALS.md'),
        `# Goals\n\n## Updated\n${recentDate} (by dane)\n\nSome goal`,
      );

      const report = checkGoalStaleness(testDir, 7);
      expect(report.agents[0].status).toBe('fresh');
      expect(report.agents[0].stale).toBe(false);
    });

    it('returns empty report when no orgs directory', () => {
      const report = checkGoalStaleness(testDir);
      expect(report.summary.total).toBe(0);
      expect(report.agents).toEqual([]);
    });

    it('scans multiple orgs and agents', () => {
      // Create two orgs with agents
      for (const org of ['org1', 'org2']) {
        const agentDir = join(testDir, 'orgs', org, 'agents', 'bot');
        mkdirSync(agentDir, { recursive: true });
        const date = new Date().toISOString();
        writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${date}\n`);
      }

      const report = checkGoalStaleness(testDir);
      expect(report.summary.total).toBe(2);
    });
  });

  describe('postActivity', () => {
    it('returns false when not configured', async () => {
      const result = await postActivity(
        join(testDir, 'nonexistent'),
        testDir,
        'myorg',
        'hello',
      );
      expect(result).toBe(false);
    });

    it('returns false when env file has no token', async () => {
      const orgDir = join(testDir, 'orgdir');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'activity-channel.env'), 'ACTIVITY_CHAT_ID=123\n');

      const result = await postActivity(orgDir, testDir, 'myorg', 'hello');
      expect(result).toBe(false);
    });

    it('returns false when env file has no chat ID', async () => {
      const orgDir = join(testDir, 'orgdir');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'activity-channel.env'), 'ACTIVITY_BOT_TOKEN=abc123\n');

      const result = await postActivity(orgDir, testDir, 'myorg', 'hello');
      expect(result).toBe(false);
    });
  });
});
