import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseEnvFile, parseEnvFileStrict, parseEnvContent } from '../../src/utils/env.js';
import { AgentPTY } from '../../src/pty/agent-pty.js';

/**
 * Regression cover for the 2026-08-13 secrets.env DATABASE_URL defect.
 *
 * orgs/<org>/secrets.env carried an UNQUOTED value containing a bare `&`:
 *   DATABASE_URL=postgresql://…?sslmode=require&channel_binding=require
 *
 * Any shell that `source`d the file split that line at the `&`, leaving
 * DATABASE_URL unset and exporting a stray `channel_binding=require`.
 *
 * Quoting the value was not safe on its own: the PTY layers parsed env files
 * with hand-rolled loops that did not strip surrounding quotes, so a quoted
 * value would have reached every agent and codex session with literal `"`
 * characters attached.
 *
 * SCOPE OF THE CONTRACT PINNED HERE (deliberately narrow — see PR discussion):
 * this file pins the QUOTE-HANDLING property for the readers this PR changes —
 * the two PTY layers plus AgentProcess.resolveHermesHome, which must agree with
 * AgentPTY about the SAME agent .env. It does NOT claim parity across every
 * reader: a census by defect shape (grep "indexOf('=')") finds 16 parsing sites,
 * and the rest keep private parsers that vary in quote handling, inline-comment
 * handling, and read-failure semantics. Consolidating those is tracked separately.
 *
 * The paths changed here pass stripInlineComments:false, because the loops they
 * replace preserved a literal ` #` and changing that would silently truncate a
 * credential on restart.
 *
 * Mock-free on real files by design — a mocked `fs` here could encode the exact
 * bug under test.
 */

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'env-quote-parity-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeEnv(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

function makeLayoutFor(name: string, opts: {
  orgSecrets?: string | 'UNREADABLE';
  agentEnv?: string | 'UNREADABLE';
}): { env: Record<string, string>; agentDir: string } {
  const root = join(dir, name);
  const agentDir = join(root, 'orgs', 'acme', 'agents', 'worker');
  mkdirSync(agentDir, { recursive: true });

  const orgPath = join(root, 'orgs', 'acme', 'secrets.env');
  if (opts.orgSecrets === 'UNREADABLE') mkdirSync(orgPath, { recursive: true });
  else if (opts.orgSecrets !== undefined) writeFileSync(orgPath, opts.orgSecrets, 'utf-8');

  const agentPath = join(agentDir, '.env');
  if (opts.agentEnv === 'UNREADABLE') mkdirSync(agentPath, { recursive: true });
  else if (opts.agentEnv !== undefined) writeFileSync(agentPath, opts.agentEnv, 'utf-8');

  return {
    env: {
      instanceId: 'test',
      ctxRoot: join(root, 'ctx'),
      frameworkRoot: root,
      agentName: 'worker',
      agentDir,
      org: 'acme',
      projectRoot: root,
    },
    agentDir,
  };
}

async function spawnAndCapture(layout: ReturnType<typeof makeLayoutFor>) {
  let captured: Record<string, string> | null = null;
  const fakePty = {
    pid: 1234,
    write: vi.fn(),
    onData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onExit: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    kill: vi.fn(),
  };
  const pty = new AgentPTY(layout.env as never, { vendor: 'anthropic' } as never);
  (pty as unknown as { spawnFn: unknown }).spawnFn = (
    _cmd: string,
    _args: string[],
    o: { env: Record<string, string> },
  ) => {
    captured = o.env;
    return fakePty;
  };
  try {
    await pty.spawn('fresh', 'hello');
  } finally {
    try { pty.kill(); } catch { /* fake pty */ }
  }
  return captured!;
}



async function withDaemonHermesHome(value: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env['HERMES_HOME'];
  process.env['HERMES_HOME'] = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env['HERMES_HOME'];
    else process.env['HERMES_HOME'] = prev;
  }
}

