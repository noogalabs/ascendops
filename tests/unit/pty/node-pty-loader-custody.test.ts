import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('node-pty materialization custody', () => {
  it('routes both production PTY families through the permission-repair door', () => {
    for (const relative of ['src/pty/agent-pty.ts', 'src/pty/codex-app-server-pty.ts']) {
      const source = readFileSync(join(root, relative), 'utf8');
      expect(source).toContain("import { loadNodePty } from './node-pty-loader.js';");
      expect(source).toContain('const nodePty = loadNodePty();');
      expect(source).not.toContain("require('node-pty')");
    }
  });
});
