import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('Codex model entitlement guard', () => {
  it('keeps gpt-5.6-sol inside the SAFE_MODELS array', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/pty/codex-app-server-pty.ts', import.meta.url)),
      'utf8',
    );
    const match = source.match(/const SAFE_MODELS[^=]*=\s*\[([^\]]*)\]/);

    expect(match, 'SAFE_MODELS array declaration must exist').not.toBeNull();
    expect(match?.[1]).toContain("'gpt-5.6-sol'");
  });
});
