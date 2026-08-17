#!/usr/bin/env node

/**
 * Protect the deployed checkout from build/dev commands that would replace its
 * shared dist output with something that drops shipped code. The guard keys on
 * live-tree identity, not branch name, so isolated feature clones stay buildable.
 *
 * On the live tree, `main` is allowed ONLY when it contains origin/main. The old
 * blanket main exemption was correct when written — main was safe because main
 * was what shipped — and became false when local main diverged. See decide().
 *
 * KNOWN OPEN HOLES. This is a gate on the common path, not complete coverage;
 * do not mistake it for the latter.
 *   1. CLOSED 2026-08-07. Direct `npx tsup` used to bypass lifecycle hooks
 *      entirely, so the guard never ran. It was documented here and still bit:
 *      tests/unit/build-output.test.ts shells out to tsup, so an ordinary test
 *      run rebuilt the live tree with the guard never consulted. A recorded hole
 *      is not a closed one. tsup.config.ts now invokes this guard itself, so
 *      every build of the live tree is gated regardless of who starts it.
 *   2. Live detection fails OPEN: if every detector errors, `live` is false and
 *      the checkout is treated as isolated, which allows the build. Recorded
 *      here rather than fixed, because changing it needs its own review.
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

export function getRepoRoot() {
  return realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf-8', ...options });
}

function resultError(label, result, allowedAbsenceStatuses = new Set()) {
  if (result.error) return `${label}: ${result.error.message}`;
  if (result.status !== 0 && !allowedAbsenceStatuses.has(result.status)) {
    return `${label}: exited ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ''}`;
  }
  return null;
}

function containedBy(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function detectLiveTree(repoRoot) {
  const root = realpathSync(repoRoot);
  const signals = [];
  const errors = [];

  try {
    const packageName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).name;
    const result = run('npm', ['root', '-g'], { shell: process.platform === 'win32' });
    const error = resultError('D1 global-package identity', result);
    if (error) errors.push(error);
    else if (result.status === 0 && packageName) {
      const globalPackage = join(result.stdout.trim(), packageName);
      if (existsSync(globalPackage) && realpathSync(globalPackage) === root) {
        signals.push('D1 global-package identity');
      }
    }
  } catch (error) {
    errors.push(`D1 global-package identity: ${error}`);
  }

  try {
    const result = process.platform === 'win32'
      ? run('where', ['cortextos'])
      : run('/bin/sh', ['-c', 'command -v cortextos']);
    const error = resultError('D2 global-bin containment', result, new Set([1, 126, 127]));
    if (error) errors.push(error);
    else if (result.status === 0) {
      const commandPath = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (commandPath && containedBy(realpathSync(commandPath), root)) {
        signals.push('D2 global-bin containment');
      }
    }
  } catch (error) {
    errors.push(`D2 global-bin containment: ${error}`);
  }

  try {
    if (existsSync(join(root, '.cortextos-live-tree'))) {
      signals.push('D3 explicit marker');
    }
  } catch (error) {
    errors.push(`D3 explicit marker: ${error}`);
  }

  return { live: signals.length > 0, signals, errors };
}

export function decide({ ci, live, branch, override, mainDivergence }) {
  if (ci) {
    return { allow: true, code: 'ci', messages: ['CI environment detected; build allowed.'] };
  }
  if (!live) {
    return { allow: true, code: 'isolated', messages: ['Build allowed in isolated checkout.'] };
  }
  if (branch === 'main') {
    // The old blanket main exemption was correct when written and became false
    // when the world moved under it: main was safe because main was what shipped.
    // On 2026-08-07 local main had diverged from origin/main and no longer
    // contained 7f1531fe (the v1 cron routing), while dist/ still ran it. This
    // guard detected the live tree, then printed "Build allowed in live main
    // checkout" for a build that would have silently un-shipped a live feature.
    //
    // A guard that green-lights the exact case it exists to catch is worse than
    // no guard: everyone downstream reasonably assumes the gate held.
    // Work out whether main is safe to build, THEN apply the override once, so the
    // override the messages advertise is the override the code actually honours.
    let mainBlock = null;
    if (mainDivergence?.determinable === false) {
      // Fail CLOSED. An undeterminable ancestry is unknown, and unknown must not
      // read as fine — that is the absence-versus-evidence failure this repo has
      // hit repeatedly. Better annoying offline than silently absent.
      mainBlock = {
        code: 'live-main-undeterminable',
        messages: [
          'BLOCKED: cannot determine whether live main contains origin/main.',
          `Reason: ${mainDivergence.reason ?? 'unknown'}`,
          'The guard fails closed here on purpose: an unknown answer is not a safe answer.',
        ],
      };
    } else if (mainDivergence?.behind > 0) {
      mainBlock = {
        code: 'live-main-diverged',
        messages: [
          `BLOCKED: live main is missing ${mainDivergence.behind} commit(s) from origin/main.`,
          'Building now would deploy a daemon without them, with no error and no failing test.',
          'Fix: merge or rebase origin/main into this checkout, then build.',
        ],
      };
    }

    if (!mainBlock) {
      return { allow: true, code: 'live-main', messages: ['Build allowed in live main checkout.'] };
    }
    if (override) {
      return {
        allow: true,
        code: `${mainBlock.code}-override`,
        messages: [
          `WARNING: DANGER override accepted despite ${mainBlock.code}.`,
          ...mainBlock.messages,
        ],
      };
    }
    return {
      allow: false,
      code: mainBlock.code,
      messages: [
        ...mainBlock.messages,
        'DANGER override, only with explicit authorization: ALLOW_FEATURE_BUILD=1 npm run build',
      ],
    };
  }
  if (override) {
    return {
      allow: true,
      code: 'live-feature-override',
      messages: [`WARNING: DANGER override accepted for live checkout branch ${branch}.`],
    };
  }
  return {
    allow: false,
    code: 'live-feature-blocked',
    messages: [
      `BLOCKED: refusing to build the live checkout from branch ${branch}; switch to main or use an isolated clone.`,
      'For a compile-only check run: npx tsc --noEmit',
      'DANGER override, only with explicit authorization: ALLOW_FEATURE_BUILD=1 npm run build',
    ],
  };
}

function currentBranch(repoRoot, errors) {
  const result = run('git', ['-C', repoRoot, 'branch', '--show-current']);
  const error = resultError('branch detection', result);
  if (error) errors.push(error);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : 'detached';
}

/**
 * How many commits of origin/main are missing from HEAD.
 *
 * Deliberately does NOT fetch: a guard that reaches the network on every build
 * is slow and fails in ways unrelated to the thing it guards. It reads the local
 * ref, so a stale origin/main can under-report. Under-reporting is acceptable
 * here because the alternative — no check at all — is what let a diverged main
 * ship. A missing ref is reported as UNDETERMINABLE rather than as zero, so the
 * absent case never masquerades as the safe case.
 */
