/**
 * tests/unit/cli/onboarding-skill.test.ts
 *
 * Behavior-preserving lock for the onboarding-skill dedup. The reverse-prompt
 * onboarding skill used to live as a full per-template COPY in each agent template;
 * it is now ONE canonical file (templates/_shared/onboarding/SKILL.md) with
 * role-conditional <!--ROLE--> blocks, materialized per role at scaffold time.
 *
 * The golden fixtures (tests/fixtures/onboarding-golden/<role>.md) are the EXACT
 * pre-refactor per-role template copies, frozen from main. The core guarantee:
 *   stripOnboardingRole(canonical, role) === golden[role]   (byte-for-byte)
 * so the refactor provably changes nothing that ships.
 *
 * NOTE: these goldens lock the CURRENT per-role onboarding output. If onboarding
 * content is intentionally changed later, update the canonical AND regenerate the
 * goldens deliberately; a failure here means the output drifted, intended or not.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  stripOnboardingRole,
  materializeOnboardingSkill,
  resolveCanonicalOnboarding,
} from '../../../src/cli/onboarding-skill.js';
import { installCommunityItem } from '../../../src/bus/catalog.js';

const ROOT = process.cwd();
const CANONICAL = readFileSync(join(ROOT, 'templates', '_shared', 'onboarding', 'SKILL.md'), 'utf-8');
const golden = (role: string): string =>
  readFileSync(join(ROOT, 'tests', 'fixtures', 'onboarding-golden', `${role}.md`), 'utf-8');

const ROLES = ['worker', 'orchestrator', 'analyst'] as const;

// Split a SKILL.md into its YAML frontmatter and body. The community catalog copy carries
// required CONTRIBUTING.md frontmatter (external_calls) that the template worker strip does
// not, so it is BODY-equal to the strip, not byte-identical (Codex P2 on a854039).
function fmBody(text: string): { fm: string; body: string } {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { fm: '', body: text };
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close < 0) return { fm: '', body: text };
  return { fm: lines.slice(1, close).join('\n'), body: lines.slice(close + 1).join('\n') };
}

describe('onboarding canonical: strip(role) is byte-identical to the frozen pre-refactor copy', () => {
  for (const role of ROLES) {
    it(`strip(canonical, '${role}') === golden/${role}.md`, () => {
      expect(stripOnboardingRole(CANONICAL, role)).toBe(golden(role));
    });
  }

  it('the canonical resolves (so a fresh install can find it)', () => {
    expect(resolveCanonicalOnboarding(ROOT)).not.toBeNull();
  });

  it('an unknown role yields role-agnostic core only (no markers, no role-specific content leaks)', () => {
    const out = stripOnboardingRole(CANONICAL, 'nobody');
    expect(out).not.toContain('<!--ROLE');
    expect(out).not.toContain('<!--/ROLE-->');
    expect(out).not.toContain('rm -rf'); // analyst-only Step 5 excluded
    expect(out).not.toContain('Knowledge base ingestion rules set'); // worker-only block excluded
  });

  it('every ROLE block in the canonical is closed (balanced markers)', () => {
    const opens = (CANONICAL.match(/^<!--ROLE [a-z,]+-->$/gm) || []).length;
    const closes = (CANONICAL.match(/^<!--\/ROLE-->$/gm) || []).length;
    expect(opens).toBe(closes);
    expect(opens).toBeGreaterThan(0);
  });
});

describe('materializeOnboardingSkill: scaffold-time materialization matches the golden', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'onboarding-materialize-'));
  });
  afterEach(() => {
    try { rmSync(agentDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function writeRoleMarker(role: string): string {
    const onbDir = join(agentDir, '.claude', 'skills', 'onboarding');
    mkdirSync(onbDir, { recursive: true });
    writeFileSync(join(onbDir, 'role'), `${role}\n`, 'utf-8');
    return onbDir;
  }

  for (const role of ROLES) {
    it(`role='${role}' -> writes SKILL.md == golden and removes the role marker`, () => {
      const onbDir = writeRoleMarker(role);
      materializeOnboardingSkill(agentDir, ROOT, 'TestAgent', 'testorg');
      expect(readFileSync(join(onbDir, 'SKILL.md'), 'utf-8')).toBe(golden(role));
      expect(existsSync(join(onbDir, 'role'))).toBe(false); // marker consumed
    });
  }

  it('no role marker -> no-op (template without onboarding gets none)', () => {
    materializeOnboardingSkill(agentDir, ROOT, 'TestAgent', 'testorg');
    expect(existsSync(join(agentDir, '.claude', 'skills', 'onboarding', 'SKILL.md'))).toBe(false);
  });

  it('invalid role marker -> throws (never silently produces a broken agent)', () => {
    writeRoleMarker('bogus');
    expect(() => materializeOnboardingSkill(agentDir, ROOT, 'TestAgent', 'testorg')).toThrow(/invalid/);
  });
});

describe('stripOnboardingRole hardening: fail-loud guards + CRLF tolerance', () => {
  // CRLF leg (Codex P2): a \r\n checkout must still strip correctly and byte-equal.
  for (const role of ROLES) {
    it(`CRLF canonical -> strip('${role}') byte-equals the \\r\\n-converted golden (no leak, no spurious throw)`, () => {
      const crlf = (s: string) => s.replace(/\n/g, '\r\n');
      expect(stripOnboardingRole(crlf(CANONICAL), role)).toBe(crlf(golden(role)));
    });
  }

  // Negative controls: each adversarial marker shape must THROW (not silent-leak).
  it('nested <!--ROLE--> block -> throws', () => {
    const bad = '<!--ROLE worker-->\n<!--ROLE analyst-->\nx\n<!--/ROLE-->\n<!--/ROLE-->';
    expect(() => stripOnboardingRole(bad, 'worker')).toThrow(/nested/);
  });
  it('unmatched <!--/ROLE--> (close with no open) -> throws', () => {
    expect(() => stripOnboardingRole('a\n<!--/ROLE-->\nb', 'worker')).toThrow(/unmatched/);
  });
  it('unclosed <!--ROLE--> block at EOF -> throws', () => {
    expect(() => stripOnboardingRole('<!--ROLE worker-->\nx', 'worker')).toThrow(/unclosed/);
  });
  it('malformed / uppercase marker -> throws (not shipped as a literal line)', () => {
    expect(() => stripOnboardingRole('<!--ROLE Worker-->\nx\n<!--/ROLE-->', 'worker')).toThrow(/malformed/);
    expect(() => stripOnboardingRole('<!-- ROLE worker -->\nx\n<!--/ROLE-->', 'worker')).toThrow(/malformed/);
  });

  // No false-positive: the real canonical (valid 4-open/4-close) must not throw for any role.
  it('valid canonical does not throw for any role', () => {
    for (const role of [...ROLES, 'nobody']) {
      expect(() => stripOnboardingRole(CANONICAL, role)).not.toThrow();
    }
  });

  // The malformed-guard requires ROLE right after <!--, so an ordinary non-ROLE HTML
  // comment passes through untouched (only ROLE-looking-but-malformed markers throw).
  it('a plain non-ROLE <!-- comment --> passes through untouched', () => {
    const withComment = '<!-- just a normal comment -->\ncontent line';
    expect(stripOnboardingRole(withComment, 'worker')).toBe(withComment);
  });
});

describe('manual cp -r path: raw template copy + materialize yields the golden (sibling-path fix)', () => {
  // The documented Option-B manual path (agent-management skill) does a raw `cp -r` of a
  // template, which does NOT run add-agent's programmatic materialization. Post-refactor
  // that copies only the role marker (no SKILL.md), so the doc now adds a
  // `cortextos materialize-onboarding` step. These tests simulate cp -r + materialize and
  // assert the result is the byte-identical onboardable golden for each role.
  let dest: string;
  beforeEach(() => { dest = mkdtempSync(join(tmpdir(), 'onboarding-manualcp-')); });
  afterEach(() => { try { rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ } });

  const cases: Array<[string, string]> = [['agent', 'worker'], ['orchestrator', 'orchestrator'], ['analyst', 'analyst']];
  for (const [template, role] of cases) {
    it(`cp -r templates/${template} then materialize -> SKILL.md == golden/${role}.md, marker consumed`, () => {
      const agentDir = join(dest, 'agent');
      cpSync(join(ROOT, 'templates', template), agentDir, { recursive: true }); // simulate the documented cp -r
      const onb = join(agentDir, '.claude', 'skills', 'onboarding');
      // the raw copy yields the marker, NOT a SKILL.md (the bug Codex found)
      expect(existsSync(join(onb, 'role'))).toBe(true);
      expect(existsSync(join(onb, 'SKILL.md'))).toBe(false);
      // the documented materialize step:
      materializeOnboardingSkill(agentDir, ROOT, 'TestAgent', 'testorg');
      expect(readFileSync(join(onb, 'SKILL.md'), 'utf-8')).toBe(golden(role));
      expect(existsSync(join(onb, 'role'))).toBe(false);
    });
  }

  it('idempotent: materialize again on an already-materialized agent is a no-op', () => {
    const agentDir = join(dest, 'agent');
    cpSync(join(ROOT, 'templates', 'agent'), agentDir, { recursive: true });
    const onb = join(agentDir, '.claude', 'skills', 'onboarding');
    materializeOnboardingSkill(agentDir, ROOT, 'TestAgent', 'testorg');
    const first = readFileSync(join(onb, 'SKILL.md'), 'utf-8');
    materializeOnboardingSkill(agentDir, ROOT, 'TestAgent', 'testorg'); // run again
    expect(readFileSync(join(onb, 'SKILL.md'), 'utf-8')).toBe(first); // unchanged
    expect(existsSync(join(onb, 'role'))).toBe(false);
  });
});

describe('step-2 item-1: re-runnable onboarding (no self-delete) + catalog-source unify', () => {
  // The model: onboarding is a RE-RUNNABLE skill, NEVER self-deleting, on ANY role.
  it('no role output contains a self-delete (re-runnable for every role)', () => {
    for (const role of ['worker', 'orchestrator', 'analyst']) {
      const out = stripOnboardingRole(CANONICAL, role);
      expect(out, `${role} must not self-delete`).not.toMatch(/rm -rf|Remove this skill/);
    }
  });

  it('analyst output no longer carries the Step 5 self-delete (intentional change)', () => {
    expect(stripOnboardingRole(CANONICAL, 'analyst')).not.toContain('Step 5: Remove this skill');
    expect(golden('analyst')).not.toContain('rm -rf');
  });

  // Add-anytime model: the catalog source (raw-copied by install-community-item) must deliver
  // the CURRENT re-runnable skill BODY. It is a community catalog skill, so it carries required
  // CONTRIBUTING.md frontmatter (external_calls) the template worker strip does not, hence
  // BODY-equality + frontmatter-present, not byte-identity (Codex P2 on a854039 caught the
  // earlier byte-identity test silently dropping external_calls).
  it('catalog source community/skills/onboarding: BODY == worker strip + external_calls VALUE matches body footprint', () => {
    const catalogSrc = readFileSync(join(ROOT, 'community', 'skills', 'onboarding', 'SKILL.md'), 'utf-8');
    const { fm, body } = fmBody(catalogSrc);
    expect(body).toBe(fmBody(stripOnboardingRole(CANONICAL, 'worker')).body);
    expect(body).toBe(fmBody(golden('worker')).body);
    // value-matches-footprint (Codex P2 on f3d68aa): the body curls raw.githubusercontent.com
    // (installer) and runs detect-chat-id (api.telegram.org), so [] under-reported. Both must be declared.
    expect(fm).toMatch(/^external_calls:/m);
    expect(fm).toMatch(/api\.telegram\.org/);
    expect(fm).toMatch(/raw\.githubusercontent\.com/);
  });

  it('community/agents onboarding copies (research-agent, security): plain worker-strip body, NOT under the catalog frontmatter contract', () => {
    for (const host of [
      join('community', 'agents', 'research-agent', '.claude', 'skills', 'onboarding', 'SKILL.md'),
      join('community', 'agents', 'security', '.claude', 'skills', 'onboarding', 'SKILL.md'),
    ]) {
      const { fm, body } = fmBody(readFileSync(join(ROOT, host), 'utf-8'));
      expect(body, `${host} body`).toBe(fmBody(golden('worker')).body); // body single-sourced from the worker strip
      expect(fm, `${host} frontmatter`).not.toMatch(/^external_calls:/m); // community/agents, not a catalog skill
    }
  });

  it('install-community-item onboarding delivers the worker-strip BODY + catalog frontmatter (add-anytime proven)', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'onboarding-install-'));
    const ctxRoot = mkdtempSync(join(tmpdir(), 'onboarding-ctx-'));
    try {
      const res = installCommunityItem(ROOT, ctxRoot, 'onboarding', { agentDir });
      expect(res.status, JSON.stringify(res)).not.toBe('error');
      const installed = readFileSync(join(agentDir, '.claude', 'skills', 'onboarding', 'SKILL.md'), 'utf-8');
      // Body-equal to the current re-runnable worker strip, with the catalog frontmatter preserved.
      expect(fmBody(installed).body).toBe(fmBody(golden('worker')).body);
      expect(fmBody(installed).fm).toMatch(/^external_calls:/m);
      // P2 (Codex 75bbe33): the installed skill must itself carry the persistent-cron pointer so
      // add-anytime delivers cron guidance on ANY target, independent of the target's ONBOARDING.md.
      expect(installed).toContain('cortextos bus add-cron');
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(ctxRoot, { recursive: true, force: true });
    }
  });

  // P2 fix (Codex same-head on 75bbe33): the add-anytime skill delegated cron setup to the
  // target ONBOARDING.md, but 6 of 18 ONBOARDING.md targets carry no add-cron (3 community
  // agents + 3 bare template targets), so installing onboarding onto them lost persistent-
  // cron guidance. The canonical now carries a concise self-contained "Persistent crons"
  // pointer, so EVERY materialize/install delivers it regardless of the target. These
  // assertions reproduce that condition at the source (the prior test asserted only 3 core
  // templates and passed while the regression was live).
  it('canonical carries a self-contained persistent-cron pointer', () => {
    expect(CANONICAL).toContain('cortextos bus add-cron');
  });

  it('every role strip carries the persistent-cron pointer (robust to any target agent)', () => {
    for (const role of ['worker', 'orchestrator', 'analyst']) {
      expect(
        stripOnboardingRole(CANONICAL, role),
        `${role} strip must carry the add-cron pointer`,
      ).toContain('cortextos bus add-cron');
    }
  });
});
