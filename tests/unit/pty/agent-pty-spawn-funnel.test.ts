import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('AgentPTY subclass spawn funnel', () => {
  it('requires every AgentPTY subclass spawn override to call super.spawn', () => {
    const sourceRoot = join(process.cwd(), 'src', 'pty');
    const files = readdirSync(sourceRoot).filter((file) => file.endsWith('.ts'));
    let subclassCount = 0;

    for (const file of files) {
      const source = readFileSync(join(sourceRoot, file), 'utf8');
      if (!/class\s+\w+\s+extends\s+AgentPTY/.test(source)) continue;
      subclassCount += 1;
      const spawnOverride = source.match(/async\s+spawn\s*\([^]*?\n  }\n/);
      if (spawnOverride) {
        expect(spawnOverride[0], `${file} must funnel spawn through AgentPTY`).toContain('super.spawn(');
      }
    }

    expect(subclassCount, 'the AgentPTY subclass census changed; review every new spawn override').toBe(2);
  });
});
