import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const populationOutput = execFileSync(process.execPath, [
  join(ROOT, 'scripts/fleet-population.mjs'), 'paths',
  '--registry', join(ROOT, 'scripts/fleet-populations.json'),
  '--root', ROOT,
  '--population', 'framework.skill-templates',
  '--skill', 'comms', '--format', 'json',
], { encoding: 'utf8' });
const populationLines = populationOutput.trim().split('\n');
const commsPaths: string[] = JSON.parse(populationLines.at(-1)!).targets.map(
  (target: { relativePath: string }) => join(ROOT, target.relativePath, 'SKILL.md'),
);

const SAFE_TELEGRAM_REPLY = "Reply using: cortextos bus send-telegram <chat_id> '<your reply>'";
const UNSAFE_TELEGRAM_REPLY = 'Reply using: cortextos bus send-telegram <chat_id> "<your reply>"';
const APOSTROPHE_RULE = "add the standard shell literal sequence `'\\''`";
const SHELL_SAFE_EXAMPLE =
  'cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" \'I\'\\\'\'ve approved $250; `date` remains literal.\'';

describe('promoted comms and approvals content safety', () => {
  it('teaches shell-literal Telegram payloads across the complete comms population', () => {
    expect(commsPaths).toHaveLength(8);
    for (const path of commsPaths) {
      const contents = readFileSync(path, 'utf8');
      expect(contents.split(SAFE_TELEGRAM_REPLY)).toHaveLength(2);
      expect(contents.split(APOSTROPHE_RULE)).toHaveLength(2);
      expect(contents.split(SHELL_SAFE_EXAMPLE)).toHaveLength(2);
      expect(contents).not.toContain(UNSAFE_TELEGRAM_REPLY);
    }

    const shells = ['/bin/sh', '/bin/zsh'].filter(existsSync);
    expect(shells.length).toBeGreaterThan(0);
    for (const shell of shells) {
      const output = execFileSync(shell, ['-c', [
        'cortextos() { printf %s "$4"; }',
        'CTX_TELEGRAM_CHAT_ID=123',
        SHELL_SAFE_EXAMPLE,
      ].join('\n')], { encoding: 'utf8' });
      expect(output).toBe("I've approved $250; `date` remains literal.");
    }
  });

  it('records Telegram authorization by resolving the approval, not acknowledging an inbox ID', () => {
    const contents = readFileSync(
      join(ROOT, 'templates/agent/.claude/skills/approvals/SKILL.md'),
      'utf8',
    );
    expect(contents.split('cortextos bus update-approval "$APPR_ID" approved')).toHaveLength(2);
    expect(contents).not.toContain('cortextos bus ack-inbox "$APPR_ID"');
  });
});
