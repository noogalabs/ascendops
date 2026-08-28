import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';

const ROOT = join(import.meta.dirname, '../../..');
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function ownerName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isMethodDeclaration(current) && current.name) {
      const cls = current.parent;
      const className = ts.isClassDeclaration(cls) && cls.name ? cls.name.text : '<anonymous-class>';
      return `${className}.${current.name.getText()}`;
    }
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    current = current.parent;
  }
  return '<module>';
}

function clearCallSites(): string[] {
  const sites: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'clearSessionNonce'
      ) {
        sites.push(`${relative(ROOT, file)}:${ownerName(node)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites.sort();
}

describe('clearSessionNonce call-site population census (enumeration only; asserts no guarding)', () => {
  it('equals the consequence-reviewed file:function set', () => {
    expect(clearCallSites()).toEqual([
      'src/daemon/agent-process.ts:AgentProcess.clearOwnedSessionRecord',
      'src/daemon/worker-process.ts:WorkerProcess.clearOwnedSessionRecord',
      'src/pty/codex-app-server-pty.ts:CodexAppServerPTY.clearMintedSessionNonce',
    ]);
  });
});
