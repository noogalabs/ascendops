#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion', 'population', 'expectedPopulation', 'root', 'discovery',
  'layouts', 'subjects', 'bindings',
]);
const SUBJECT_KEYS = new Set(['id', 'layout', 'tracked_root', 'enabled']);
const LAYOUT_KEYS = new Set(['skillHome']);
const DISCOVERY_KEYS = new Set(['kind', 'marker']);
const BINDING_KEYS = new Set(['layouts', 'requiredPath', 'canonical', 'pointerReference', 'representation', 'subjects']);
const REPRESENTATIONS = new Set(['regular', 'symlink', 'pointer']);
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

function ownObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has undeclared field: ${key}`);
  }
}

function validateRelativePath(value, label) {
  if (typeof value !== 'string' || value === '' || isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => part === '' || part === '.' || part === '..' || /[*?\[\]{}()]/.test(part))) {
    throw new Error(`${label} contains an unsafe path segment: ${value}`);
  }
  return value;
}

function under(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveInside(root, value, label) {
  validateRelativePath(value, label);
  const path = resolve(root, value);
  if (!under(root, path)) throw new Error(`${label} escapes root: ${value}`);
  return path;
}

function selectPopulation(parsed, name) {
  const candidates = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.populations)
      ? parsed.populations
      : [parsed];
  if (!name && candidates.length === 1) return candidates[0];
  const selected = candidates.find((candidate) => candidate?.population === name);
  if (!selected) throw new Error(`Population not found in registry: ${name || '(missing --population)'}`);
  return selected;
}

export function loadPopulation(registryPath, populationName) {
  const requestedRegistry = resolve(registryPath);
  const registryStat = lstatSync(requestedRegistry, { throwIfNoEntry: false });
  if (!registryStat?.isFile() || registryStat.isSymbolicLink()) {
    throw new Error(`Registry must be a regular, non-symlink file: ${requestedRegistry}`);
  }
  const registryAbs = realpathSync(requestedRegistry);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(registryAbs, 'utf8'));
  } catch (error) {
    throw new Error(`Malformed registry ${registryAbs}: ${error.message}`);
  }
  const population = selectPopulation(parsed, populationName);
  validatePopulation(population);
  return { registryAbs, population };
}

export function validatePopulation(population) {
  if (!ownObject(population)) throw new Error('Population must be an object');
  assertKeys(population, TOP_LEVEL_KEYS, 'population');
  if (population.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  if (typeof population.population !== 'string' || !population.population.includes('.')) {
    throw new Error('population must be a stable dotted name');
  }
  if (!Number.isSafeInteger(population.expectedPopulation) || population.expectedPopulation < 1) {
    throw new Error('expectedPopulation must be a positive integer');
  }
  validateRelativePath(population.root, 'root');
  if (!ownObject(population.discovery)) throw new Error('discovery must be an object');
  assertKeys(population.discovery, DISCOVERY_KEYS, 'discovery');
  if (population.discovery.kind !== 'direct-children') throw new Error('discovery.kind must be direct-children');
  validateRelativePath(population.discovery.marker, 'discovery.marker');
  if (!ownObject(population.layouts) || Object.keys(population.layouts).length === 0) {
    throw new Error('layouts must be a non-empty object');
  }
  for (const [name, layout] of Object.entries(population.layouts)) {
    if (!ID_RE.test(name) || !ownObject(layout)) throw new Error(`Invalid layout: ${name}`);
    assertKeys(layout, LAYOUT_KEYS, `layout ${name}`);
    validateRelativePath(layout.skillHome, `layout ${name}.skillHome`);
  }
  if (!Array.isArray(population.subjects)) throw new Error('subjects must be an array');
  const ids = new Set();
  const folded = new Set();
  for (const [index, subject] of population.subjects.entries()) {
    if (!ownObject(subject)) throw new Error(`subject ${index} must be an object`);
    assertKeys(subject, SUBJECT_KEYS, `subject ${index}`);
    if (typeof subject.id !== 'string') throw new Error(`subject ${index} has invalid id`);
    const fold = subject.id.toLocaleLowerCase('en-US');
    if (ids.has(subject.id)) throw new Error(`duplicate subject id: ${subject.id}`);
    if (folded.has(fold)) throw new Error(`case collision in subject id: ${subject.id}`);
    if (!ID_RE.test(subject.id)) throw new Error(`subject ${index} has invalid id`);
    ids.add(subject.id);
    folded.add(fold);
    if (!population.layouts[subject.layout]) throw new Error(`subject ${subject.id} has unknown layout: ${subject.layout}`);
    if (typeof subject.tracked_root !== 'boolean') throw new Error(`subject ${subject.id} missing mandatory tracked_root boolean`);
    if ('enabled' in subject && typeof subject.enabled !== 'boolean') throw new Error(`subject ${subject.id} enabled must be boolean`);
  }
  if (population.bindings !== undefined) {
    if (!ownObject(population.bindings)) throw new Error('bindings must be an object');
    for (const [skill, binding] of Object.entries(population.bindings)) {
      if (!ID_RE.test(skill) || !ownObject(binding)) throw new Error(`Invalid binding: ${skill}`);
      assertKeys(binding, BINDING_KEYS, `binding ${skill}`);
      if (binding.layouts && (!Array.isArray(binding.layouts) || binding.layouts.some((x) => !population.layouts[x]))) {
        throw new Error(`binding ${skill} has unknown layout`);
      }
      if (binding.requiredPath) validateRelativePath(binding.requiredPath, `binding ${skill}.requiredPath`);
      if (binding.canonical) validateRelativePath(binding.canonical, `binding ${skill}.canonical`);
      if (binding.representation && !REPRESENTATIONS.has(binding.representation)) throw new Error(`binding ${skill} has invalid representation`);
      if (binding.pointerReference !== undefined &&
          (binding.representation !== 'pointer' || typeof binding.pointerReference !== 'string' ||
           binding.pointerReference.length === 0 || binding.pointerReference.includes('\n'))) {
        throw new Error(`binding ${skill}.pointerReference requires pointer representation and one nonempty line`);
      }
      if (binding.subjects) {
        if (!ownObject(binding.subjects)) throw new Error(`binding ${skill}.subjects must be an object`);
        for (const [id, override] of Object.entries(binding.subjects)) {
          if (!ids.has(id) || !ownObject(override)) throw new Error(`binding ${skill} has unknown subject: ${id}`);
          assertKeys(override, new Set(['requiredPath', 'canonical', 'pointerReference', 'representation']), `binding ${skill}.${id}`);
          if (override.requiredPath) validateRelativePath(override.requiredPath, `binding ${skill}.${id}.requiredPath`);
          if (override.canonical) validateRelativePath(override.canonical, `binding ${skill}.${id}.canonical`);
          if (override.representation && !REPRESENTATIONS.has(override.representation)) throw new Error(`binding ${skill}.${id} has invalid representation`);
          const effectiveRepresentation = override.representation || binding.representation;
          if (override.pointerReference !== undefined &&
              (effectiveRepresentation !== 'pointer' || typeof override.pointerReference !== 'string' ||
               override.pointerReference.length === 0 || override.pointerReference.includes('\n'))) {
            throw new Error(`binding ${skill}.${id}.pointerReference requires pointer representation and one nonempty line`);
          }
        }
      }
    }
  }
  return population;
}

function gitValue(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'UNKNOWN';
  }
}

function listObserved(rootAbs, marker) {
  let entries;
  try {
    entries = readdirSync(rootAbs, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Unreadable observed root ${rootAbs}: ${error.message}`);
  }
  const observed = [];
  const invalidRoots = [];
  const folded = new Set();
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      const fold = entry.name.toLocaleLowerCase('en-US');
      if (folded.has(fold)) throw new Error(`Case ambiguity in observed population: ${entry.name}`);
      folded.add(fold);
      observed.push(entry.name);
      invalidRoots.push(entry.name);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const markerPath = join(rootAbs, entry.name, marker);
    const stat = lstatSync(markerPath, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Marker must be a regular file: ${markerPath}`);
    const fold = entry.name.toLocaleLowerCase('en-US');
    if (folded.has(fold)) throw new Error(`Case ambiguity in observed population: ${entry.name}`);
    folded.add(fold);
    observed.push(entry.name);
  }
  return { observed: observed.sort(), invalidRoots: invalidRoots.sort() };
}

function addError(errors, name, values = []) {
  if (values.length) errors.push(`${name}=${values.join(',')}`);
}

export function reconcilePopulation({ population, registryAbs, root, materialization = 'tracked' }) {
  if (!['tracked', 'all'].includes(materialization)) {
    throw new Error(`Unknown materialization mode: ${materialization}`);
  }
  const rootAbs = realpathSync(resolve(root));
  if (!under(rootAbs, registryAbs)) throw new Error(`Registry is outside canonical --root: ${registryAbs}`);
  const subjectRoot = resolveInside(rootAbs, population.root, 'root');
  const subjectRootStat = lstatSync(subjectRoot, { throwIfNoEntry: false });
  if (!subjectRootStat?.isDirectory() || subjectRootStat.isSymbolicLink()) {
    throw new Error(`Population root must be a regular, non-symlink directory: ${subjectRoot}`);
  }
  const observation = listObserved(subjectRoot, population.discovery.marker);
  const observed = observation.observed;
  const registryIds = population.subjects.map((subject) => subject.id).sort();
  const tracked = population.subjects.filter((subject) => subject.tracked_root).map((subject) => subject.id).sort();
  const declaredUntracked = population.subjects.filter((subject) => !subject.tracked_root).map((subject) => subject.id).sort();
  const errors = [];
  addError(errors, 'INVALID_SYMLINK_SUBJECT_ROOT', observation.invalidRoots);
  if (population.expectedPopulation !== registryIds.length) errors.push('REGISTRY_COUNT_MISMATCH');
  const required = materialization === 'all' ? registryIds : tracked;
  addError(errors, 'MISSING', required.filter((id) => !observed.includes(id)));
  addError(errors, 'EXTRA', observed.filter((id) => !registryIds.includes(id)));
  if (materialization === 'tracked') {
    addError(errors, 'DECLARED_UNTRACKED_PRESENT', declaredUntracked.filter((id) => observed.includes(id)));
  }

  const subjectRoots = new Map();
  const realRoots = new Map();
  for (const subject of population.subjects.filter((item) => required.includes(item.id) && observed.includes(item.id))) {
    const path = join(subjectRoot, subject.id);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      errors.push(`INVALID_SUBJECT_ROOT=${subject.id}`);
      continue;
    }
    const real = realpathSync(path);
    if (!under(subjectRoot, real)) errors.push(`OUT_OF_ROOT=${subject.id}`);
    if (realRoots.has(real)) errors.push(`ALIASED_SUBJECT_ROOTS=${realRoots.get(real)},${subject.id}`);
    realRoots.set(real, subject.id);
    subjectRoots.set(subject.id, path);
  }
  return {
    ok: errors.length === 0,
    errors,
    registryAbs,
    rootAbs,
    subjectRoot,
    population: population.population,
    materialization,
    expectedPopulation: population.expectedPopulation,
    registryEnumeratedPopulation: registryIds.length,
    registrySubjects: registryIds,
    observedPopulation: observed.length,
    observedSubjects: observed,
    trackedExpected: tracked.length,
    trackedObserved: tracked.filter((id) => observed.includes(id)).length,
    declaredUntrackedExpected: declaredUntracked.length,
    declaredUntrackedAbsent: declaredUntracked.filter((id) => !observed.includes(id)).length,
    subjectRoots,
    repositoryTopLevel: gitValue(rootAbs, ['rev-parse', '--show-toplevel']),
    repositoryHead: gitValue(rootAbs, ['rev-parse', 'HEAD']),
  };
}

function effectiveBinding(population, skill, subject) {
  const binding = population.bindings?.[skill] || {};
  return { ...binding, ...(binding.subjects?.[subject.id] || {}) };
}

function checkRepresentation({ target, canonical, pointerReference, representation, rootAbs, id, errors }) {
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (!stat) {
    errors.push(`MISSING_REQUIRED_PATH=${id}`);
    return;
  }
  if (representation === 'symlink') {
    if (!stat.isSymbolicLink()) {
      errors.push(`REPRESENTATION_MISMATCH=${id}:expected-symlink`);
      return;
    }
    if (isAbsolute(readlinkSync(target))) {
      errors.push(`ABSOLUTE_SYMLINK=${id}`);
      return;
    }
    let real;
    try { real = realpathSync(target); } catch { errors.push(`BROKEN_SYMLINK=${id}`); return; }
    if (!under(rootAbs, real)) errors.push(`OUT_OF_ROOT=${id}`);
    if (!canonical || !existsSync(canonical)) {
      errors.push(`MISSING_CANONICAL=${id}`);
    } else if (real !== realpathSync(canonical)) {
      errors.push(`WRONG_SYMLINK_TARGET=${id}`);
    }
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    errors.push(`REPRESENTATION_MISMATCH=${id}:expected-${representation || 'regular'}`);
    return;
  }
  if (canonical && !existsSync(canonical)) errors.push(`MISSING_CANONICAL=${id}`);
  if (representation === 'pointer') {
    const pointerFile = join(target, 'SKILL.md');
    const pointerStat = lstatSync(pointerFile, { throwIfNoEntry: false });
    if (!pointerStat?.isFile() || pointerStat.isSymbolicLink()) {
      errors.push(`INVALID_POINTER_FILE=${id}`);
      return;
    }
    if (!pointerReference) {
      errors.push(`MISSING_POINTER_REFERENCE_CONTRACT=${id}`);
      return;
    }
    const occurrences = readFileSync(pointerFile, 'utf8').split(pointerReference).length - 1;
    if (occurrences !== 1) errors.push(`POINTER_REFERENCE_MISMATCH=${id}:occurrences-${occurrences}`);
  }
}

/**
 * Resolve every declared subject's skill-home directory without requiring a
 * particular skill to exist. Runtime activation uses this complete topology to
 * measure both existing aliases and registered forks that currently lack the
 * requested skill.
 */
export function resolvePopulationSkillHomes(population, receipt) {
  const errors = [...receipt.errors];
  const homes = [];
  const realSkillHomes = new Map();
  for (const subject of population.subjects.filter((item) => item.enabled !== false)) {
    if (!receipt.subjectRoots.has(subject.id)) continue;
    const homeRel = population.layouts[subject.layout].skillHome;
    const subjectRoot = receipt.subjectRoots.get(subject.id);
    const home = resolveInside(subjectRoot, homeRel, `layout ${subject.layout}.skillHome`);
    const homeStat = lstatSync(home, { throwIfNoEntry: false });
    if (!homeStat || (!homeStat.isDirectory() && !homeStat.isSymbolicLink())) {
      errors.push(`MISSING_SKILL_HOME=${subject.id}`);
      continue;
    }
    let realHome;
    try { realHome = realpathSync(home); } catch { errors.push(`BROKEN_SKILL_HOME=${subject.id}`); continue; }
    const subjectRealRoot = realpathSync(subjectRoot);
    if (!under(subjectRealRoot, realHome)) errors.push(`SKILL_HOME_OUTSIDE_SUBJECT=${subject.id}`);
    if (realSkillHomes.has(realHome)) {
      errors.push(`ALIASED_SKILL_HOMES=${realSkillHomes.get(realHome)},${subject.id}`);
    } else {
      realSkillHomes.set(realHome, subject.id);
    }
    homes.push({
      id: subject.id,
      layout: subject.layout,
      tracked_root: subject.tracked_root,
      enabled: subject.enabled ?? null,
      path: home,
      realPath: realHome,
      subjectRoot,
    });
  }
  return { ok: errors.length === 0, errors, homes };
}

export function resolvePopulationPaths(population, receipt, skill) {
  if (!ID_RE.test(skill || '')) throw new Error(`Invalid --skill: ${skill}`);
  const errors = [...receipt.errors];
  const targets = [];
  const realSkillHomes = new Map();
  for (const subject of population.subjects.filter((item) => item.enabled !== false)) {
    if (!receipt.subjectRoots.has(subject.id)) continue;
    const binding = effectiveBinding(population, skill, subject);
    if (binding.layouts && !binding.layouts.includes(subject.layout)) continue;
    const homeRel = population.layouts[subject.layout].skillHome;
    const home = resolveInside(receipt.subjectRoots.get(subject.id), homeRel, `layout ${subject.layout}.skillHome`);
    const homeStat = lstatSync(home, { throwIfNoEntry: false });
    if (!homeStat || (!homeStat.isDirectory() && !homeStat.isSymbolicLink())) {
      errors.push(`MISSING_SKILL_HOME=${subject.id}`);
      continue;
    }
    let realHome;
    try { realHome = realpathSync(home); } catch { errors.push(`BROKEN_SKILL_HOME=${subject.id}`); continue; }
    const subjectRealRoot = realpathSync(receipt.subjectRoots.get(subject.id));
    if (!under(subjectRealRoot, realHome)) errors.push(`SKILL_HOME_OUTSIDE_SUBJECT=${subject.id}`);
    if (realSkillHomes.has(realHome)) {
      errors.push(`ALIASED_SKILL_HOMES=${realSkillHomes.get(realHome)},${subject.id}`);
    } else {
      realSkillHomes.set(realHome, subject.id);
    }
    const required = binding.requiredPath || skill;
    const target = resolveInside(home, required, `binding ${skill}.requiredPath`);
    const canonical = binding.canonical ? resolveInside(receipt.rootAbs, binding.canonical, `binding ${skill}.canonical`) : null;
    checkRepresentation({ target, canonical, pointerReference: binding.pointerReference, representation: binding.representation || 'regular', rootAbs: receipt.rootAbs, id: subject.id, errors });
    targets.push({
      id: subject.id,
      layout: subject.layout,
      tracked_root: subject.tracked_root,
      enabled: subject.enabled ?? null,
      path: target,
      relativePath: relative(receipt.rootAbs, target).split(sep).join('/'),
      representation: binding.representation || 'regular',
      canonical: canonical ? relative(receipt.rootAbs, canonical).split(sep).join('/') : null,
    });
  }
  const owned = new Set(targets.map((target) => target.path));
  const unowned = [];
  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Unreadable skill observation ${current}: ${error.message}`);
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        if (entry.name === skill && !owned.has(path)) unowned.push(relative(receipt.rootAbs, path).split(sep).join('/'));
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (entry.name === skill && existsSync(join(path, 'SKILL.md'))) {
        if (!owned.has(path)) unowned.push(relative(receipt.rootAbs, path).split(sep).join('/'));
        continue;
      }
      walk(path);
    }
  }
  for (const subject of population.subjects.filter((item) => item.enabled !== false)) {
    const subjectRoot = receipt.subjectRoots.get(subject.id);
    if (subjectRoot) walk(subjectRoot);
  }
  addError(errors, 'UNOWNED_TARGET', [...new Set(unowned)].sort());
  return { ok: errors.length === 0, errors, targets };
}

