import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Item-2 agent-management dedup (shared-core + orchestrator overlay).
//
// The agent-management skill was duplicated across 9 hosts that had drifted. The shared
// core is now single-sourced: the canonical lives at templates/agent and the other 7
// non-orchestrator hosts are byte-identical mirrors (asserted by scripts/skill-mirrors.json
// via the CI drift-check). The orchestrator copy is intentionally NOT a byte-mirror: it
// carries one orchestrator-only "Migration Check" block, because the agent-migration skill
// it references ships ONLY with the orchestrator. Forcing byte-identity would have injected
// a dangling skill reference (and an un-runnable migration flow) into the 8 worker hosts.
//
// This file proves the 9-way invariant the mirror-guard cannot: the orchestrator MINUS its
// Migration Check overlay equals the shared-core canonical. Combined with the 7-way mirror
// group, that means all 9 hosts share one core and the overlay is the only delta.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const ORCH = 'templates/orchestrator/.claude/skills/agent-management/SKILL.md';
const CANON = 'templates/agent/.claude/skills/agent-management/SKILL.md';

// The overlay is delimited by its own subheader and the next subheader. The dedup excised
// exactly this span to build the shared core; the equality assertion below guarantees this
// cut reproduces the canonical byte-for-byte (a different cut would fail the test).
const OVERLAY_START = '### Migration Check';
const OVERLAY_END = '### For Yourself (Same User)';

describe('agent-management dedup: shared core single-sourced, orchestrator overlay only', () => {
  it('orchestrator carries exactly one Migration Check overlay', () => {
    const orch = read(ORCH);
    expect(orch.indexOf(OVERLAY_START)).toBeGreaterThan(-1);
    expect(orch.indexOf(OVERLAY_START)).toBe(orch.lastIndexOf(OVERLAY_START));
    expect(orch.indexOf(OVERLAY_END)).toBe(orch.lastIndexOf(OVERLAY_END));
  });

  it('orchestrator minus the Migration Check overlay == the shared-core canonical (9-way core proof)', () => {
    const orch = read(ORCH);
    const start = orch.indexOf(OVERLAY_START);
    const end = orch.indexOf(OVERLAY_END);
    expect(end).toBeGreaterThan(start);
    const orchCore = orch.slice(0, start) + orch.slice(end);
    expect(orchCore).toBe(read(CANON));
  });

  it('the shared-core canonical carries NO orchestrator-only content', () => {
    const canon = read(CANON);
    expect(canon).not.toContain('agent-migration');
    expect(canon).not.toContain('Migration Check');
  });
});

// Community-catalog copy: body single-sourced from the shared core, but it carries required
// CONTRIBUTING.md frontmatter (external_calls) that template skills do not. A naive full-file
// byte-mirror dropped external_calls (Codex P2 on a854039), and the mirror-guard would re-drop
// it on every future drift-fix. So the catalog copy is frontmatter-EXEMPT from the byte-mirror
// and BODY-guarded here, with external_calls asserted present.
const CATALOG = 'community/skills/agent-management/SKILL.md';

function frontmatterBody(text: string): { fm: string; body: string } {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { fm: '', body: text };
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close < 0) return { fm: '', body: text };
  return { fm: lines.slice(1, close).join('\n'), body: lines.slice(close + 1).join('\n') };
}

describe('agent-management community-catalog copy: body single-sourced + required frontmatter', () => {
  it('community/skills/agent-management BODY == shared-core canonical body', () => {
    expect(frontmatterBody(read(CATALOG)).body).toBe(frontmatterBody(read(CANON)).body);
  });

  it('community/skills/agent-management declares external_calls (CONTRIBUTING.md requires it)', () => {
    expect(frontmatterBody(read(CATALOG)).fm).toMatch(/^external_calls:/m);
  });
});