describe('parseEnvContent: values containing shell metacharacters', () => {
  it('preserves an unquoted value containing & (the pre-fix on-disk form)', () => {
    const p = writeEnv(
      'unquoted.env',
      'DATABASE_URL=postgresql://u:pw@host/db?sslmode=require&channel_binding=require\n',
    );
    expect(parseEnvFile(p).DATABASE_URL).toBe(
      'postgresql://u:pw@host/db?sslmode=require&channel_binding=require',
    );
  });

  it('strips double quotes and preserves & (the post-fix on-disk form)', () => {
    const p = writeEnv(
      'dquoted.env',
      'DATABASE_URL="postgresql://u:pw@host/db?sslmode=require&channel_binding=require"\n',
    );
    const val = parseEnvFile(p).DATABASE_URL;
    expect(val).toBe('postgresql://u:pw@host/db?sslmode=require&channel_binding=require');
    expect(val.startsWith('"')).toBe(false);
    expect(val.endsWith('"')).toBe(false);
  });

  it('strips single quotes and preserves &', () => {
    const p = writeEnv('squoted.env', "DATABASE_URL='postgres://h/db?a=1&b=2'\n");
    expect(parseEnvFile(p).DATABASE_URL).toBe('postgres://h/db?a=1&b=2');
  });

  it('does not strip an unbalanced or interior quote', () => {
    const v = parseEnvContent('A="lead\nB=trail"\nC=mid"dle\n');
    expect(v.A).toBe('"lead');
    expect(v.B).toBe('trail"');
    expect(v.C).toBe('mid"dle');
  });

  it('keeps a lone quote character intact rather than slicing it away', () => {
    // Guards the length >= 2 condition: a single `"` both starts and ends with a
    // quote, so a naive check would slice it into an empty string.
    expect(parseEnvContent('A="\n').A).toBe('"');
  });

  it('loads every key after a value containing & (no early termination)', () => {
    const v = parseEnvContent(
      [
        'GEMINI_API_KEY=abc123',
        'DATABASE_URL=postgres://h/db?sslmode=require&channel_binding=require',
        'R2_ACCOUNT_ID=zzz999',
      ].join('\n') + '\n',
    );
    expect(v.GEMINI_API_KEY).toBe('abc123');
    expect(v.R2_ACCOUNT_ID).toBe('zzz999');
    // A shell `source` of this same file leaks `channel_binding`; the parser must not.
    expect(v.channel_binding).toBeUndefined();
  });
});

describe('inline ` #` is preserved on the paths whose parser changed', () => {
  // Codex review 2026-08-13. The loops replaced in the PTY layer passed an
  // unquoted value through whole; parseEnvContent truncates at ` #` by default.
  // A password or token like `prefix #suffix` would silently change on restart.
  //
  // The measurement that made this look safe was scoped wrong: zero files on THIS
  // box carry such a value, but per-agent `.env` files are gitignored and this is
  // installable software, so other deployments hold files that cannot be surveyed.
  // A window is not the population.
  it('truncates at " #" by default (unchanged for existing callers)', () => {
    expect(parseEnvContent('SECRET=prefix #suffix\n').SECRET).toBe('prefix');
  });

  it('preserves the whole value when stripInlineComments is false', () => {
    expect(
      parseEnvContent('SECRET=prefix #suffix\n', { stripInlineComments: false }).SECRET,
    ).toBe('prefix #suffix');
  });

  it('still strips surrounding quotes while preserving an interior " #"', () => {
    expect(
      parseEnvContent('SECRET="prefix #suffix"\n', { stripInlineComments: false }).SECRET,
    ).toBe('prefix #suffix');
  });

  it('AgentPTY hands the child the untruncated value', async () => {
    const layout = makeLayoutFor('pty-hash', { orgSecrets: 'SECRET=prefix #suffix\n' });
    const env = await spawnAndCapture(layout);
    expect(env.SECRET).toBe('prefix #suffix');
  });
});

