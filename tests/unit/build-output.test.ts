import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * This test used to build into the live `dist/`, which made running the suite a
 * deploy: on 2026-08-07 it rebuilt the deployed artifact from uncommitted source
 * during an ordinary test run. Nothing announced it, and the next daemon restart
 * would have shipped whatever happened to be in the working tree.
 *
 * Building to a scratch directory removes the hazard rather than documenting it.
 * The assertion is unchanged — that the tsup entries actually emit the hook
 * bundles — and that is equally true of any out dir, so nothing is traded away.
 */

const expectedHookOutputs = [
  'hooks/hook-session-restore.js',
  'hooks/hook-skill-autopr.js',
];

let outDir: string | undefined;
afterEach(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
  outDir = undefined;
});

describe('build outputs', () => {
  it('emits required hook bundles from tsup entries', { timeout: 60_000 }, () => {
    outDir = mkdtempSync(join(tmpdir(), 'cortextos-build-'));

    execFileSync('npx', ['tsup', '--silent', '--out-dir', outDir], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });

    for (const outputPath of expectedHookOutputs) {
      expect(existsSync(join(outDir, outputPath)), outputPath).toBe(true);
    }
  });

  it('does NOT write the live dist', { timeout: 60_000 }, () => {
    // The property that makes running this suite safe. Asserting the artifact
    // landed in the scratch dir does not prove the live one was left alone, and
    // that distinction is the whole reason this file changed.
    const liveDist = join(process.cwd(), 'dist');
    if (!existsSync(liveDist)) return; // fresh clone, nothing to protect yet
    const before = statOf(liveDist);

    outDir = mkdtempSync(join(tmpdir(), 'cortextos-build-'));
    execFileSync('npx', ['tsup', '--silent', '--out-dir', outDir], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });

    expect(statOf(liveDist)).toEqual(before);
  });
});

/** mtime + size of every file in dist, so any rebuild shows up as a diff. */
function statOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) Object.assign(out, statOf(p));
    else out[p] = `${s.size}:${s.mtimeMs}`;
  }
  return out;
}

describe('tsup config — the DEFAULT path must resolve an out dir', () => {
  it('a bare config resolve carries outDir', async () => {
    // The missing known positive. `outDir: options.outDir` passed undefined
    // through on a bare invocation, overrode tsup's own default and broke
    // `npm run build` — the one path David actually uses, and the one path that
    // cannot be exercised locally without building the live tree. CI was the
    // first place it could surface. This asserts it directly instead.
    // Resolving the config runs the guard. Pin CI=true so this asserts config
    // SHAPE and never fails because of the tree's git state — a shape test that
    // goes red on an unrelated divergence is the kind of noise that gets guards
    // switched off.
    const prevCI = process.env.CI;
    process.env.CI = 'true';
    try {
      const mod = await import('../../tsup.config.js');
      const factory = mod.default as unknown as (o: Record<string, unknown>) => { outDir?: string };

      // No --out-dir: must still name a destination.
      expect(factory({}).outDir).toBe('dist');
      // Explicit --out-dir: must be honoured, not overwritten by the default.
      expect(factory({ outDir: '/tmp/somewhere' }).outDir).toBe('/tmp/somewhere');
    } finally {
      if (prevCI === undefined) delete process.env.CI; else process.env.CI = prevCI;
    }
  });
});