export function formatReceipt(receipt, resolvedTargets = null, errors = receipt.errors) {
  const lines = [
    `population=${receipt.population}`,
    `materialization=${receipt.materialization}`,
    `expected_population=${receipt.expectedPopulation}`,
    `registry_enumerated_population=${receipt.registryEnumeratedPopulation}`,
    `registry_subjects=${receipt.registrySubjects.join(',')}`,
    `observed_population=${receipt.observedPopulation}`,
    `observed_subjects=${receipt.observedSubjects.join(',')}`,
    `tracked_expected=${receipt.trackedExpected}`,
    `tracked_observed=${receipt.trackedObserved}`,
    `declared_untracked_expected=${receipt.declaredUntrackedExpected}`,
    `declared_untracked_absent=${receipt.declaredUntrackedAbsent}`,
    `resolved_targets=${resolvedTargets === null ? receipt.trackedObserved : resolvedTargets}`,
    `repository_top_level=${receipt.repositoryTopLevel}`,
    `repository_head=${receipt.repositoryHead}`,
  ];
  lines.push(...errors);
  if (errors.length === 0) lines.push('status=OK');
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const operation = argv.shift();
  if (!['check', 'paths'].includes(operation)) throw new Error('Usage: fleet-population.mjs check|paths --registry FILE --root DIR --population NAME [--skill NAME --format json]');
  const opts = { operation, format: 'text' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--registry') opts.registry = argv[++i];
    else if (key === '--root') opts.root = argv[++i];
    else if (key === '--population') opts.population = argv[++i];
    else if (key === '--skill') opts.skill = argv[++i];
    else if (key === '--format') opts.format = argv[++i];
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!opts.registry || !opts.root || !opts.population) throw new Error('Missing --registry, --root, or --population');
  if (operation === 'paths' && opts.format !== 'json') throw new Error('paths requires --format json');
  return opts;
}

