import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { installCommunityItem } from '../../src/bus/catalog';

const adapter = join(process.cwd(), 'community/skills/pm/scripts/send-owner-route.py');
const zshAvailable = spawnSync('zsh', ['-c', 'exit 0']).status === 0;
const zshSkipReason = 'skipped: zsh is unavailable; equivalent Bash -u scenarios remain mandatory';
let dir: string;
let sender: string;
let binding: string;
let record: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owner-route-'));
  sender = join(dir, 'sender.py'); binding = join(dir, 'binding.json'); record = join(dir, 'delivered.json');
  writeFileSync(sender, '#!/usr/bin/env python3\nimport json,sys,os\nopen(os.environ["OWNER_TEST_RECORD"],"w").write(json.dumps(sys.argv[1:]))\nprint("PRIVATE_SENDER_OUTPUT")\nprint("PRIVATE_SENDER_ERROR",file=sys.stderr)\nsys.exit(int(os.environ.get("OWNER_TEST_RC","0")))\n');
  chmodSync(sender, 0o700);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const valid = () => JSON.stringify({ argv: [sender], recipient: 'configured-owner' });
const run = (path = binding, extra = {}) => spawnSync('python3', [adapter, path, 'URGENT fixture'], {
  encoding: 'utf8', env: { ...process.env, OWNER_TEST_RECORD: record, ...extra },
});

