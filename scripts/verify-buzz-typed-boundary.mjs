#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(process.argv[2] || process.cwd());
const manifest = execFileSync('git', ['ls-files', 'src', 'bus'], {
  cwd: root,
  encoding: 'utf8',
}).split('\n').filter(Boolean);

const manifestSet = new Set(manifest);
const sourceByFile = new Map(manifest.map((file) => [file, readFileSync(resolve(root, file), 'utf8')]));

function resolveTrackedImport(importer, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const raw = posix.normalize(posix.join(dirname(importer), specifier));
  const candidates = [
    raw,
    raw.replace(/\.js$/, '.ts'),
    raw.replace(/\.mjs$/, '.mts'),
    `${raw}.ts`,
    `${raw}.js`,
    posix.join(raw, 'index.ts'),
    posix.join(raw, 'index.js'),
  ];
  return candidates.find((candidate) => manifestSet.has(candidate));
}

function trackedDependencies(file, source) {
  const dependencies = new Set();
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

  function addSpecifier(node) {
    if (!node || !ts.isStringLiteralLike(node)) return;
    const dependency = resolveTrackedImport(file, node.text);
    if (dependency) dependencies.add(dependency);
  }

  function addImportTypeArgument(node) {
    if (!node) return;
    if (ts.isLiteralTypeNode(node)) addSpecifier(node.literal);
  }

  function addCallSpecifier(node, kind) {
    const specifier = node.arguments[0];
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      throw new Error(
        `Buzz typed-boundary census found unresolvable-dynamic-import in ${file}: ${kind} first argument must be a string literal`,
      );
    }
    addSpecifier(specifier);
  }

  function visit(node) {
    // Closed TypeScript module-reference grammar handled here:
    // ImportDeclaration, ExportDeclaration-with-moduleSpecifier,
    // dynamic import() CallExpression, require() CallExpression,
    // ImportEqualsDeclaration/ExternalModuleReference, and ImportTypeNode.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      addSpecifier(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      addImportTypeArgument(node.argument);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      // The first argument is the module specifier. Dynamic import permits
      // trailing import-options/attributes, and require-like calls may also be
      // wrapped with extra arguments; neither changes the dependency edge.
      if (isDynamicImport) addCallSpecifier(node, 'import()');
      if (isRequire) addCallSpecifier(node, 'require()');
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return dependencies;
}

const dependencies = new Map(
  [...sourceByFile].map(([file, source]) => [file, trackedDependencies(file, source)]),
);

// Start at the closed Buzz implementation and shell entrypoint, then walk the
// reverse import graph to a fixed point. An indirect consumer through any
// number of barrels joins the population even when it never spells "buzz".
const populationSet = new Set(manifest.filter(
  (file) => file.startsWith('src/buzz/') || file === 'bus/send-buzz.sh',
));
let changed = true;
while (changed) {
  changed = false;
  for (const [importer, importedFiles] of dependencies) {
    if (populationSet.has(importer)) continue;
    if ([...importedFiles].some((dependency) => populationSet.has(dependency))) {
      populationSet.add(importer);
      changed = true;
    }
  }
}
const population = manifest.filter((file) => populationSet.has(file));

if (population.length === 0) {
  throw new Error('Buzz typed-boundary census refused: discovered population is empty');
}

const forbidden = /queueBuzzMessage|\binjectMessage\s*\(|\binjectAgent\s*\(|\bpty\s*\.\s*write\s*\(/;
const violations = [];
for (const file of population) {
  const source = sourceByFile.get(file);
  // AgentManager owns unrelated injection paths. The Buzz registration method
  // is the only reachable manager slice and is therefore the exact subject.
  let subject = source;
  if (file === 'src/daemon/agent-manager.ts') {
    const start = source.indexOf('private async maybeRegisterBuzzAgent');
    const end = source.indexOf('private async maybeStartActivityChannelPoller');
    if (start < 0 || end < 0 || end <= start) {
      throw new Error(
        `Buzz typed-boundary census refused: agent-manager Buzz subject anchors missing or out of order in ${file}`,
      );
    }
    subject = source.slice(start, end);
  }
  if (forbidden.test(subject)) violations.push(file);
}

if (violations.length > 0) {
  throw new Error(`Buzz typed-boundary census found direct sink reachability: ${violations.join(', ')}`);
}

console.log(`Buzz typed-boundary census OK: tracked=${manifest.length} population=${population.length}`);
