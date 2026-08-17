import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = join(__dirname, '../..');

describe('published package postinstall custody', () => {
  it('ships the exact helper invoked by the postinstall lifecycle', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: { postinstall: string };
    };
    const match = pkg.scripts.postinstall.match(/^node\s+([^\s]+)$/);
    expect(match, 'postinstall must name one auditable package-relative helper').not.toBeNull();

    const packed = JSON.parse(execFileSync('npm', [
      'pack', '--dry-run', '--json', '--ignore-scripts',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })) as Array<{ files: Array<{ path: string }> }>;
    const shipped = new Set(packed[0].files.map(({ path }) => path));

    expect(shipped.has(match![1])).toBe(true);
  });
});
