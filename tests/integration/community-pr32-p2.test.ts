import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('community PR #32 P2 regressions', () => {
  it('routes PM session notifications to the configured orchestrator', () => {
    const skill = read('community/skills/pm/pm-session-recapture/SKILL.md');
    expect(skill).not.toContain('send-message an agent');
    expect(skill.match(/send-message "\$\{CTX_ORCHESTRATOR_AGENT:\?Configure the member orchestrator\}"/g)).toHaveLength(2);
    expect(skill).not.toContain('send-message "$CTX_ORCHESTRATOR_AGENT"');
  });

  it('uses a supported event category throughout copilot-threshold', () => {
    const skill = read('community/skills/copilot-threshold/SKILL.md');
    expect(skill).not.toMatch(/bus log-event quality\b/);
    expect(skill.match(/bus log-event metric\b/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('documents the runtime Gmail watch contract without deployment-specific labels', () => {
    const gmail = read('community/skills/gmail/SKILL.md');
    const triage = read('community/skills/pm/pm-meld-triage/SKILL.md');

    expect(gmail).toContain('"gmail_watch"');
    expect(gmail).toContain('"processed_label_id"');
    expect(gmail).toMatch(/"query"\s*:\s*"[^"]*-label:[^"]+"/);
    expect(gmail).not.toContain('GMAIL_PROCESSED_LABEL_ID');
    expect(gmail).not.toContain('GMAIL_PROCESSED_LABEL_NAME');
    expect(gmail).not.toMatch(/Label_\d+/);
    expect(gmail).not.toMatch(/[a-z]+-processed/);

    expect(triage).toContain('config.gmail_watch.processed_label_id');
    expect(triage).toContain('-label:<processed-label-name>');
    expect(triage).not.toMatch(/[a-z]+-processed/);
  });

  it('does not point the leasing bundle at an unshipped AppFolio skill', () => {
    for (const path of [
      'community/agents/leasing-coordinator/ONBOARDING.md',
      'community/agents/leasing-coordinator/TOOLS.md',
      'community/agents/leasing-coordinator/CLAUDE.md',
    ]) {
      expect(read(path), path).not.toContain('.claude/skills/appfolio/SKILL.md');
    }
  });
});