describe('resolveHermesHome agrees with the environment AgentPTY builds', () => {
  // Codex review 2026-08-13. AgentProcess.resolveHermesHome() existed precisely to
  // match what AgentPTY loads into the child — and then parsed the same file with
  // its own quote-blind loop. Once AgentPTY began stripping quotes, a quoted
  // HERMES_HOME gave the child `/srv/hermes-home` while this probed a path with
  // literal quotes in it, so state.db was never found and every restart launched
  // in fresh mode. Silent, because a missing db is indistinguishable from a first run.
  //
  // The invariant is AGREEMENT between the two readers, so that is what is asserted
  // rather than either one's value in isolation.
  async function hermesHomeSeenByDaemon(layout: ReturnType<typeof makeLayoutFor>) {
    const { AgentProcess } = await import('../../src/daemon/agent-process.js');
    const proc = new AgentProcess(
      'worker',
      layout.env as never,
      { vendor: 'anthropic' } as never,
      () => {},
    );
    return (proc as unknown as { resolveHermesHome(): string | undefined }).resolveHermesHome();
  }

  it('a QUOTED HERMES_HOME resolves identically for daemon and child', async () => {
    const layout = makeLayoutFor('hermes-quoted', {
      agentEnv: 'HERMES_HOME="/srv/hermes-home"\n',
    });
    const childValue = (await spawnAndCapture(layout)).HERMES_HOME;
    const daemonValue = await hermesHomeSeenByDaemon(layout);

    expect(childValue).toBe('/srv/hermes-home');
    expect(daemonValue).toBe(childValue);
  });

  it('an UNQUOTED HERMES_HOME still resolves identically', async () => {
    const layout = makeLayoutFor('hermes-unquoted', {
      agentEnv: 'HERMES_HOME=/srv/plain-home\n',
    });
    const childValue = (await spawnAndCapture(layout)).HERMES_HOME;
    expect(await hermesHomeSeenByDaemon(layout)).toBe(childValue);
  });

  it('an explicitly BLANK override agrees, and does not fall through to the daemon env', async () => {
    // reviewer 2026-08-13. AgentPTY assigns whatever the file says, so `HERMES_HOME=`
    // puts an empty string in the child. A truthiness test in the daemon instead
    // falls through to process.env, so the daemon probes an inherited path while
    // the child runs with the blank — continue-vs-fresh decided from a DB the
    // child never uses. Absence and explicit-blank are different answers.
    await withDaemonHermesHome('/daemon/inherited-home', async () => {
      const layout = makeLayoutFor('hermes-blank', { agentEnv: 'HERMES_HOME=\n' });
      const childValue = (await spawnAndCapture(layout)).HERMES_HOME;
      expect(childValue).toBe('');
      expect(await hermesHomeSeenByDaemon(layout)).toBe(childValue);
    });
  });

  it('true ABSENCE falls through to the daemon env — and the CHILD inherits it too', async () => {
    // The other half of the blank casualty: fixing blank must not break inheritance.
    //
    // This also pins the deeper half. resolveHermesHome has always fallen back to
    // process.env, but HERMES_HOME was not in getBaseEnv's allowlist, so the child
    // could never receive that value — the fallback resolved to a path the child
    // structurally could not use. Asserting the daemon value alone would have
    // ratified that divergence, so both sides are asserted.
    await withDaemonHermesHome('/daemon/inherited-home', async () => {
      const layout = makeLayoutFor('hermes-absent', { agentEnv: 'BOT_TOKEN=tok\n' });
      const childValue = (await spawnAndCapture(layout)).HERMES_HOME;
      expect(childValue).toBe('/daemon/inherited-home');
      expect(await hermesHomeSeenByDaemon(layout)).toBe(childValue);
    });
  });

  it('an ORG-level HERMES_HOME reaches the child and the daemon agrees', async () => {
    // reviewer 2026-08-13. AgentPTY layers org secrets.env UNDER agent .env; the
    // daemon checked only the agent .env, so an org-level value reached the child
    // while the daemon fell through to its own process.env.
    await withDaemonHermesHome('/daemon/inherited-home', async () => {
      const layout = makeLayoutFor('hermes-org-only', {
        orgSecrets: 'HERMES_HOME="/org/shared-hermes"\n',
        agentEnv: 'BOT_TOKEN=tok\n',
      });
      const childValue = (await spawnAndCapture(layout)).HERMES_HOME;
      expect(childValue).toBe('/org/shared-hermes');
      expect(await hermesHomeSeenByDaemon(layout)).toBe(childValue);
    });
  });

  it('an ORG-level BLANK overrides the daemon env on both sides', async () => {
    await withDaemonHermesHome('/daemon/inherited-home', async () => {
      const layout = makeLayoutFor('hermes-org-blank', {
        orgSecrets: 'HERMES_HOME=\n',
        agentEnv: 'BOT_TOKEN=tok\n',
      });
      const childValue = (await spawnAndCapture(layout)).HERMES_HOME;
      expect(childValue).toBe('');
      expect(await hermesHomeSeenByDaemon(layout)).toBe(childValue);
    });
  });

  it('agent .env wins over org secrets, on both sides', async () => {
    await withDaemonHermesHome('/daemon/inherited-home', async () => {
      const layout = makeLayoutFor('hermes-agent-over-org', {
        orgSecrets: 'HERMES_HOME=/org/shared-hermes\n',
        agentEnv: 'HERMES_HOME=/agent/own-hermes\n',
      });
      const childValue = (await spawnAndCapture(layout)).HERMES_HOME;
      expect(childValue).toBe('/agent/own-hermes');
      expect(await hermesHomeSeenByDaemon(layout)).toBe(childValue);
    });
  });

  it('an agent BLANK overrides a non-blank org value, on both sides', async () => {
    // Key-presence must hold at EVERY layer, not just the last one consulted.
    await withDaemonHermesHome('/daemon/inherited-home', async () => {
      const layout = makeLayoutFor('hermes-agent-blank-over-org', {
        orgSecrets: 'HERMES_HOME=/org/shared-hermes\n',
        agentEnv: 'HERMES_HOME=\n',
      });
      const childValue = (await spawnAndCapture(layout)).HERMES_HOME;
      expect(childValue).toBe('');
      expect(await hermesHomeSeenByDaemon(layout)).toBe(childValue);
    });
  });

  it('a value containing " #" resolves identically and untruncated', async () => {
    const layout = makeLayoutFor('hermes-hash', {
      agentEnv: 'HERMES_HOME=/srv/home #2\n',
    });
    const childValue = (await spawnAndCapture(layout)).HERMES_HOME;
    expect(childValue).toBe('/srv/home #2');
    expect(await hermesHomeSeenByDaemon(layout)).toBe(childValue);
  });
});

