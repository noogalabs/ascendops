#!/usr/bin/env node
/**
 * forge-register.mjs — two-step registration enforcement (forge hard rule 6).
 *
 * Live agent skill dirs (`<agent>/.claude/skills/`) are gitignored runtime —
 * NOT a PR target, and never the FIRST write. Registration is always two steps:
 *
 *   stage     Step 1: copy a built skill into its TRACKED home (role template
 *             or community/skills/) and run the combined load gate against
 *             that home. Output is a ready-to-PR working-tree change — this
 *             script never commits, merges, or pushes (forge hard rule 7:
 *             specs + change-sets, not auto-merges).
 *
 *   activate  Step 2 (AFTER the PR merged and the orchestrator gate approved):
 *             copy the skill from the TRACKED source into the live runtime
 *             dir, byte-identical, then print the in-context trigger-fire
 *             smoke. Refuses to run unless:
 *               --gate-approved-by <name> is passed (who held the gate), and
 *               the source path is tracked in git (so a single write to a
 *               gitignored live dir is structurally impossible here), and
 *               multi-member or symlink fanout has an exact measured
 *               acknowledgement.
 *
 * Usage:
 *   node scripts/forge-register.mjs stage   --from <built-skill-dir> --home <tracked-skills-dir>
 *   node scripts/forge-register.mjs activate --from <tracked-skill-dir> --runtime <live-skills-dir> \
 *        --gate-approved-by <name> [--registry <fleet-population.json> --root <org-root> \
 *        --population <population-name> --fanout-acknowledged <org/agent,...>]
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatReceipt,
  loadPopulation,
  reconcilePopulation,
  resolvePopulationSkillHomes,
} from './fleet-population.mjs';
import { runLoadGate } from './forge-load-gate.mjs';

function hashTree(dir) {
  const hash = createHash('sha256');
  const walk = (d, prefix = '') => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(d, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        hash.update(`D\0${rel}\0`);
        walk(abs, rel);
      }
      else if (entry.isFile()) {
        const stat = lstatSync(abs);
        hash.update(`F\0${rel}\0${stat.mode & 0o777}\0${stat.size}\0`);
        hash.update(readFileSync(abs));
      } else {
        throw new Error(`unsupported source tree entry: ${abs}`);
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      opts[key] = rest[++i];
    }
  }
  return { cmd, opts };
}

function under(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function snapshotTrackedAuthorityFile(path, label) {
  const lexical = lstatSync(path, { throwIfNoEntry: false });
  if (!lexical?.isFile() || lexical.isSymbolicLink()) {
    throw new Error(`${label} must be a lexical non-symlink regular file: ${path}`);
  }
  let gitRoot;
  try {
    gitRoot = realpathSync(execFileSync('git', ['-C', dirname(path), 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch {
    throw new Error(`${label} is not inside a Git worktree: ${path}`);
  }
  const realFile = realpathSync(path);
  if (!under(gitRoot, realFile)) {
    throw new Error(`${label} resolves outside its Git worktree: ${realFile}`);
  }
  const fileRel = relative(gitRoot, realFile);
  const status = execFileSync('git', [
    '-C', gitRoot, 'status', '--porcelain=v1', '--untracked-files=all', '--', fileRel,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (status) throw new Error(`${label} is dirty relative to HEAD/index: ${status}`);

  const stageRows = execFileSync('git', [
    '-C', gitRoot, 'ls-files', '--stage', '-z', '--', fileRel,
  ], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const stageTab = stageRows[0]?.indexOf('\t') ?? -1;
  const [indexMode, indexOid, indexStage] = stageTab >= 0
    ? stageRows[0].slice(0, stageTab).split(' ')
    : [];
  if (stageRows.length !== 1 || indexStage !== '0' || stageRows[0].slice(stageTab + 1) !== fileRel) {
    throw new Error(`${label} must have exactly one stage-0 index entry: ${fileRel}`);
  }

  const visibilityRows = execFileSync('git', [
    '-C', gitRoot, 'ls-files', '-v', '-z', '--', fileRel,
  ], { encoding: 'utf8' }).split('\0').filter(Boolean);
  if (visibilityRows.length !== 1 || visibilityRows[0] !== `H ${fileRel}`) {
    throw new Error(`${label} index contains assume-unchanged, skip-worktree, or non-normal visibility state`);
  }

  const headRows = execFileSync('git', [
    '-C', gitRoot, 'ls-tree', '-z', 'HEAD', '--', fileRel,
  ], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const headTab = headRows[0]?.indexOf('\t') ?? -1;
  const [headMode, headType, headOid] = headTab >= 0
    ? headRows[0].slice(0, headTab).split(' ')
    : [];
  if (headRows.length !== 1 || headRows[0].slice(headTab + 1) !== fileRel ||
      headType !== 'blob' || headMode !== indexMode || headOid !== indexOid) {
    throw new Error(`${label} index entry does not exactly match HEAD: ${fileRel}`);
  }

  const bytes = readFileSync(realFile);
  const indexBytes = execFileSync('git', ['-C', gitRoot, 'cat-file', 'blob', indexOid], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const worktreeMode = (lstatSync(realFile).mode & 0o111) ? '100755' : '100644';
  if (worktreeMode !== indexMode || !bytes.equals(indexBytes)) {
    throw new Error(`${label} worktree mode/content does not exactly match HEAD/index: ${fileRel}`);
  }
  const identity = lstatSync(realFile);
  return {
    gitRoot,
    realFile,
    device: identity.dev,
    inode: identity.ino,
    mode: identity.mode,
    hash: createHash('sha256').update(bytes).digest('hex'),
  };
}

function sameAuthoritySnapshot(left, right) {
  return left.gitRoot === right.gitRoot && left.realFile === right.realFile &&
    left.device === right.device && left.inode === right.inode &&
    left.mode === right.mode && left.hash === right.hash;
}

function snapshotTrackedSource(path) {
  const lexical = lstatSync(path, { throwIfNoEntry: false });
  if (!lexical?.isDirectory() || lexical.isSymbolicLink()) {
    throw new Error(`tracked source must be a lexical non-symlink directory: ${path}`);
  }
  let gitRoot;
  try {
    gitRoot = realpathSync(execFileSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch {
    throw new Error(`tracked source is not inside a Git worktree: ${path}`);
  }
  const realSource = realpathSync(path);
  if (!under(gitRoot, realSource)) {
    throw new Error(`tracked source resolves outside its Git worktree: ${realSource}`);
  }
  const sourceRel = relative(gitRoot, realSource);
  const status = execFileSync('git', [
    '-C', gitRoot, 'status', '--porcelain=v1', '--untracked-files=all', '--', sourceRel,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (status) {
    throw new Error(`tracked source is dirty relative to HEAD/index: ${status.replaceAll('\n', '; ')}`);
  }

  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) files.push(abs);
      else throw new Error(`tracked source contains an unsupported entry: ${abs}`);
    }
  };
  walk(realSource);
  if (files.length === 0) throw new Error(`tracked source is empty: ${realSource}`);

  const filesByRel = new Map(files.map((file) => [relative(gitRoot, file), file]));
  const stageRows = execFileSync('git', [
    '-C', gitRoot, 'ls-files', '--stage', '-z', '--', sourceRel,
  ], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const stageByRel = new Map();
  for (const row of stageRows) {
    const tab = row.indexOf('\t');
    const [mode, oid, stage] = row.slice(0, tab).split(' ');
    const fileRel = row.slice(tab + 1);
    if (tab < 0 || stage !== '0' || stageByRel.has(fileRel)) {
      throw new Error(`source index must contain exactly one stage-0 entry per file: ${fileRel}`);
    }
    stageByRel.set(fileRel, { mode, oid });
  }
  const indexedPaths = [...stageByRel.keys()].sort();
  const worktreePaths = [...filesByRel.keys()].sort();
  if (JSON.stringify(indexedPaths) !== JSON.stringify(worktreePaths)) {
    throw new Error('source worktree file set does not exactly match the stage-0 index');
  }

  const visibilityRows = execFileSync('git', [
    '-C', gitRoot, 'ls-files', '-v', '-z', '--', sourceRel,
  ], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const visibilityByRel = new Map(visibilityRows.map((row) => [row.slice(2), row.slice(0, 1)]));
  if (visibilityByRel.size !== worktreePaths.length ||
      worktreePaths.some((fileRel) => visibilityByRel.get(fileRel) !== 'H')) {
    throw new Error('source index contains assume-unchanged, skip-worktree, or non-normal visibility state');
  }

  for (const fileRel of worktreePaths) {
    const file = filesByRel.get(fileRel);
    const indexEntry = stageByRel.get(fileRel);
    const headRow = execFileSync('git', [
      '-C', gitRoot, 'ls-tree', '-z', 'HEAD', '--', fileRel,
    ], { encoding: 'utf8' }).split('\0').filter(Boolean);
    const tab = headRow[0]?.indexOf('\t') ?? -1;
    const [headMode, headType, headOid] = tab >= 0 ? headRow[0].slice(0, tab).split(' ') : [];
    if (headRow.length !== 1 || headType !== 'blob' ||
        headMode !== indexEntry.mode || headOid !== indexEntry.oid) {
      throw new Error(`source index entry does not exactly match HEAD: ${fileRel}`);
    }
    const worktreeMode = (lstatSync(file).mode & 0o111) ? '100755' : '100644';
    const indexBytes = execFileSync('git', ['-C', gitRoot, 'cat-file', 'blob', indexEntry.oid], {
      maxBuffer: 64 * 1024 * 1024,
    });
    if (worktreeMode !== indexEntry.mode || !readFileSync(file).equals(indexBytes)) {
      throw new Error(`source worktree mode/content does not exactly match HEAD/index: ${fileRel}`);
    }
  }
  const identity = lstatSync(realSource);
  return {
    gitRoot,
    realSource,
    device: identity.dev,
    inode: identity.ino,
    hash: hashTree(realSource),
  };
}

function looksLikeAgentRuntime(runtime) {
  const candidates = [runtime];
  try {
    candidates.push(realpathSync(runtime));
  } catch {
    // A missing lexical agent path is still classified below and refused.
  }
  return candidates.some((candidate) => candidate.split(sep).some((part, index, parts) =>
    part === 'orgs' && parts[index + 2] === 'agents' && parts.length > index + 4));
}

/**
 * Resolve the target runtime skill before writes, then reverse-enumerate the
 * tracked population registry to find every registered member whose same-named
 * skill reaches that real directory. This deliberately measures the current
 * filesystem; there is no baked-in propagation list.
 */
