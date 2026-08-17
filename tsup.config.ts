import { defineConfig } from 'tsup';
import { execFileSync } from 'child_process';
import { chmodSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

const REPO_ROOT = __dirname;
const GUARD = join(REPO_ROOT, 'scripts', 'prebuild-guard.mjs');

/**
 * Run the prebuild guard for THIS build, whoever started it.
 *
 * It used to hang off the npm `prebuild`/`pretest` lifecycle, which meant a
 * direct `npx tsup` skipped it — and one of our own unit tests does exactly
 * that, so an ordinary test run rebuilt the live tree ungated. Binding the
 * guard to the build itself removes the caller from the question entirely.
 *
 * The guard exempts builds that do not write the live dist, so scratch builds
 * are unaffected. `npm run build` now runs it twice, from the lifecycle hook and
 * from here; it is a read-only check, and paying for it twice is much cheaper
 * than discovering a third invocation path later that neither one covered.
 */
function runGuard(outDir: string): void {
  execFileSync('node', [GUARD, '--out-dir', resolve(outDir)], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

/**
 * Stamp the artifact's own permissions instead of inheriting the builder's
 * umask. Observed 2026-08-07: David's login shell (umask 022) produced 755/644
 * and an agent-spawned build (umask 077) produced 700/600 from identical
 * sources. With `clean: true` every build recreates these files, so the modes
 * were re-derived from whoever happened to run it, every time.
 *
 * Permissions are a property of the artifact, not of its author.
 */
function applyArtifactModes(dir: string): void {
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) applyArtifactModes(p);
    else chmodSync(p, name.endsWith('.map') ? 0o644 : 0o755);
  }
}

export default defineConfig((options) => {
  // Earliest possible point: the config factory runs before tsup starts its
  // pipeline, so a rejected build never reaches `clean` and cannot leave the
  // live tree with its dist deleted and nothing put back.
  runGuard(options.outDir ?? 'dist');

  return {
  // Explicit default. Passing `options.outDir` straight through set outDir to
  // undefined on a bare `tsup` invocation, which OVERRODE tsup's own default of
  // `dist` and left esbuild with no output dir for multiple entries. It only
  // showed up in CI because every local check passed --out-dir explicitly:
  // exercising the bare path locally means building the live tree, which is the
  // thing this whole change exists to avoid.
  outDir: options.outDir ?? 'dist',
  entry: {
    cli: 'src/cli/index.ts',
    ascendops: 'src/cli/ascendops.ts',
    daemon: 'src/daemon/index.ts',
    'claude-preflight': 'src/utils/claude-preflight.ts',
    'hooks/hook-permission-telegram': 'src/hooks/hook-permission-telegram.ts',
    'hooks/hook-ask-telegram': 'src/hooks/hook-ask-telegram.ts',
    'hooks/hook-planmode-telegram': 'src/hooks/hook-planmode-telegram.ts',
    'hooks/hook-crash-alert': 'src/hooks/hook-crash-alert.ts',
    'hooks/hook-compact-telegram': 'src/hooks/hook-compact-telegram.ts',
    'hooks/hook-extract-facts': 'src/hooks/hook-extract-facts.ts',
    'hooks/hook-idle-flag': 'src/hooks/hook-idle-flag.ts',
    'hooks/hook-context-status': 'src/hooks/hook-context-status.ts',
    'hooks/hook-session-restore': 'src/hooks/hook-session-restore.ts',
    'hooks/hook-loop-detector': 'src/hooks/hook-loop-detector.ts',
    'hooks/hook-skill-autopr': 'src/hooks/hook-skill-autopr.ts',
  },
  format: ['cjs'],
  target: 'node20',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  shims: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['node-pty'],
  async onSuccess() {
    applyArtifactModes(resolve(options.outDir ?? 'dist'));
  },
  };
});