describe('CodexAppServerPTY actually loads env files into its child environment', () => {
  // reviewer 2026-08-13. This file CLAIMED to pin both PTY layers but only ever
  // drove AgentPTY. Deleting CodexAppServerPTY's env loading outright left this
  // file and the whole codex unit suite GREEN 129/129 — the original defect could
  // return on every Codex session with all committed tests passing. Precisely the
  // vacuity class this PR exists to close, reproduced one runtime over.
  //
  // buildEnv() is the real production assembler and calls loadEnvFile itself, so
  // this drives it directly rather than standing up the app-server transport.
  async function codexEnvFor(layout: ReturnType<typeof makeLayoutFor>) {
    const { CodexAppServerPTY } = await import('../../src/pty/codex-app-server-pty.js');
    const pty = new CodexAppServerPTY(layout.env as never, {} as never);
    return (pty as unknown as { buildEnv(): Record<string, string> }).buildEnv();
  }

  it('delivers a QUOTED org secret with its quotes stripped', async () => {
    const layout = makeLayoutFor('codex-quoted', {
      orgSecrets: 'DATABASE_URL="postgres://u:p@h/db?sslmode=require&channel_binding=require"\n',
    });
    expect((await codexEnvFor(layout)).DATABASE_URL).toBe(
      'postgres://u:p@h/db?sslmode=require&channel_binding=require',
    );
  });

  it('preserves an UNQUOTED value containing &', async () => {
    const layout = makeLayoutFor('codex-amp', { orgSecrets: 'DATABASE_URL=postgres://h/db?a=1&b=2\n' });
    expect((await codexEnvFor(layout)).DATABASE_URL).toBe('postgres://h/db?a=1&b=2');
  });

  it('loads agent .env too, and lets it override org secrets', async () => {
    const layout = makeLayoutFor('codex-override', {
      orgSecrets: 'SHARED="org-value"\nORG_ONLY=org\n',
      agentEnv: 'SHARED="agent-value"\nBOT_TOKEN="tok-123"\n',
    });
    const env = await codexEnvFor(layout);
    expect(env.ORG_ONLY).toBe('org');        // org path invoked
    expect(env.BOT_TOKEN).toBe('tok-123');   // agent path invoked
    expect(env.SHARED).toBe('agent-value');  // and in the right order
  });

  it('preserves a literal " #" rather than truncating the value', async () => {
    const layout = makeLayoutFor('codex-hash', { orgSecrets: 'SECRET=prefix #suffix\n' });
    expect((await codexEnvFor(layout)).SECRET).toBe('prefix #suffix');
  });

  it('stays TOLERANT of an unreadable env file, unlike AgentPTY', async () => {
    // Its pre-existing contract: loadEnvFile swallowed read errors. AgentPTY is
    // strict. The asymmetry is deliberate, so it is pinned rather than assumed.
    const layout = makeLayoutFor('codex-unreadable', { orgSecrets: 'UNREADABLE' });
    await expect(codexEnvFor(layout)).resolves.toBeTruthy();
  });
});

