import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot =
  process.env.HEARTBEAT_TEST_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const claudeSkillPath = join(repoRoot, 'templates/agent/.claude/skills/heartbeat/SKILL.md');
const codexHeartbeatPath = join(repoRoot, 'templates/agent-codex/HEARTBEAT.md');
const codexSkillPath = join(
  repoRoot,
  'templates/agent-codex/plugins/cortextos-agent-skills/skills/heartbeat/SKILL.md',
);
const populationOutput = execFileSync(process.execPath, [
  join(repoRoot, 'scripts/fleet-population.mjs'), 'paths',
  '--registry', join(repoRoot, 'scripts/fleet-populations.json'),
  '--root', repoRoot,
  '--population', 'framework.skill-templates',
  '--skill', 'heartbeat', '--format', 'json',
], { encoding: 'utf8' });
const populationLines = populationOutput.trim().split('\n');
const populationReceipt = populationLines.slice(0, -1).join('\n');
const heartbeatTargets: Array<{ id: string; layout: string; path: string; representation: string }> =
  JSON.parse(populationLines.at(-1)!).targets;
const humanQueueFilter =
  '[.[] | select(.assigned_to == "human" or .assigned_to == "david" or .project == "human-tasks")]';
const humanQueueConsumption = 'human/David assignee OR "human-tasks" project';
const humanQueueTemplates = [
  { name: 'agent', occurrences: 2 },
  { name: 'leasing-coordinator', occurrences: 1 },
  { name: 'maintenance-coordinator', occurrences: 1 },
  { name: 'renewals-coordinator', occurrences: 1 },
  { name: 'turnover-coordinator', occurrences: 1 },
];

const tempDirs: string[] = [];

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function extractMemorySizeProbe(markdown: string): string {
  const match = markdown.match(
    /# MEMORY_SIZE_PROBE_BEGIN\n([\s\S]*?)# MEMORY_SIZE_PROBE_END/,
  );
  if (!match) throw new Error('memory-size probe markers are missing');
  return match[1].trim();
}

function extractSharedLivenessTail(markdown: string): string {
  const start = markdown.indexOf('## Updating Heartbeat');
  if (start < 0) throw new Error('shared liveness tail is missing');
  return markdown.slice(start).trim();
}

function extractFirstHeartbeatProcedure(markdown: string): string[] {
  const section = markdown.slice(markdown.indexOf('## Your Heartbeat Cron'));
  const match = section.match(/```bash\n([\s\S]*?)\n```/);
  if (!match) throw new Error('first heartbeat procedure block is missing');
  return match[1].split('\n');
}

function makeHeartbeatExecutionFixture(updateExit: number): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  callsPath: string;
  timerMarker: string;
  updateMarker: string;
} {
  const cwd = mkdtempSync(join(tmpdir(), 'heartbeat-barrier-'));
  tempDirs.push(cwd);
  const binDir = join(cwd, 'bin');
  const timerDir = join(cwd, 'framework/orgs/acme/agents/_shared/scripts');
  const callsPath = join(cwd, 'calls');
  const timerMarker = join(cwd, 'timer-active');
  const updateMarker = join(cwd, 'update-running');
  mkdirSync(binDir);
  mkdirSync(timerDir, { recursive: true });

  writeFileSync(
    join(timerDir, 'heartbeat-timer.sh'),
    `#!/bin/sh
printf 'timer:%s\\n' "$*" >> "$CALLS"
case "$1" in
  start) : > "$TIMER_MARKER" ;;
  end) rm -f "$TIMER_MARKER" ;;
esac
`,
  );
  writeFileSync(
    join(binDir, 'cortextos'),
    `#!/bin/sh
if [ "$1" = "bus" ] && [ "$2" = "update-heartbeat" ]; then
  printf 'update:start\\n' >> "$CALLS"
  : > "$UPDATE_MARKER"
  sleep 0.05
  rm -f "$UPDATE_MARKER"
  printf 'update:exit:%s\\n' "$UPDATE_EXIT" >> "$CALLS"
  exit "$UPDATE_EXIT"
fi
if [ "$1" = "bus" ] && [ "$2" = "check-inbox" ]; then
  if [ -e "$UPDATE_MARKER" ]; then
    printf 'check-inbox:overlap\\n' >> "$CALLS"
    exit 91
  fi
  printf 'check-inbox:after-update\\n' >> "$CALLS"
  exit 0
fi
printf 'cortextos:%s\\n' "$*" >> "$CALLS"
`,
  );
  chmodSync(join(timerDir, 'heartbeat-timer.sh'), 0o755);
  chmodSync(join(binDir, 'cortextos'), 0o755);

  return {
    cwd,
    callsPath,
    timerMarker,
    updateMarker,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      CALLS: callsPath,
      TIMER_MARKER: timerMarker,
      UPDATE_MARKER: updateMarker,
      UPDATE_EXIT: String(updateExit),
      CTX_FRAMEWORK_ROOT: join(cwd, 'framework'),
      CTX_ORG: 'acme',
      CTX_AGENT_NAME: 'fixture',
    },
  };
}

