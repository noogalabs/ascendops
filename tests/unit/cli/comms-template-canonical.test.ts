import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const result = execFileSync(process.execPath, [
  join(ROOT, 'scripts/fleet-population.mjs'), 'paths',
  '--registry', join(ROOT, 'scripts/fleet-populations.json'),
  '--root', ROOT,
  '--population', 'framework.skill-templates',
  '--skill', 'comms', '--format', 'json',
], { encoding: 'utf8' });
const lines = result.trim().split('\n');
const receipt = lines.slice(0, -1).join('\n');
const COMMS_PATHS: string[] = JSON.parse(lines.at(-1)!).targets.map(
  (target: { relativePath: string }) => `${target.relativePath}/SKILL.md`,
);

const FORMAT_PER_AUDIENCE_SECTION = `## Composing Your Reply (format per audience)

Handling a message is two steps, not one: decide the action, then WRITE the reply. The command in the header only covers *how to send*, not *what to say*. Match the reply to the audience.

**Human-facing (David, residents, vendors, techs) → short, answer-first, plain.**
- Lead with the answer or the ask. Put it in the first sentence.
- Cut background, cut context you were not asked for, cut narrating back the steps you took or what you told someone else.
- Do not tell people what to do beyond what the situation needs. No upsells ("One thing for you: want me to also...").
- No embellishment. No commitments David has not authorized (do not tell a resident "we'll send a crew" before the go).
- Pre-send check: **"Would 2-3 plain sentences cover this?"** If yes, send those. "Done." / "Got it." is a complete reply.

**Agent-to-agent / docs (bus messages to peers, memory, specs) → structured is fine.** Bullets, headers, code blocks help scanning here. The concision rule above is for humans, not peers.

CONSEQUENCE: over-verbose human replies get corrected. David lock 2026-07-03: "Stop adding extra context. Stop telling people what to do. Stop talking for the sake of talking... be TERSE... applies to EVERYTHING." See fleet lessons format-per-audience (locked 2026-05-27) and plain-language-with-David.`;

describe('comms template format-per-audience contract', () => {
  it('censuses every public template while resolving the eight canonical skill targets', () => {
    expect(receipt).toContain('expected_population=13');
    expect(receipt).toContain('registry_enumerated_population=13');
    expect(receipt).toContain('observed_population=13');
    expect(receipt).toContain('resolved_targets=8');
    expect(receipt).toContain('status=OK');
    expect(COMMS_PATHS).toHaveLength(8);
  });

  it.each(COMMS_PATHS)('%s carries the exact contract once', (path) => {
    const contents = readFileSync(join(ROOT, path), 'utf8');
    expect(contents.split(FORMAT_PER_AUDIENCE_SECTION)).toHaveLength(2);
  });
});