describe('strict vs tolerant readers: both casualties', () => {
  // An unreadable-but-present file. A DIRECTORY at the env path yields EISDIR for
  // every user — chmod 000 would not fail for root, so CI running as root would
  // silently lose this assertion.
  function unreadablePath(name: string): string {
    const p = join(dir, name);
    mkdirSync(p, { recursive: true });
    return p;
  }

  it('parseEnvFileStrict THROWS on a present-but-unreadable file', () => {
    expect(() => parseEnvFileStrict(unreadablePath('strict-unreadable.env'))).toThrow();
  });

  it('parseEnvFile stays tolerant and returns {}', () => {
    expect(parseEnvFile(unreadablePath('tolerant-unreadable.env'))).toEqual({});
  });
});

describe('AgentPTY actually loads env files into the spawned environment', () => {
  // Behavioural, not structural. An earlier version of this file asserted only
  // that the source text mentioned the parser and no longer contained the old
  // loop — which passed with BOTH call sites deleted, because the import and the
  // comments still carried the token. A test that survives deleting the thing it
  // covers is measuring something else.

  it('delivers a QUOTED org secret to the agent with its quotes stripped', async () => {
    const layout = makeLayoutFor('pty-quoted', {
      orgSecrets: 'DATABASE_URL="postgres://u:p@h/db?sslmode=require&channel_binding=require"\n',
    });
    const env = await spawnAndCapture(layout);
    // The whole reason step 3 (quoting the value) is safe only after this ships.
    expect(env.DATABASE_URL).toBe('postgres://u:p@h/db?sslmode=require&channel_binding=require');
  });

  it('delivers an UNQUOTED value containing & intact', async () => {
    const layout = makeLayoutFor('pty-unquoted', {
      orgSecrets: 'DATABASE_URL=postgres://h/db?a=1&b=2\n',
    });
    const env = await spawnAndCapture(layout);
    expect(env.DATABASE_URL).toBe('postgres://h/db?a=1&b=2');
  });

  it('loads the agent .env too, and lets it override org secrets', async () => {
    const layout = makeLayoutFor('pty-override', {
      orgSecrets: 'SHARED="org-value"\nORG_ONLY=org\n',
      agentEnv: 'SHARED="agent-value"\nBOT_TOKEN="tok-123"\n',
    });
    const env = await spawnAndCapture(layout);
    expect(env.ORG_ONLY).toBe('org');        // org path invoked
    expect(env.BOT_TOKEN).toBe('tok-123');   // agent path invoked
    expect(env.SHARED).toBe('agent-value');  // and in the right order
  });

  it('FAILS LOUD when the org secrets file is present but unreadable', async () => {
    const layout = makeLayoutFor('pty-org-unreadable', { orgSecrets: 'UNREADABLE' });
    // Must not spawn an agent whose secrets silently vanished.
    await expect(spawnAndCapture(layout)).rejects.toThrow();
  });

  it('FAILS LOUD when the agent .env is present but unreadable', async () => {
    const layout = makeLayoutFor('pty-agent-unreadable', {
      orgSecrets: 'ORG_ONLY=org\n',
      agentEnv: 'UNREADABLE',
    });
    await expect(spawnAndCapture(layout)).rejects.toThrow();
  });
});
