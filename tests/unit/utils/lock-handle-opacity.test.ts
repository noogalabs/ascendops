import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import ts from 'typescript';

describe('LockHandle compile-time opacity', () => {
  it('does not expose filesystem generation identity to importing callers', () => {
    const root = process.cwd();
    const fixture = join(root, 'tests/fixtures/lock-handle-opacity-consumer.ts');
    const configPath = join(root, 'tsconfig.json');
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(loaded.error).toBeUndefined();

    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, {
      noEmit: true,
      rootDir: undefined,
    }, configPath);
    const program = ts.createProgram([fixture], parsed.options);
    const diagnostics = ts.getPreEmitDiagnostics(program)
      .filter(diagnostic => diagnostic.file?.fileName === fixture);

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      2339,
      2339,
      2339,
      2339,
    ]);
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      '\n',
    ))).toEqual([
      expect.stringContaining("Property 'lockDir' does not exist on type 'GenerationLockHandle'"),
      expect.stringContaining("Property 'generation' does not exist on type 'GenerationLockHandle'"),
      expect.stringContaining("Property 'generation' does not exist on type 'GenerationLockHandle'"),
      expect.stringContaining("Property 'generation' does not exist on type 'GenerationLockHandle'"),
    ]);
  });
});
