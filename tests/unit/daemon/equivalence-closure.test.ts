import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { handoffGraceMs } from '../../../src/daemon/fast-checker.js';

const root = join(import.meta.dirname, '../../..');

describe('upstream equivalence closure', () => {
  it('keeps Codex handoff grace wider than the default runtime grace', () => {
    expect(handoffGraceMs('codex-app-server')).toBe(600_000);
    expect(handoffGraceMs('claude-code')).toBe(120_000);
  });

  it('pins map-entry identity and teardown state at the manager construction site', () => {
    const source = readFileSync(join(root, 'src/daemon/agent-manager.ts'), 'utf8');
    expect(source).toContain('private stillMapped(name: string, entry: AgentEntry)');
    expect(source).toContain('const ownEntry: AgentEntry = { process: agentProcess, checker };');
    expect(source).toContain('entry.stopped = true;');
    expect(source).toContain('if (this.stillMapped(name, entry)) this.agents.delete(name);');
  });

  it('pins death-confirmed stop before teardown resolves', () => {
    const source = readFileSync(join(root, 'src/daemon/agent-process.ts'), 'utf8');
    expect(source).toContain("process.kill(childPid, 'SIGKILL')");
    expect(source).toContain('while (isChildAlive(childPid) && Date.now() < deadline)');
    expect(source).toContain('if (this.stopInFlight) await this.stopInFlight;');
  });
});