function measureAgentRuntimeFanout(runtime, skillName, opts) {
  const topologyArgs = [opts.registry, opts.root, opts.population];
  if (topologyArgs.every((value) => value === undefined)) {
    if (looksLikeAgentRuntime(runtime)) {
      throw new Error('agent runtime activation requires --registry, --root, and --population');
    }
    return null;
  }
  if (topologyArgs.some((value) => value === undefined)) {
    throw new Error('--registry, --root, and --population must be supplied together');
  }

  const registryBefore = snapshotTrackedAuthorityFile(resolve(opts.registry), 'population registry');
  const { registryAbs, population } = loadPopulation(opts.registry, opts.population);
  if (registryAbs !== registryBefore.realFile) {
    throw new Error('population registry identity changed before parsing');
  }
  const receipt = reconcilePopulation({
    population,
    registryAbs,
    root: opts.root,
    materialization: 'all',
  });
  const resolved = resolvePopulationSkillHomes(population, receipt);
  if (!resolved.ok) {
    throw new Error(`population topology is invalid:\n${formatReceipt(receipt, resolved.homes.length, resolved.errors).trim()}`);
  }

  let realRuntime;
  try {
    realRuntime = realpathSync(runtime);
  } catch {
    throw new Error(`runtime skills directory does not exist: ${runtime}`);
  }
  const requestedHomes = resolved.homes.filter((home) => home.realPath === realRuntime);
  if (requestedHomes.length !== 1) {
    throw new Error(`runtime must match exactly one registry-resolved skill home (matched ${requestedHomes.length}): ${runtime}`);
  }
  const target = requestedHomes[0];
  const requestedDestination = join(runtime, skillName);
  const requestedEntry = lstatSync(requestedDestination, { throwIfNoEntry: false });
  const requestedStat = statSync(requestedDestination, { throwIfNoEntry: false });
  if (requestedEntry && !requestedStat?.isDirectory()) {
    throw new Error(`runtime skill destination is not a resolvable directory: ${requestedDestination}`);
  }
  const realDestination = requestedStat?.isDirectory()
    ? realpathSync(requestedDestination)
    : join(target.realPath, skillName);
  if (!under(receipt.rootAbs, realDestination)) {
    throw new Error(`runtime skill destination escapes registry root: ${realDestination}`);
  }
  const subjects = [];
  const missed = [];
  const populationRootName = basename(receipt.rootAbs);
  for (const home of resolved.homes) {
    const subject = `${populationRootName}/${home.id}`;
    const candidate = join(home.path, skillName);
    const candidateEntry = lstatSync(candidate, { throwIfNoEntry: false });
    const candidateStat = statSync(candidate, { throwIfNoEntry: false });
    if (candidateEntry && !candidateStat?.isDirectory()) {
      throw new Error(`registered runtime skill is not a resolvable directory: ${subject}:${candidate}`);
    }
    const candidateDestination = candidateStat?.isDirectory()
      ? realpathSync(candidate)
      : join(home.realPath, skillName);
    if (!under(receipt.rootAbs, candidateDestination)) {
      throw new Error(`registered runtime skill escapes registry root: ${subject}:${candidateDestination}`);
    }
    if (candidateDestination === realDestination) subjects.push(subject);
    else missed.push(subject);
  }
  subjects.sort();
  missed.sort();
  return {
    registryBefore,
    registryPath: resolve(opts.registry),
    realDestination,
    subjects,
    missed,
    // A per-skill link aliases an existing skill; a skills-root link aliases
    // both existing and not-yet-created skills. Platform aliases above the
    // framework (for example macOS /private) are deliberately irrelevant.
    requiresAcknowledgement:
      subjects.length > 1 || requestedEntry?.isSymbolicLink() || lstatSync(runtime).isSymbolicLink(),
  };
}