export function runFleetPopulation(options) {
  const { registryAbs, population } = loadPopulation(options.registry, options.population);
  const receipt = reconcilePopulation({
    population,
    registryAbs,
    root: options.root,
    materialization: options.operation === 'paths' ? 'all' : 'tracked',
  });
  if (options.operation === 'paths') {
    const resolved = options.skill
      ? resolvePopulationPaths(population, receipt, options.skill)
      : {
          ok: receipt.ok,
          errors: receipt.errors,
          targets: population.subjects
            .filter((subject) => subject.enabled !== false)
            .filter((subject) => receipt.subjectRoots.has(subject.id))
            .map((subject) => ({
              id: subject.id,
              layout: subject.layout,
              tracked_root: subject.tracked_root,
              enabled: subject.enabled ?? null,
              path: receipt.subjectRoots.get(subject.id),
              relativePath: relative(receipt.rootAbs, receipt.subjectRoots.get(subject.id)).split(sep).join('/'),
            })),
        };
    return { ok: resolved.ok, output: formatReceipt(receipt, resolved.targets.length, resolved.errors), receipt, targets: resolved.targets, errors: resolved.errors };
  }
  return { ok: receipt.ok, output: formatReceipt(receipt), receipt, targets: [], errors: receipt.errors };
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = runFleetPopulation(opts);
    process.stdout.write(result.output);
    if (result.ok && opts.operation === 'paths') {
      process.stdout.write(`${JSON.stringify({ receipt: result.receipt, targets: result.targets }, (key, value) => value instanceof Map ? undefined : value)}\n`);
    }
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`fleet-population error: ${error.message}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
