#!/usr/bin/env node
/**
 * fix-spawn-helper-perms — restore the execute bit on node-pty's spawn-helper.
 *
 * WHY THIS EXISTS (fleet outage, 2026-08-13):
 *   node-pty ships prebuilt `spawn-helper` binaries. An `npm install` on this box
 *   wrote them WITHOUT the execute bit (mode 600). node-pty spawns every agent
 *   session through that helper, so every codex-app-server spawn failed with:
 *
 *       Error: posix_spawnp failed.
 *
 *   Nothing in that message mentions permissions, the helper, or node-pty. The
 *   failure was diagnosed only by ctime forensics hours later, after an agent had
 *   been down all evening and a manual `chmod +x` restored it.
 *
 *   THE DISCRIMINATOR THAT MAKES IT SILENT: a shell invocation of the same command
 *   works fine, because a plain `exec` never goes through node-pty's helper. So
 *   "it works when I run it manually, it fails from the daemon" is the signature —
 *   and it reads like an environment problem, which is the wrong layer entirely.
 *
 * WHY A HOOK RATHER THAN A ONE-TIME FIX:
 *   `npm install` re-extracts the prebuild and silently re-arms the outage. The
 *   manual chmod fixes today and nothing else. This runs on every install.
 *
 * SCOPE: mode only. It never downloads, rebuilds, or modifies file CONTENT — so a
 *   corrupted or wrong-arch helper is NOT something this can paper over, and the
 *   failure would still surface loudly rather than being half-masked.
 *
 * Exit: 0 = all helpers executable (fixed or already fine) | 1 = could not fix one
 */

import { existsSync, readdirSync, statSync, chmodSync } from 'fs';
import { join, relative } from 'path';

const ROOT = process.cwd();
const PREBUILDS = join(ROOT, 'node_modules', 'node-pty', 'prebuilds');
const WANT = 0o755;

/** Every spawn-helper under prebuilds/, not just this platform's. */
function findHelpers(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findHelpers(p));
    else if (entry.name === 'spawn-helper') out.push(p);
  }
  return out;
}

// node-pty is optional on some installs; absence is not an error.
if (!existsSync(PREBUILDS)) {
  console.log('[spawn-helper] node-pty prebuilds not present — nothing to do');
  process.exit(0);
}

const helpers = findHelpers(PREBUILDS);

// A zero-length result means the layout changed under us. That is NOT "all clear":
// it is the same shape as a scan that examined nothing, so it must be loud.
if (helpers.length === 0) {
  console.error(
    `[spawn-helper] FAIL: found 0 spawn-helper binaries under ${relative(ROOT, PREBUILDS)}.\n` +
    '            node-pty\'s layout changed, so this guard is now scanning nothing.\n' +
    '            Fix the path rather than ignoring this — a silent zero here means the\n' +
    '            outage this guard exists to prevent can return undetected.'
  );
  process.exit(1);
}

let fixed = 0, already = 0, failed = 0;

for (const h of helpers) {
  const rel = relative(ROOT, h);
  const mode = statSync(h).mode & 0o777;
  // Executable by owner is what posix_spawnp actually needs.
  if (mode & 0o100) { already++; continue; }
  try {
    chmodSync(h, WANT);
    const now = statSync(h).mode & 0o777;   // verify, do not assume chmod took
    if (now & 0o100) {
      console.log(`[spawn-helper] FIXED ${rel}: ${mode.toString(8)} -> ${now.toString(8)}`);
      fixed++;
    } else {
      console.error(`[spawn-helper] FAIL ${rel}: chmod reported success but mode is still ${now.toString(8)}`);
      failed++;
    }
  } catch (err) {
    console.error(`[spawn-helper] FAIL ${rel}: ${err.message}`);
    failed++;
  }
}

const summary = `${helpers.length} helper(s): ${fixed} fixed, ${already} already executable, ${failed} failed`;
if (failed > 0) {
  console.error(`[spawn-helper] ${summary}`);
  console.error('            An inexecutable spawn-helper means EVERY pty-backed agent session fails to spawn.');
  process.exit(1);
}
console.log(`[spawn-helper] ok — ${summary}`);
process.exit(0);
