import { chmodSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export type Pr267ReaperScenarioName =
  | 'census-to-prune-race-refuses'
  | 'post-prune-census-failure-freezes-counts'
  | 'writer-fence-covers-shipped-writers'
  | 'dry-run-discriminates-without-delete'
  | 'legacy-five-condition-gate-fails-closed';

function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pr267-reaper-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'base']);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', root]);
  const branch = execFileSync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
  const state = join(root, 'state');
  execFileSync('mkdir', ['-p', join(state, 'state/agents/fixture/worktree')]);
  const bin = join(root, 'bin'); execFileSync('mkdir', ['-p', bin]);
  const gh = join(bin, 'gh'); writeFileSync(gh, '#!/bin/sh\necho 1\n'); chmodSync(gh, 0o755);
  const ctx = join(bin, 'cortextos');
  writeFileSync(ctx, '#!/bin/sh\nif [ "$1" = check-worktree-lease ] && [ "${LEASE_CHECK_FAIL:-0}" = 1 ]; then exit 42; fi\nprintf \'[{"name":"fixture","running":false}]\\n\'\n');
  chmodSync(ctx, 0o755);
  const cwd = join(bin, 'cwd'); writeFileSync(cwd, '#!/bin/sh\nexit "${CWD_EXIT:-1}"\n'); chmodSync(cwd, 0o755);
  const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const env = {
    ...process.env,
    CTX_FRAMEWORK_ROOT: root,
    CTX_ROOT: state,
    CTX_AGENT_NAME: 'fixture',
    WORKTREE_REAPER_GH_BIN: gh,
    WORKTREE_REAPER_CORTEXTOS_BIN: ctx,
    WORKTREE_REAPER_ACTIVE_CWD_BIN: cwd,
    CTX_WORKTREE_LEASE_TOKEN: 'token',
    CTX_WORKTREE_LEASE_REQUEST_ID: 'request',
    CTX_WORKTREE_LEASE_SCOPE: `repo:${common}`,
  };
  const add = (name: string) => {
    const path = join(root, `fixture-${name}`);
    execFileSync('git', ['-C', root, 'worktree', 'add', '-qb', `fixture/${name}`, path]);
    execFileSync('git', ['-C', path, 'config', `branch.fixture/${name}.remote`, '.']);
    execFileSync('git', ['-C', path, 'config', `branch.fixture/${name}.merge`, `refs/heads/${branch}`]);
    return realpathSync(path);
  };
  return { root, bin, env, add };
}

const script = resolve('scripts/worktree/reap-agent-worktrees.sh');

export async function runPr267ReaperScenario(scenario: Pr267ReaperScenarioName) {
  const f = fixture();
  if (scenario === 'census-to-prune-race-refuses') {
    const tree = f.add('missing-window'); renameSync(tree, `${tree}.gone`);
    const changed = join(f.bin, 'changed-census');
    writeFileSync(changed, '#!/bin/sh\ngit -C "$CTX_FRAMEWORK_ROOT" worktree list --porcelain\nprintf "worktree /injected-between-censuses\\nbranch refs/heads/other/new\\n\\n"\n');
    chmodSync(changed, 0o755);
    const run = spawnSync(script, ['--delete'], { env: { ...f.env, WORKTREE_REAPER_SECOND_WORKTREE_LIST_BIN: changed }, encoding: 'utf8' });
    invariant(run.stdout.includes('inventory-changed-before-prune') && !run.stdout.includes('PRUNE owner=fixture registrations='), 'second census did not fence prune');
  } else if (scenario === 'post-prune-census-failure-freezes-counts') {
    const tree = f.add('missing-post'); renameSync(tree, `${tree}.gone`);
    const fail = join(f.bin, 'fail'); writeFileSync(fail, '#!/bin/sh\nexit 2\n'); chmodSync(fail, 0o755);
    const run = spawnSync(script, ['--delete'], { env: { ...f.env, WORKTREE_REAPER_POST_PRUNE_WORKTREE_LIST_BIN: fail }, encoding: 'utf8' });
    invariant(run.status !== 0 && run.stdout.includes('summary reaped=0 pruned=0 failures=1'), 'post-prune failure changed accounting');
  } else if (scenario === 'writer-fence-covers-shipped-writers') {
    const tree = f.add('held');
    const run = spawnSync(script, ['--delete'], { env: { ...f.env, LEASE_CHECK_FAIL: '1' }, encoding: 'utf8' });
    invariant(run.status !== 0 && run.stderr.includes('repository lease is not live') && realpathSync(tree) === tree, 'protected shell escaped repository lease');
  } else if (scenario === 'dry-run-discriminates-without-delete') {
    const safe = f.add('safe');
    const unsafe = f.add('unsafe'); writeFileSync(join(unsafe, 'precious.txt'), 'x');
    const run = spawnSync(script, [], { env: f.env, encoding: 'utf8' });
    invariant(run.stdout.includes(`WOULD-REAP path=${safe}`) && run.stdout.includes(`REFUSE path=${unsafe}`), 'dry run did not discriminate');
  } else {
    const unsafe = f.add('unknown');
    const run = spawnSync(script, ['--delete'], { env: { ...f.env, CWD_EXIT: '42' }, encoding: 'utf8' });
    invariant(run.stdout.includes(`REFUSE path=${unsafe}`) && run.stdout.includes('process-cwd-unknown'), 'unknown gate failed open');
  }
  return { scenario, observed: true as const };
}
