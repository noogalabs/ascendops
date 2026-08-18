import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('node-pty materialization custody', () => {
  it('routes both production PTY families through the permission-repair door', () => {
    for (const relative of ['src/pty/agent-pty.ts', 'src/pty/codex-app-server-pty.ts']) {
      const source = readFileSync(join(root, relative), 'utf8');
      expect(source).toContain("import { prepareNodePtySpawn } from './node-pty-loader.js';");
      expect(source).toContain('= prepareNodePtySpawn;');
      expect(source).not.toContain("require('node-pty')");
    }
  });

  it('repairs before every spawn rather than only inside the function cache gate', () => {
    const cases = [
      ['src/pty/agent-pty.ts', 'this.spawnFn = this.prepareSpawnFn(this.spawnFn);'],
      ['src/pty/codex-app-server-pty.ts', 'this._spawnFn = this._prepareSpawnFn(this._spawnFn);'],
    ] as const;

    for (const [relative, repairBoundary] of cases) {
      const source = readFileSync(join(root, relative), 'utf8');
      expect(source.indexOf(repairBoundary), `${relative} repair boundary`).toBeGreaterThan(-1);
    }
  });
});