function makeLinuxProbeFixture(statOutput = '12345'): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  callsPath: string;
} {
  const cwd = mkdtempSync(join(tmpdir(), 'heartbeat-size-probe-'));
  tempDirs.push(cwd);
  const binDir = join(cwd, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(cwd, 'MEMORY.md'), 'fixture');

  const callsPath = join(cwd, 'stat-calls');
  writeFileSync(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  writeFileSync(
    join(binDir, 'stat'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$STAT_CALLS"
if [ "$1" = "-f" ]; then
  printf 'GNU filesystem report that must never be captured\\n'
  exit 1
fi
printf '%s\\n' "${statOutput}"
`,
  );
  chmodSync(join(binDir, 'uname'), 0o755);
  chmodSync(join(binDir, 'stat'), 0o755);

  return {
    cwd,
    callsPath,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      STAT_CALLS: callsPath,
    },
  };
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('canonical heartbeat procedures', () => {
  it('discovers project-marked human tasks without admitting ordinary agent work', () => {
    for (const { name, occurrences } of humanQueueTemplates) {
      const skill = read(join(repoRoot, `templates/${name}/.claude/skills/heartbeat/SKILL.md`));
      expect(skill.split(`jq '${humanQueueFilter}'`)).toHaveLength(occurrences + 1);
      expect(skill.split(humanQueueConsumption)).toHaveLength(2);
      const selectorAt = skill.indexOf(`jq '${humanQueueFilter}'`);
      const gateAt = skill.indexOf('POSITIVE LANE GATE', selectorAt);
      const consumptionAt = skill.indexOf(humanQueueConsumption, selectorAt);
      const reminderAt = skill.indexOf('send ONE Telegram reminder', consumptionAt);
      expect(gateAt).toBeGreaterThan(selectorAt);
      expect(consumptionAt).toBeGreaterThan(gateAt);
      expect(reminderAt).toBeGreaterThan(consumptionAt);
      expect(skill.indexOf('out-of-lane task', reminderAt)).toBeGreaterThan(reminderAt);
    }

    const tasks = [
      { id: 'project-human', assigned_to: 'builder', project: 'human-tasks' },
      { id: 'assigned-human', assigned_to: 'human', project: 'operations' },
      { id: 'assigned-david', assigned_to: 'david', project: 'operations' },
      { id: 'ordinary-agent', assigned_to: 'builder', project: 'operations' },
    ];
    const filtered = JSON.parse(execFileSync('jq', ['-c', humanQueueFilter], {
      input: JSON.stringify(tasks),
      encoding: 'utf8',
    }));

    expect(filtered.map((task: { id: string }) => task.id)).toEqual([
      'project-human',
      'assigned-human',
      'assigned-david',
    ]);
  });

  it('enumerates every heartbeat-bearing template before contract checks', () => {
    expect(populationReceipt).toContain('expected_population=13');
    expect(populationReceipt).toContain('registry_enumerated_population=13');
    expect(populationReceipt).toContain('observed_population=13');
    expect(populationReceipt).toContain('status=OK');
    expect(heartbeatTargets).toHaveLength(8);
    expect(heartbeatTargets.filter((target) => target.layout === 'claude-skills')).toHaveLength(7);
    expect(heartbeatTargets.find((target) => target.id === 'agent-codex')?.representation).toBe('pointer');
    expect(populationReceipt).not.toContain('POINTER_REFERENCE_MISMATCH');
  });

  it('applies the layout-specific canonical contract to every returned target', () => {
    for (const target of heartbeatTargets) {
      const skill = read(join(target.path, 'SKILL.md'));
      if (target.layout === 'codex-plugin-skills') {
        expect(skill).toContain('canonical Codex heartbeat procedure is root `HEARTBEAT.md`');
        expect(skill).not.toMatch(/^## Step /m);
      } else {
        expect(skill).toContain('## Updating Heartbeat');
        expect(skill).toContain('cortextos bus read-all-heartbeats');
        expect(skill).toMatch(/(?:cortextos|ascendops) bus list-crons(?: \$CTX_AGENT_NAME)?/);
      }
    }
  });
  it('updates durable memory before the Claude ingest step', () => {
    const claude = read(claudeSkillPath);
    const memoryUpdate = claude.indexOf('### Step 9: Update Long-Term Memory');
    const ingest = claude.indexOf('### Step 10: Re-ingest Memory');

    expect(memoryUpdate).toBeGreaterThan(-1);
    expect(ingest).toBeGreaterThan(memoryUpdate);
    expect(claude).toContain('so any durable-memory change is searchable in the same heartbeat');
  });

  it('makes Step 1 a sequential barrier with one authoritative step count', () => {
    const claude = read(claudeSkillPath);
    const procedure = extractFirstHeartbeatProcedure(claude);

    expect(claude.match(/Steps 0-13 run on EVERY heartbeat cron fire/g)).toHaveLength(1);
    expect(claude).not.toMatch(/\b(?:full |ALL )?12(?:-step| steps)\b/i);
    expect(claude).toContain(
      'After Step 0 starts the duration record, Step 1 is a sequential barrier: `update-heartbeat` must finish before normal Step 2 or any later step runs and before any file is read.',
    );
    expect(claude).not.toContain('Run Steps 1-6 as ONE block');
    expect(claude).toContain('heartbeat-timer.sh" start   # 0 duration instrumentation');
    expect(claude).toContain('### Step 13: Close the duration record');
    expect(procedure[0]).toMatch(
      /^bash "\$CTX_FRAMEWORK_ROOT\/orgs\/\$CTX_ORG\/agents\/_shared\/scripts\/heartbeat-timer\.sh" start\s+# 0 duration instrumentation$/,
    );
    expect(procedure[1]).toMatch(
      /^if cortextos bus update-heartbeat "WORKING ON: <task>"; then\s+# 1 foreground barrier$/,
    );
    expect(procedure[2]).toMatch(/^\s{2}cortextos bus check-inbox\s+# 2$/);
  });

  it('starts Step 2 only after the foreground heartbeat update exits zero', () => {
    const procedure = extractFirstHeartbeatProcedure(read(claudeSkillPath)).join('\n');
    const fixture = makeHeartbeatExecutionFixture(0);

    execFileSync('/bin/bash', ['-c', procedure], {
      cwd: fixture.cwd,
      env: fixture.env,
      encoding: 'utf8',
    });

    const calls = read(fixture.callsPath).trim().split('\n');
    expect(calls.slice(0, 4)).toEqual([
      'timer:start',
      'update:start',
      'update:exit:0',
      'check-inbox:after-update',
    ]);
    expect(calls).not.toContain('check-inbox:overlap');
    expect(existsSync(fixture.updateMarker)).toBe(false);
  });

  it('records and closes a degraded fire when the heartbeat update fails', () => {
    const procedure = extractFirstHeartbeatProcedure(read(claudeSkillPath)).join('\n');
    const fixture = makeHeartbeatExecutionFixture(23);

    execFileSync('/bin/bash', ['-c', procedure], {
      cwd: fixture.cwd,
      env: fixture.env,
      encoding: 'utf8',
    });

    const calls = read(fixture.callsPath).trim().split('\n');
    expect(calls).toEqual([
      'timer:start',
      'update:start',
      'update:exit:23',
      'cortextos:bus log-event error heartbeat_update_failed error --meta {"agent":"fixture","step":1}',
      'timer:end degraded',
    ]);
    expect(calls.some((call) => call.startsWith('check-inbox:'))).toBe(false);
    expect(existsSync(fixture.timerMarker)).toBe(false);
    expect(existsSync(fixture.updateMarker)).toBe(false);
    const memoryFiles = readdirSync(join(fixture.cwd, 'memory'));
    expect(memoryFiles).toHaveLength(1);
    expect(read(join(fixture.cwd, 'memory', memoryFiles[0]))).toContain(
      'Step 1 update-heartbeat returned nonzero; normal Steps 2-12 did not run.',
    );
  });

  it('keeps one byte-identical memory-size probe in both runtime procedures', () => {
    expect(extractMemorySizeProbe(read(claudeSkillPath))).toBe(
      extractMemorySizeProbe(read(codexHeartbeatPath)),
    );
  });

  it('uses only GNU stat on Linux and returns a numeric size', () => {
    const probe = extractMemorySizeProbe(read(claudeSkillPath));
    const fixture = makeLinuxProbeFixture();
    const output = execFileSync('/bin/sh', ['-c', `${probe}\nprintf 'MEMSZ=%s STATUS=%s\\n' "$MEMSZ" "$MEMSZ_STATUS"`], {
      cwd: fixture.cwd,
      env: fixture.env,
      encoding: 'utf8',
    });

    expect(output).toBe('MEMSZ=12345 STATUS=measured\n');
    expect(read(fixture.callsPath)).toBe('-c %s MEMORY.md\n');
  });

  it('marks nonnumeric platform output unmeasurable when it collapses to zero', () => {
    const probe = extractMemorySizeProbe(read(codexHeartbeatPath));
    const fixture = makeLinuxProbeFixture('not-a-number');
    const output = execFileSync('/bin/sh', ['-c', `${probe}\nprintf 'MEMSZ=%s STATUS=%s\\n' "$MEMSZ" "$MEMSZ_STATUS"`], {
      cwd: fixture.cwd,
      env: fixture.env,
      encoding: 'utf8',
    });

    expect(output).toBe('MEMSZ=0 STATUS=unmeasurable\n');
  });

  it('distinguishes a measured zero-byte file from an unmeasurable result', () => {
    const probe = extractMemorySizeProbe(read(codexHeartbeatPath));
    const fixture = makeLinuxProbeFixture('0');
    const output = execFileSync('/bin/sh', ['-c', `${probe}\nprintf 'MEMSZ=%s STATUS=%s\\n' "$MEMSZ" "$MEMSZ_STATUS"`], {
      cwd: fixture.cwd,
      env: fixture.env,
      encoding: 'utf8',
    });

    expect(output).toBe('MEMSZ=0 STATUS=measured\n');
  });

  it('preserves all four promoted generic steps in both canonicals', () => {
    const claude = read(claudeSkillPath);
    const codex = read(codexHeartbeatPath);

    expect(claude).toContain('### Step 7: Check GOALS.md');
    expect(claude).toContain('### Step 8: Guardrail Self-Check');
    expect(claude).toContain('### Step 9: Update Long-Term Memory');
    expect(claude).toContain('### Step 12: Decide What Work Resumes');

    expect(codex).toContain('## Step 6: Check GOALS.md');
    expect(codex).toContain('## Step 7: Resume work');
    expect(codex).toContain('## Step 8: Guardrail self-check');
    expect(codex).toContain('## Step 9: Update long-term memory (if applicable)');
  });

  it('keeps the shared liveness capability byte-equivalent across canonicals', () => {
    const claude = read(claudeSkillPath);
    const codex = read(codexHeartbeatPath);

    expect(extractSharedLivenessTail(codex)).toBe(extractSharedLivenessTail(claude));

    for (const procedure of [claude, codex]) {
      expect(procedure).toContain('cortextos bus read-all-heartbeats');
      expect(procedure).toContain('cat "$CTX_ROOT/state/<agent-name>/heartbeat.json"');
      expect(procedure).toContain('cortextos status');
      expect(procedure).toContain('pm2 list');
      expect(procedure).toContain('$CTX_ROOT/state/{agent}/heartbeat.json');
      expect(procedure).toMatch(/Never claim a status you have(?:n't| not) verified/);
      expect(procedure).toContain('cortextos bus list-crons $CTX_AGENT_NAME');
    }
  });

  it('keeps the Codex plugin skill as a pointer rather than a second checklist', () => {
    const skill = read(codexSkillPath);
    expect(skill).toContain('canonical Codex heartbeat procedure is root `HEARTBEAT.md`');
    expect(skill).not.toMatch(/^## Step /m);
  });
});
