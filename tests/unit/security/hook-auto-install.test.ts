import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();

describe('local security hook auto-install wiring', () => {
  it('the standalone installer remains non-clobbering and installs both gates', () => {
    const source = readFileSync(join(root, 'scripts/setup-hooks.sh'), 'utf8');
    expect(source).toContain('cmp -s "$src" "$dest"');
    expect(source).toContain('install_hook pre-commit');
    expect(source).toContain('install_hook pre-push');
  });

  it('the product installer invokes the reviewed hook installer best-effort', () => {
    const source = readFileSync(join(root, 'install.mjs'), 'utf8');
    expect(source).toContain("run('bash scripts/setup-hooks.sh', { cwd: INSTALL_DIR })");
    expect(source).toContain('Could not install local git hooks');
  });

  it('org init uses argv-safe execution and keeps failures non-fatal', () => {
    const source = readFileSync(join(root, 'src/cli/init.ts'), 'utf8');
    expect(source).toContain("execFileSync('bash', ['scripts/setup-hooks.sh']");
    expect(source).toContain('Skipped local git hook install');
  });
});
