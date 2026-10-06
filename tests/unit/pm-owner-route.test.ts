import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const adapter = join(process.cwd(), 'community/skills/pm/scripts/send-owner-route.py');
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
  for (const skill of ['pm-meld-triage', 'pm-morning-scan']) {
    const source = () => readFileSync(join(process.cwd(), 'community/skills/pm', skill, 'SKILL.md'), 'utf8');
    const snippet = () => source().split('owner_route_status=0')[1].split('```')[0];
    for (const shell of ['bash', 'zsh']) {
      for (const scenario of ['missing', 'scalar', 'broken-reader', 'send-failed', 'valid']) {
        it(skill + ' ' + shell + ' -u: ' + scenario + ' preserves visibility and bound routing', () => {
          const alarms = join(dir, 'alarms.json'); const bus = join(dir, 'cortextos');
          writeFileSync(bus, '#!/usr/bin/env python3\nimport json,sys,os\nopen(os.environ["OWNER_TEST_ALARMS"],"w").write(json.dumps(sys.argv[1:]))\n'); chmodSync(bus, 0o700);
          if (scenario === 'scalar') writeFileSync(binding, JSON.stringify({ argv: sender, recipient: 'configured-owner' }));
          else if (scenario !== 'missing') writeFileSync(binding, valid());
          const r = spawnSync(shell, ['-u', '-c', 'owner_route_status=0' + snippet()], {
            encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH,
              PM_OWNER_BINDING_PATH: binding, PM_OWNER_ROUTE_ADAPTER: scenario === 'broken-reader' ? join(dir, 'absent.py') : adapter,
              CTX_ORCHESTRATOR_AGENT: 'configured-coordinator', OWNER_TEST_RECORD: record, OWNER_TEST_ALARMS: alarms,
              OWNER_TEST_RC: scenario === 'send-failed' ? '1' : '0',
              PM_MAINTENANCE_OWNER_ROUTE_ARGV: 'poisoned scalar command',
            },
          });
          if (r.error && shell === 'zsh') throw r.error;
          if (scenario === 'valid') { expect(r.status).toBe(0); expect(() => readFileSync(alarms)).toThrow(); }
          else {
            expect(r.status).not.toBe(0); expect(existsSync(alarms), 'independent coordinator alarm').toBe(true); const args = JSON.parse(readFileSync(alarms, 'utf8'));
            expect(args.slice(0, 4)).toEqual(['bus', 'send-message', 'configured-coordinator', 'urgent']);
            expect(args[4]).toContain('URGENT:');
            if (scenario === 'send-failed') expect(args[4]).toContain('outcome unknown');
            expect(args[4]).toContain(['missing', 'scalar'].includes(scenario) ? 'OWNER_CONTACT_BINDING_REQUIRED' : 'OWNER_CONTACT_SEND_OUTCOME_UNKNOWN');
          }
        });
      }
    }
  }
});
