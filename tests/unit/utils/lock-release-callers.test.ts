import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

describe('generation-bound release caller roster', () => {
  it('keeps every production release call bound to its acquired handle', () => {
    const root = process.cwd();
    const calls: string[] = [];

    for (const path of sourceFiles(join(root, 'src'))) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf-8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );

      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node)
          && ts.isIdentifier(node.expression)
          && node.expression.text === 'releaseLock'
        ) {
          calls.push(`${relative(root, path)}:${node.arguments.map(arg => arg.getText(source)).join(',')}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(calls.sort()).toEqual([
      'src/bus/message.ts:lockHandle',
      'src/utils/lock.ts:handle',
    ]);
  });
});