describe('member owner route examples', () => {
  it('delivers via the bound non-Telegram argv and recipient without leaking output', () => {
    writeFileSync(binding, valid()); const r = run();
    expect(r.status).toBe(0); expect(r.stdout).toBe(''); expect(r.stderr).toBe('');
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual(['configured-owner', 'URGENT fixture']);
  });
  const invalid = [
    ['scalar-command', () => JSON.stringify({ argv: sender, recipient: 'configured-owner' })],
    ['multiple-routes', () => JSON.stringify([{ argv: [sender], recipient: 'configured-owner' }])],
    ['unknown-key', () => JSON.stringify({ argv: [sender], recipient: 'configured-owner', fallback: true })],
    ['duplicate-key', () => '{"argv":[],"argv":["' + sender + '"],"recipient":"configured-owner"}'],
    ['empty-recipient', () => JSON.stringify({ argv: [sender], recipient: ' ' })],
    ['relative-executable', () => JSON.stringify({ argv: ['sender'], recipient: 'configured-owner' })],
    ['invalid-utf8', () => Buffer.concat([Buffer.from('{"argv":["' + sender + '"],"recipient":"'), Buffer.from([0xff]), Buffer.from('"}')])],
    ['bom', () => Buffer.from('\ufeff' + valid())],
    ['nul', () => Buffer.from(valid() + '\0')],
  ] as const;
  for (const [name, bytes] of invalid) it('refuses ' + name + ' without owner delivery or binding disclosure', () => {
    writeFileSync(binding, bytes()); const r = run();
    expect(r.status).toBe(20); expect(r.stdout).toBe(''); expect(r.stderr).toBe('');
    expect(() => readFileSync(record)).toThrow();
  });
  it('refuses a missing binding without disclosing its path', () => {
    const r = run(); expect(r.status).toBe(20); expect(r.stderr).toBe('');
  });
  it('marks a failed send as outcome unknown even when the sender recorded delivery', () => {
    writeFileSync(binding, valid()); const r = run(binding, { OWNER_TEST_RC: '1' });
    expect(r.status).toBe(21); expect(JSON.parse(readFileSync(record, 'utf8'))[0]).toBe('configured-owner');
    expect(r.stdout + r.stderr).toBe('');
  });
  it('marks a missing sender as not sent, without exposing the binding', () => {
    writeFileSync(binding, JSON.stringify({ argv: [join(dir, 'missing-sender')], recipient: 'configured-owner' }));
    const r = run(); expect(r.status).toBe(22); expect(r.stdout + r.stderr).toBe('');
    expect(existsSync(record)).toBe(false);
  });
  for (const skill of ['pm-meld-triage', 'pm-morning-scan']) {
    const skillDir = join(process.cwd(), 'community/skills/pm', skill);
    const source = () => readFileSync(join(process.cwd(), 'community/skills/pm', skill, 'SKILL.md'), 'utf8');
    const snippet = () => source().split('owner_route_status=0')[1].split('```')[0];
    it(skill + ' catalog install delivers through its bundled reader from an unrelated cwd', () => {
      const installed = installCommunityItem(process.cwd(), dir, skill, { agentDir: join(dir, 'agent') });
      expect(installed.status).toBe('installed');
      const target = join(dir, 'agent/.claude/skills', skill);
      expect(readFileSync(join(target, 'scripts/send-owner-route.py'))).toEqual(readFileSync(adapter));
      writeFileSync(binding, valid());
      const installedSource = readFileSync(join(target, 'SKILL.md'), 'utf8');
      const installedEnv: NodeJS.ProcessEnv = { ...process.env, CTX_AGENT_DIR: join(dir, 'agent'),
        PM_OWNER_BINDING_PATH: binding, OWNER_TEST_RECORD: record,
        CTX_ORCHESTRATOR_AGENT: 'configured-coordinator' };
      delete installedEnv.PM_SKILL_DIR;
      delete installedEnv.PM_OWNER_ROUTE_ADAPTER;
      const r = spawnSync('bash', ['-u', '-c', 'owner_route_status=0' + installedSource.split('owner_route_status=0')[1].split('```')[0]], {
        cwd: dir, encoding: 'utf8', env: installedEnv,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(readFileSync(record, 'utf8'))[0]).toBe('configured-owner');
    });
    for (const shell of ['bash', 'zsh']) {
      for (const scenario of ['missing', 'scalar', 'broken-reader', 'missing-context', 'missing-sender', 'send-failed', 'valid']) {
        it.skipIf(shell === 'zsh' && !zshAvailable)(skill + ' ' + shell + ' -u: ' + scenario + ' preserves visibility and bound routing' + (shell === 'zsh' && !zshAvailable ? ' (' + zshSkipReason + ')' : ''), () => {
          const alarms = join(dir, 'alarms.json'); const bus = join(dir, 'cortextos');
          writeFileSync(bus, '#!/usr/bin/env python3\nimport json,sys,os\nopen(os.environ["OWNER_TEST_ALARMS"],"w").write(json.dumps(sys.argv[1:]))\n'); chmodSync(bus, 0o700);
          if (scenario === 'scalar') writeFileSync(binding, JSON.stringify({ argv: sender, recipient: 'configured-owner' }));
          else if (scenario === 'missing-sender') writeFileSync(binding, JSON.stringify({ argv: [join(dir, 'absent-sender')], recipient: 'configured-owner' }));
          else if (scenario !== 'missing') writeFileSync(binding, valid());
          const callerEnv: NodeJS.ProcessEnv = { ...process.env, PATH: dir + ':' + process.env.PATH,
              PM_SKILL_DIR: skillDir, PM_OWNER_BINDING_PATH: binding, PM_OWNER_ROUTE_ADAPTER: scenario === 'broken-reader' ? join(dir, 'absent.py') : adapter,
              CTX_ORCHESTRATOR_AGENT: 'configured-coordinator', OWNER_TEST_RECORD: record, OWNER_TEST_ALARMS: alarms,
              OWNER_TEST_RC: scenario === 'send-failed' ? '1' : '0',
              PM_MAINTENANCE_OWNER_ROUTE_ARGV: 'poisoned scalar command',
          };
          if (scenario === 'missing-context') {
            delete callerEnv.CTX_AGENT_DIR; delete callerEnv.PM_SKILL_DIR; delete callerEnv.PM_OWNER_ROUTE_ADAPTER;
          }
          const r = spawnSync(shell, ['-u', '-c', 'owner_route_status=0' + snippet()], {
            encoding: 'utf8', env: callerEnv,
          });
          if (r.error && shell === 'zsh') throw r.error;
          if (scenario === 'valid') { expect(r.status).toBe(0); expect(() => readFileSync(alarms)).toThrow(); }
          else {
            expect(r.status).not.toBe(0); expect(existsSync(alarms), 'independent coordinator alarm').toBe(true); const args = JSON.parse(readFileSync(alarms, 'utf8'));
            expect(args.slice(0, 4)).toEqual(['bus', 'send-message', 'configured-coordinator', 'urgent']);
            expect(args[4]).toContain('URGENT:');
            if (scenario === 'send-failed') expect(args[4]).toContain('outcome unknown');
            expect(args[4]).toContain(['missing', 'scalar'].includes(scenario) ? 'OWNER_CONTACT_BINDING_REQUIRED' : ['broken-reader', 'missing-context', 'missing-sender'].includes(scenario) ? 'OWNER_CONTACT_NOT_SENT' : 'OWNER_CONTACT_SEND_OUTCOME_UNKNOWN');
            if (scenario !== 'send-failed') expect(args[4]).toContain('not sent');
          }
        });
      }
    }
  }
});