export function computeMainDivergence(repoRoot, ref = 'origin/main') {
  const verify = run('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (verify.error || verify.status !== 0) {
    return { determinable: false, reason: `${ref} not present locally (never fetched?)` };
  }
  const counts = run('git', ['-C', repoRoot, 'rev-list', '--left-right', '--count', `HEAD...${ref}`]);
  if (counts.error || counts.status !== 0) {
    return { determinable: false, reason: `rev-list failed: ${(counts.stderr || '').trim()}` };
  }
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return { determinable: false, reason: `unparseable rev-list output: ${counts.stdout.trim()}` };
  }
  return { determinable: true, ahead, behind, ref };
}

/** Directory that IS the deployed artifact when this tree is the live one. */
export const LIVE_DIST_DIR = 'dist';

/**
 * Does a build into this out dir produce the artifact that gets deployed?
 *
 * This is the property the guard actually cares about. Keying on the caller
 * ("was it npm run build") was the mechanism, and the mechanism had a gap wide
 * enough for a unit test to walk through. Keying on the destination has no
 * equivalent gap: anything writing the live dist is gated, and a build to a
 * scratch directory is genuinely not about to be deployed, so exempting it
 * removes no protection.
 *
 * Fails CLOSED in both unknown cases — no out dir given, or a path that will not
 * resolve — because "I could not tell" must never read as "not the live one".
 */
export function guardRequiredForOutDir(outDir, repoRoot) {
  if (typeof outDir !== 'string' || outDir === '') return true;
  try {
    return resolve(outDir) === resolve(repoRoot, LIVE_DIST_DIR);
  } catch {
    return true;
  }
}

/** `--out-dir <path>`, absent when the caller did not say. */
export function parseOutDir(argv) {
  const i = argv.indexOf('--out-dir');
  return i === -1 ? undefined : argv[i + 1];
}

export function main(argv = process.argv.slice(2)) {
  const repoRoot = getRepoRoot();

  // Destination check first: a scratch build never needs the rest of the work,
  // and skipping it keeps the test suite independent of this tree's git state.
  const outDir = parseOutDir(argv);
  if (outDir !== undefined && !guardRequiredForOutDir(outDir, repoRoot)) {
    // Announced rather than silent. An exemption nobody can see is how a gate
    // rots into one that never fires.
    console.log(`[prebuild-guard] decision=EXEMPT_NON_LIVE_OUTDIR outDir=${outDir}`);
    console.log('[prebuild-guard] this build does not write the deployed artifact, so it is not gated');
    return 0;
  }

  const detection = detectLiveTree(repoRoot);
  const branch = currentBranch(repoRoot, detection.errors);
  // Only computed for the case it gates, so isolated clones pay nothing for it.
  const mainDivergence =
    detection.live && branch === 'main' ? computeMainDivergence(repoRoot) : null;
  const decision = decide({
    ci: process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true',
    live: detection.live,
    branch,
    override: process.env.ALLOW_FEATURE_BUILD === '1',
    mainDivergence,
  });
  const lines = [
    `[prebuild-guard] decision=${decision.code} branch=${branch}`,
    `[prebuild-guard] live detectors: ${detection.signals.length ? detection.signals.join(', ') : 'none'}`,
    `[prebuild-guard] detector errors: ${detection.errors.length ? detection.errors.join(' | ') : 'none'}`,
    `[prebuild-guard] main divergence: ${
      mainDivergence
        ? mainDivergence.determinable
          ? `ahead ${mainDivergence.ahead}, behind ${mainDivergence.behind} vs ${mainDivergence.ref}`
          : `UNDETERMINABLE (${mainDivergence.reason})`
        : 'not applicable'
    }`,
    ...decision.messages.map((message) => `[prebuild-guard] ${message}`),
  ];
  const print = decision.allow ? console.log : console.error;
  for (const line of lines) print(line);
  return decision.allow ? 0 : 1;
}

export function isDirectRun(argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argvPath);
  } catch {
    return import.meta.url === pathToFileURL(argvPath).href;
  }
}

if (isDirectRun()) {
  process.exitCode = main();
}