function acknowledgedSubjects(value) {
  if (value === undefined) return null;
  const members = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (new Set(members).size !== members.length) return null;
  return members.sort();
}

function sameMembers(left, right) {
  return left !== null && left.length === right.length && left.every((value, index) => value === right[index]);
}

function stage(opts) {
  if (!opts.from || !opts.home) {
    console.error('stage: --from <built-skill-dir> and --home <tracked-skills-dir> are required');
    process.exit(2);
  }
  const from = resolve(opts.from);
  const home = resolve(opts.home);
  const name = basename(from);
  const dest = join(home, name);
  if (!existsSync(join(from, 'SKILL.md'))) {
    console.error(`stage: ${from} has no SKILL.md`);
    process.exit(1);
  }
  if (!existsSync(home)) {
    console.error(`stage: tracked home ${home} does not exist — register into a role template or community/skills/, never a live agent dir`);
    process.exit(1);
  }
  // The HOME itself must be tracked territory; the new skill dir inside it is new.
  const homeRepoCheck = (() => {
    try {
      execFileSync('git', ['-C', home, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  if (!homeRepoCheck) {
    console.error(`stage: ${home} is not inside a git repo — not a tracked home`);
    process.exit(1);
  }
  if (/\/agents\/[^/]+\/\.claude\/skills/.test(home)) {
    console.error(`stage: ${home} looks like a LIVE agent runtime dir — that is step 2 (activate), never the PR target (forge hard rule 6)`);
    process.exit(1);
  }
  // Clear any prior staged copy first: a bare cpSync into an existing dest
  // MERGES, so a built source that renamed/deleted a file leaves the stale file
  // behind and it becomes part of the PR (same class as the activate fix, other
  // call site). rm-then-copy makes the staged dest exactly mirror the source.
  rmSync(dest, { recursive: true, force: true });
  cpSync(from, dest, { recursive: true });
  console.log(`staged ${name} -> ${dest}`);
  // Pass the skills home itself: the gate now resolves references as the exact
  // path relative to the home (`git ls-files --error-unmatch -- <ref>/SKILL.md`
  // from <home>), so the home — not the repo root — is the correct scope. (The
  // old repo-root workaround for the unanchored `*skills/` glob over-broadened
  // to a false-green; the anchored gate makes `home` correct.)
  const gate = runLoadGate([dest], { targetHome: home });
  process.stdout.write(gate.output);
  if (!gate.ok) {
    console.error('stage: load gate FAILED — fix before opening the PR');
    process.exit(1);
  }
  console.log('next: open the PR from this working-tree change (Codex + review -> orchestrator gate). Do NOT activate until merged + gated.');
}

function activate(opts) {
  if (!opts.from || !opts.runtime) {
    console.error('activate: --from <tracked-skill-dir> and --runtime <live-skills-dir> are required');
    process.exit(2);
  }
  if (!opts.gateApprovedBy) {
    console.error('activate: REFUSED — pass --gate-approved-by <name>. Runtime activation only happens after the tracked-source PR merged and the orchestrator gate approved (forge hard rule 6).');
    process.exit(1);
  }
  const from = resolve(opts.from);
  const name = basename(from);
  let sourceBefore;
  try {
    sourceBefore = snapshotTrackedSource(from);
  } catch (err) {
    console.error(`activate: REFUSED — source identity failed: ${err.message}. Live runtime untouched.`);
    process.exit(1);
  }
  const runtime = resolve(opts.runtime);
  let impact;
  try {
    impact = measureAgentRuntimeFanout(runtime, name, opts);
  } catch (err) {
    console.error(`activate: REFUSED — cannot safely measure runtime fanout: ${err.message}. Live runtime untouched.`);
    process.exit(1);
  }
  if (impact) {
    console.log(`activation impact: write reaches (${impact.subjects.length}) ${impact.subjects.join(', ') || '(none)'}`);
    console.log(`activation impact: registered forks missed (${impact.missed.length}) ${impact.missed.join(', ') || '(none)'}`);
    console.log(`activation impact: runtime real destination ${impact.realDestination}`);
    if (impact.requiresAcknowledgement || opts.fanoutAcknowledged !== undefined) {
      const acknowledged = acknowledgedSubjects(opts.fanoutAcknowledged);
      if (!sameMembers(acknowledged, impact.subjects)) {
        const expected = impact.subjects.join(',');
        console.error(`activate: REFUSED — measured runtime fanout requires acknowledgement. Pass --fanout-acknowledged ${JSON.stringify(expected)} exactly; missing, stale, extra, or duplicate subjects are unsafe. Live runtime untouched.`);
        process.exit(1);
      }
    }
  }
  if (impact) {
    let registryAfter;
    try {
      registryAfter = snapshotTrackedAuthorityFile(impact.registryPath, 'population registry');
    } catch (err) {
      console.error(`activate: REFUSED — population registry changed during fanout measurement: ${err.message}. Live runtime untouched.`);
      process.exit(1);
    }
    if (!sameAuthoritySnapshot(impact.registryBefore, registryAfter)) {
      console.error('activate: REFUSED — population registry identity/content changed during fanout measurement. Live runtime untouched.');
      process.exit(1);
    }
  }
  const requestedDest = join(runtime, name);
  // For acknowledged aliases swap the measured real target, preserving the
  // symlink topology and making the reported subject set the actual write set.
  const dest = impact?.realDestination || requestedDest;
  // Copy into a sibling temp dir and verify byte-identity BEFORE touching the
  // live runtime path. A direct cpSync into an existing dest MERGES — files
  // removed from the tracked source linger, and the hash check would only fail
  // AFTER the live skill was already partially overwritten. Temp-then-swap keeps
  // the live dir untouched until the copy is proven clean, and the swap removes
  // any stale files (rename replaces the whole dir).
  const tmpDest = `${dest}.forge-activate-tmp`;
  rmSync(tmpDest, { recursive: true, force: true });
  cpSync(from, tmpDest, { recursive: true });
  let sourceAfter;
  try {
    sourceAfter = snapshotTrackedSource(from);
  } catch (err) {
    rmSync(tmpDest, { recursive: true, force: true });
    console.error(`activate: source changed during copy: ${err.message} — live runtime untouched`);
    process.exit(1);
  }
  if (sourceBefore.realSource !== sourceAfter.realSource ||
      sourceBefore.device !== sourceAfter.device || sourceBefore.inode !== sourceAfter.inode ||
      sourceBefore.hash !== sourceAfter.hash) {
    rmSync(tmpDest, { recursive: true, force: true });
    console.error('activate: source identity/content changed during copy — live runtime untouched');
    process.exit(1);
  }
  const srcHash = sourceBefore.hash;
  const tmpHash = hashTree(tmpDest);
  if (srcHash !== tmpHash) {
    rmSync(tmpDest, { recursive: true, force: true });
    console.error(`activate: byte-identity check FAILED (${srcHash} != ${tmpHash}) — live runtime untouched`);
    process.exit(1);
  }
  // Check passed — now swap atomically: drop the old dir, rename temp into place.
  rmSync(dest, { recursive: true, force: true });
  renameSync(tmpDest, dest);
  console.log(`activated ${name} -> ${requestedDest} (real destination ${dest}; byte-identical to tracked source, sha256 ${srcHash.slice(0, 12)}…, gate: ${opts.gateApprovedBy})`);
  // Print the fire-smoke — activation is not done until this ran in-context.
  const gate = runLoadGate([requestedDest], { lenient: true });
  process.stdout.write(gate.output);
  console.log('next: run the MANUAL fire-smoke above IN THE TARGET AGENT\'S SESSION, then send the agent a heads-up. Activation without a fired trigger is not done.');
}

function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (cmd === 'stage') stage(opts);
  else if (cmd === 'activate') activate(opts);
  else {
    console.error('Usage: forge-register.mjs <stage|activate> — see file header');
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
