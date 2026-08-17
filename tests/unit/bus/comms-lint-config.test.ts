import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getDefaultCommsLintRules,
  resolveCommsLintRules,
  type ResolvedCommsLintRules,
} from '../../../src/bus/comms-lint-config';

let tmp: string;

/** Write an org context.json with a comms_lint block under <frameworkRoot>/orgs/<org>/. */
function writeOrgContext(frameworkRoot: string, org: string, commsLint: unknown): void {
  const dir = join(frameworkRoot, 'orgs', org);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'context.json'),
    JSON.stringify({ name: org, comms_lint: commsLint }, null, 2),
  );
}

/** Write a raw org context.json (caller controls full body — for malformed-JSON tests). */
function writeOrgContextRaw(frameworkRoot: string, org: string, raw: string): void {
  const dir = join(frameworkRoot, 'orgs', org);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'context.json'), raw);
}

/** Write an agent config.json with a comms_lint block under <agentDir>/. */
function writeAgentConfig(agentDir: string, commsLint: unknown): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ model: 'opus', comms_lint: commsLint }, null, 2),
  );
}

function ids(rules: { id: string }[]): string[] {
  return rules.map((r) => r.id);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'comms-lint-cfg-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('comms-lint-config loader', () => {
  // Case 1: No config (all opts undefined) → resolved set equals defaults.
  it('returns byte-for-byte defaults when no opts are provided', () => {
    const resolved = resolveCommsLintRules({});
    const defaults = getDefaultCommsLintRules();

    // Counts per group (the §4.6 contract).
    expect(resolved.banned).toHaveLength(9);
    expect(resolved.passive).toHaveLength(2);
    expect(resolved.telegram).toHaveLength(5);
    // Roster-driven: with no roster passed, there is NO agent-name rule — the
    // framework never ships a hardcoded agent roster (config-drive 2026-07-14).
    expect(resolved.agentName).toBeNull();

    // ids match the defaults exactly.
    expect(ids(resolved.banned)).toEqual(ids(defaults.banned));
    expect(ids(resolved.passive)).toEqual(ids(defaults.passive));
    expect(ids(resolved.telegram)).toEqual(ids(defaults.telegram));
    expect(defaults.agentName).toBeNull();

    // Pattern sources + flags match the defaults byte-for-byte.
    const assertSameRegex = (a: RegExp, b: RegExp) => {
      expect(a.source).toBe(b.source);
      expect(a.flags).toBe(b.flags);
    };
    resolved.banned.forEach((r, i) => assertSameRegex(r.pattern, defaults.banned[i].pattern));
    resolved.passive.forEach((r, i) => assertSameRegex(r.pattern, defaults.passive[i].pattern));
    resolved.telegram.forEach((r, i) => assertSameRegex(r.pattern, defaults.telegram[i].pattern));
    assertSameRegex(resolved.activeContext, defaults.activeContext);
    assertSameRegex(resolved.nextSignalContext, defaults.nextSignalContext);

    // Explicit em-dash flag check: NO flags (not blanket-`i`).
    const emDash = resolved.telegram.find((r) => r.id === 'telegram:em-dash')!;
    expect(emDash.pattern.source).toBe('[–—―]');
    expect(emDash.pattern.flags).toBe('');

    // Spot-check a banned source + the `i` flag on a normal rule.
    expect(ids(resolved.banned)).not.toContain('banned:holding');
    const waitingOn = resolved.banned.find((r) => r.id === 'banned:waiting-on')!;
    expect(waitingOn.pattern.source).toBe('\\bwaiting[- ]on[- ]\\w+\\b');
    expect(waitingOn.pattern.flags).toBe('i');
  });

  // Case 2: Missing config files → defaults (fail open).
  it('falls open to defaults when config files do not exist', () => {
    const resolved = resolveCommsLintRules({
      org: 'ghost-org',
      agentDir: join(tmp, 'no-such-agent'),
      frameworkRoot: tmp,
    });
    expect(ids(resolved.banned)).toEqual(ids(getDefaultCommsLintRules().banned));
    expect(resolved.telegram).toHaveLength(5);
  });

  // Case 3: Malformed JSON in org context → defaults (fail open).
  it('falls open to defaults when org context.json is malformed JSON', () => {
    writeOrgContextRaw(tmp, 'acme', '{ this is not valid json ,,,');
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(ids(resolved.banned)).toEqual(ids(getDefaultCommsLintRules().banned));
    expect(resolved.telegram).toHaveLength(5);
  });

  // Case 4: `add` appends a rule to the right group.
  it('appends an added rule to the correct group', () => {
    writeOrgContext(tmp, 'acme', {
      telegram: {
        add: [
          {
            id: 'telegram:project-bluebird',
            pattern: '\\bproject bluebird\\b',
            flags: 'i',
            reason: 'internal codename leak',
            suggest: "say 'the new portal' instead",
          },
        ],
      },
    });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(resolved.telegram).toHaveLength(6);
    const added = resolved.telegram.find((r) => r.id === 'telegram:project-bluebird')!;
    expect(added).toBeDefined();
    expect(added.group).toBe('telegram');
    expect(added.suggest).toBe("say 'the new portal' instead");
    expect(added.pattern.test('this is project bluebird')).toBe(true);
    // banned group untouched.
    expect(resolved.banned).toHaveLength(9);
  });

  // Case 5: `allow` removes a default rule by id.
  it('removes a default rule by id via allow', () => {
    writeOrgContext(tmp, 'acme', { banned: { allow: ['banned:parked'] } });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(resolved.banned).toHaveLength(8);
    expect(ids(resolved.banned)).not.toContain('banned:parked');
    // others intact.
    expect(ids(resolved.banned)).toContain('banned:waiting-on');
  });

  // Case 6: `replace` discards all defaults for a group and uses only provided rules.
  it('replaces an entire group when replace is present', () => {
    writeOrgContext(tmp, 'acme', {
      banned: {
        replace: [
          { id: 'banned:custom', pattern: '\\bzonk\\b', reason: 'custom only' },
        ],
      },
    });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(resolved.banned).toHaveLength(1);
    expect(resolved.banned[0].id).toBe('banned:custom');
    expect(resolved.banned[0].pattern.flags).toBe('i'); // default flag applied
    // other groups still default.
    expect(resolved.telegram).toHaveLength(5);
  });

  // Case 7: Agent layer overrides org layer.
  it('agent layer overrides org layer (agent allow re-permits an org-added ban)', () => {
    // Org adds a ban; agent allowlists it away.
    writeOrgContext(tmp, 'acme', {
      banned: {
        add: [{ id: 'banned:orgword', pattern: '\\borgword\\b', reason: 'org-specific' }],
      },
    });
    const agentDir = join(tmp, 'orgs', 'acme', 'agents', 'dane');
    writeAgentConfig(agentDir, { banned: { allow: ['banned:orgword'] } });

    const resolved = resolveCommsLintRules({ org: 'acme', agentDir, frameworkRoot: tmp });
    expect(ids(resolved.banned)).not.toContain('banned:orgword');
    expect(resolved.banned).toHaveLength(9); // back to default count
  });

  it('agent layer re-bans an org-allowlisted phrase via add', () => {
    // Org allowlists the default parked rule; agent re-adds a parked ban.
    writeOrgContext(tmp, 'acme', { banned: { allow: ['banned:parked'] } });
    const agentDir = join(tmp, 'orgs', 'acme', 'agents', 'dane');
    writeAgentConfig(agentDir, {
      banned: { add: [{ id: 'banned:parked-reban', pattern: '\\bparked\\b', reason: 're-ban' }] },
    });

    const resolved = resolveCommsLintRules({ org: 'acme', agentDir, frameworkRoot: tmp });
    expect(ids(resolved.banned)).not.toContain('banned:parked'); // org removed default
    expect(ids(resolved.banned)).toContain('banned:parked-reban'); // agent re-banned
    const reban = resolved.banned.find((r) => r.id === 'banned:parked-reban')!;
    expect(reban.pattern.test('parked')).toBe(true);
  });

  // Case 8: Invalid regex in a spec → that single rule dropped, others survive, no throw.
  it('drops a rule with an uncompilable regex but keeps the rest', () => {
    writeOrgContext(tmp, 'acme', {
      telegram: {
        add: [
          { id: 'telegram:bad', pattern: '([unclosed', reason: 'bad regex' },
          { id: 'telegram:good', pattern: '\\bgoodword\\b', reason: 'good regex' },
        ],
      },
    });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(ids(resolved.telegram)).not.toContain('telegram:bad');
    expect(ids(resolved.telegram)).toContain('telegram:good');
    expect(resolved.telegram).toHaveLength(6); // 5 defaults + 1 good
  });

  // Case 9: Invalid flags → that rule dropped.
  it('drops a rule with invalid flags', () => {
    writeOrgContext(tmp, 'acme', {
      telegram: {
        add: [{ id: 'telegram:badflags', pattern: '\\bx\\b', flags: 'xz', reason: 'bad flags' }],
      },
    });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(ids(resolved.telegram)).not.toContain('telegram:badflags');
    expect(resolved.telegram).toHaveLength(5);
  });

  it('strips sticky y from every sampled flag combination at config load', () => {
    writeOrgContext(tmp, 'acme', {
      passive: {
        add: [
          { id: 'passive:sticky-y', pattern: '\\bqueued\\b', flags: 'y', reason: 'sticky' },
          { id: 'passive:sticky-iy', pattern: '\\bqueued\\b', flags: 'iy', reason: 'sticky' },
          { id: 'passive:sticky-gy', pattern: '\\bqueued\\b', flags: 'gy', reason: 'sticky' },
        ],
      },
    });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(resolved.passive.find((r) => r.id === 'passive:sticky-y')?.pattern.flags).toBe('');
    expect(resolved.passive.find((r) => r.id === 'passive:sticky-iy')?.pattern.flags).toBe('i');
    expect(resolved.passive.find((r) => r.id === 'passive:sticky-gy')?.pattern.flags).toBe('g');
    expect(resolved.passive).toHaveLength(5);
  });

  it('continues to accept i, g, and gi flags unchanged', () => {
    writeOrgContext(tmp, 'acme', {
      passive: {
        add: [
          { id: 'passive:flag-i', pattern: '\\balpha\\b', flags: 'i', reason: 'control' },
          { id: 'passive:flag-g', pattern: '\\bbeta\\b', flags: 'g', reason: 'control' },
          { id: 'passive:flag-gi', pattern: '\\bgamma\\b', flags: 'gi', reason: 'control' },
        ],
      },
    });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(resolved.passive.find((r) => r.id === 'passive:flag-i')?.pattern.flags).toBe('i');
    expect(resolved.passive.find((r) => r.id === 'passive:flag-g')?.pattern.flags).toBe('g');
    expect(resolved.passive.find((r) => r.id === 'passive:flag-gi')?.pattern.flags).toBe('gi');
  });

  it('still rejects duplicate flags before sticky normalization', () => {
    writeOrgContext(tmp, 'acme', {
      passive: {
        add: [
          { id: 'passive:duplicate-y', pattern: '\\bdelta\\b', flags: 'yy', reason: 'invalid' },
          { id: 'passive:duplicate-i', pattern: '\\bepsilon\\b', flags: 'ii', reason: 'invalid' },
        ],
      },
    });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(ids(resolved.passive)).not.toContain('passive:duplicate-y');
    expect(ids(resolved.passive)).not.toContain('passive:duplicate-i');
    expect(resolved.passive).toHaveLength(2);
  });

  // Case 10: Over-length pattern (>1000 chars) → dropped.
  it('drops a rule whose pattern exceeds the length cap', () => {
    const huge = 'a'.repeat(1001);
    writeOrgContext(tmp, 'acme', {
      banned: { add: [{ id: 'banned:huge', pattern: huge, reason: 'too long' }] },
    });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(ids(resolved.banned)).not.toContain('banned:huge');
    expect(resolved.banned).toHaveLength(9);
  });

  it('also drops a rule whose id fails the id charset check', () => {
    writeOrgContext(tmp, 'acme', {
      banned: { add: [{ id: 'Bad ID!', pattern: '\\bx\\b', reason: 'bad id' }] },
    });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(resolved.banned).toHaveLength(9);
  });

  // Case 11: add_active_context extends the active-context regex; bad extension keeps default.
  it('extends active-context regex so a passive phrase passes with the extra word', () => {
    const defaults = getDefaultCommsLintRules();
    writeOrgContext(tmp, 'acme', { add_active_context: ['snoozing-productively'] });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(resolved.activeContext.source).toContain('snoozing-productively');
    expect(resolved.activeContext.test('snoozing-productively')).toBe(true);
    // original alternatives still present.
    expect(resolved.activeContext.test('working on the feature')).toBe(true);
    // flags stay 'i'.
    expect(resolved.activeContext.flags).toBe('i');
    // sanity: it really did extend (source longer than default).
    expect(resolved.activeContext.source.length).toBeGreaterThan(defaults.activeContext.source.length);
  });

  it('keeps the default active-context regex when an extension fails to compile', () => {
    const defaults = getDefaultCommsLintRules();
    writeOrgContext(tmp, 'acme', { add_active_context: ['([unclosed'] });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(resolved.activeContext.source).toBe(defaults.activeContext.source);
    expect(resolved.activeContext.flags).toBe(defaults.activeContext.flags);
  });

  // Case 12: agentName.allow: ["agent-name:default"] → agentName resolves to null.
  it('disables the agent-name gate when its default id is allowlisted', () => {
    writeOrgContext(tmp, 'acme', { agentName: { allow: ['agent-name:default'] } });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(resolved.agentName).toBeNull();
  });

  it('replaces the agent-name rule and takes the first when more than one is given', () => {
    writeOrgContext(tmp, 'acme', {
      agentName: {
        replace: [
          { id: 'agent-name:first', pattern: '\\bfoo\\b', reason: 'first' },
          { id: 'agent-name:second', pattern: '\\bbar\\b', reason: 'second' },
        ],
      },
    });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(resolved.agentName).not.toBeNull();
    expect(resolved.agentName!.id).toBe('agent-name:first');
  });

  // F1: empty / all-invalid `replace` must NOT zero a rule group — it falls back
  // to the prior layer's resolved set (master plan §4.3 last bullet).
  it('F1: empty replace array retains the default banned group', () => {
    writeOrgContext(tmp, 'acme', { banned: { replace: [] } });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(resolved.banned).toHaveLength(9);
    expect(ids(resolved.banned)).toEqual(ids(getDefaultCommsLintRules().banned));
  });

  it('F1: all-invalid replace specs retain the default banned group', () => {
    writeOrgContext(tmp, 'acme', {
      banned: {
        replace: [
          { id: 'BAD ID!!', pattern: '\\bx\\b', reason: 'bad id' },
          { id: 'banned:badflags', pattern: '\\bx\\b', flags: 'zz', reason: 'bad flags' },
          { id: 'banned:badregex', pattern: '([unclosed', reason: 'uncompilable' },
        ],
      },
    });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(resolved.banned).toHaveLength(9);
    expect(ids(resolved.banned)).toEqual(ids(getDefaultCommsLintRules().banned));
  });

  it('F1: empty replace on a roster-built agentName retains it (not null)', () => {
    writeOrgContext(tmp, 'acme', { agentName: { replace: [] } });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp, roster: ['maple', 'oak'] });
    expect(resolved.agentName).not.toBeNull();
    expect(resolved.agentName!.id).toBe('agent-name:default');
  });

  it('roster-driven: agentName is built from the configured roster, never hardcoded', () => {
    // No roster -> no agent-name rule (does not ship any org's names).
    expect(resolveCommsLintRules({}).agentName).toBeNull();
    // A configured roster -> a rule matching exactly those names.
    const resolved = resolveCommsLintRules({ roster: ['maple', 'oak-2'] });
    expect(resolved.agentName).not.toBeNull();
    expect(resolved.agentName!.id).toBe('agent-name:default');
    expect(resolved.agentName!.pattern.test('handing to maple now')).toBe(true);
    expect(resolved.agentName!.pattern.test('the oak-2 agent')).toBe(true);
    // Our live names are NOT hardcoded — not in this roster, so not matched.
    expect(resolved.agentName!.pattern.test('ask dane about it')).toBe(false);
    expect(resolved.agentName!.pattern.test('collie shipped it')).toBe(false);
  });

  it('F1 control: a single valid replace spec still replaces the whole group', () => {
    writeOrgContext(tmp, 'acme', {
      banned: { replace: [{ id: 'banned:only', pattern: '\\bzonk\\b', reason: 'only one' }] },
    });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(resolved.banned).toHaveLength(1);
    expect(resolved.banned[0].id).toBe('banned:only');
  });

  it('F1 partial: a partially-valid replace uses only the valid specs (no fallback)', () => {
    writeOrgContext(tmp, 'acme', {
      banned: {
        replace: [
          { id: 'banned:valid', pattern: '\\bzonk\\b', reason: 'valid' },
          { id: 'banned:badregex', pattern: '([unclosed', reason: 'uncompilable' },
        ],
      },
    });
    const resolved = resolveCommsLintRules({ org: 'acme', frameworkRoot: tmp });
    expect(resolved.banned).toHaveLength(1);
    expect(resolved.banned[0].id).toBe('banned:valid');
    expect(ids(resolved.banned)).not.toContain('banned:badregex');
  });

  it('never throws and returns defaults even on an internally bogus call', () => {
    // Pass shapes that could trip naive code; loader must stay fail-open.
    const resolved: ResolvedCommsLintRules = resolveCommsLintRules({
      org: '../../etc',
      frameworkRoot: tmp,
      agentDir: tmp,
    });
    expect(resolved.banned.length).toBeGreaterThan(0);
    expect(resolved.telegram).toHaveLength(5);
  });
});
