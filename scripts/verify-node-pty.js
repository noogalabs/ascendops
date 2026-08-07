#!/usr/bin/env node
// Verifies node-pty's native binding actually works, and rebuilds it from
// source if not.
//
// Incident: on 2026-07-14 an `npm install` picked up a node-pty prebuilt
// binary (prebuilds/darwin-arm64/pty.node) that was ABI-incompatible with the
// installed Node version (v24.17.0 — very recent; node-pty 1.1.0 has no
// matching prebuild for it yet). Every agent runtime uses node-pty to spawn
// its AI session, so this silently broke all of them: `pty.spawn(...)` threw
// "posix_spawnp failed" for every single command, not just codex. The daemon
// stayed superficially "healthy" (Telegram polling, cron scheduling, and
// command registration don't go through node-pty) while zero agent sessions
// were actually running, so the breakage went unnoticed until one agent's
// crash counter tripped its daily halt.
//
// This check runs post-install so a bad prebuild gets replaced automatically
// instead of silently degrading the whole fleet. It never hard-fails the
// install — if a source rebuild isn't possible (e.g. no compiler on a
// from-scratch Windows box), it warns and leaves the existing prebuild in
// place, same as today's behavior.
'use strict';

const { spawnSync } = require('child_process');

function ptyWorks() {
  try {
    // Fresh require in a subprocess: node-pty caches its native binding in
    // memory once loaded, so testing in-process wouldn't catch a binding
    // that's fine right now but was bad before a rebuild (or vice versa).
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        "const pty = require('node-pty'); const p = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/echo', process.platform === 'win32' ? ['/c','ok'] : ['ok'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env }); p.onExit(({exitCode}) => process.exit(exitCode === 0 ? 0 : 1));",
      ],
      { stdio: 'ignore', timeout: 15000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

if (ptyWorks()) {
  process.exit(0);
}

console.warn(
  '[verify-node-pty] node-pty native binding failed a spawn smoke test ' +
    '(this breaks every agent runtime — see scripts/verify-node-pty.js for ' +
    'the 2026-07-14 incident). Attempting a source rebuild...',
);

const rebuild = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['rebuild', 'node-pty', '--build-from-source'],
  { stdio: 'inherit' },
);

if (rebuild.status === 0 && ptyWorks()) {
  console.warn('[verify-node-pty] Rebuilt node-pty from source successfully.');
  process.exit(0);
}

console.warn(
  '[verify-node-pty] Could not get a working node-pty binding (rebuild ' +
    (rebuild.status === 0 ? 'ran but the smoke test still fails' : 'failed, likely missing build tools') +
    "). Agent sessions will fail to start with 'posix_spawnp failed' until " +
    'this is fixed manually (install a C++ toolchain, e.g. Xcode Command ' +
    "Line Tools on macOS or Visual Studio Build Tools on Windows, then run " +
    "'npm rebuild node-pty --build-from-source').",
);
// Never fail the install over this — leaves the existing (possibly broken)
// prebuild in place, matching prior behavior, rather than blocking setup.
process.exit(0);
