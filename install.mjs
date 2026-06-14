#!/usr/bin/env node
/**
 * AscendOps cross-platform installer
 *
 * Mac/Linux:   curl -fsSL https://raw.githubusercontent.com/noogalabs/ascendops/main/install.mjs | node
 * Windows:     node -e "$(irm https://raw.githubusercontent.com/noogalabs/ascendops/main/install.mjs)"
 * Local test:  node install.mjs
 */

import { execSync, spawnSync, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, chmodSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

const REPO_URL = process.env.ASCENDOPS_REPO || process.env.CORTEXTOS_REPO || 'https://github.com/noogalabs/ascendops.git';
const INSTALL_DIR = process.env.ASCENDOPS_DIR || process.env.CORTEXTOS_DIR || join(homedir(), 'ascendops');

// CORTEXTOS_BRANCH lets you install a specific branch instead of `main`. Useful
// for testing fixes before they merge:
//   CORTEXTOS_BRANCH=fix/foo curl -fsSL .../fix/foo/install.mjs | node
// Branch name is restricted to standard git ref characters to avoid shell injection.
const REPO_BRANCH_RAW = process.env.CORTEXTOS_BRANCH || 'main';
if (!/^[a-zA-Z0-9._/-]+$/.test(REPO_BRANCH_RAW)) {
  console.error(`Invalid CORTEXTOS_BRANCH value: ${REPO_BRANCH_RAW}`);
  console.error('Branch names may only contain letters, digits, dot, underscore, slash, or dash.');
  process.exit(1);
}
const REPO_BRANCH = REPO_BRANCH_RAW;
const IS_WINDOWS = platform() === 'win32';
const IS_MAC = platform() === 'darwin';
const IS_LINUX = platform() === 'linux';

// ANSI colors (work on modern Windows Terminal, macOS Terminal, Linux)
const R = '\x1b[0m';
const B = '\x1b[34m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';

const log  = (msg) => console.log(`${B}==>${R} ${msg}`);
const ok   = (msg) => console.log(`${G}  ✓${R} ${msg}`);
const warn = (msg) => console.log(`${Y}  !${R} ${msg}`);
const fail = (msg) => { console.error(`${RED}  ✗${R} ${msg}`); process.exit(1); };
const info = (msg) => console.log(`    ${msg}`);

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
}

function runVisible(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function commandExists(cmd) {
  try {
    const which = IS_WINDOWS ? 'where' : 'which';
    run(`${which} ${cmd}`);
    return true;
  } catch {
    return false;
  }
}

function tryInstall(label, installFn) {
  try {
    installFn();
    return true;
  } catch {
    warn(`Could not auto-install ${label} — see manual instructions above`);
    return false;
  }
}

function linkVendoredClaudeMarketplace(marketplaceName) {
  const claudePluginsRoot = join(homedir(), '.claude', 'plugins', 'marketplaces');
  const src = join(INSTALL_DIR, 'vendor', 'claude-plugins', marketplaceName);
  const dest = join(claudePluginsRoot, marketplaceName);

  if (!existsSync(src)) {
    warn(`Vendored Claude marketplace missing: ${marketplaceName}`);
    return;
  }

  mkdirSync(claudePluginsRoot, { recursive: true });

  try {
    const stat = lstatSync(dest);
    if (stat.isSymbolicLink()) {
      const currentTarget = readlinkSync(dest);
      if (currentTarget === src) {
        ok(`Claude marketplace already linked: ${marketplaceName}`);
        return;
      }

      unlinkSync(dest);
      ok(`Re-linking stale Claude marketplace: ${marketplaceName}`);
    } else {
      warn(`Claude marketplace path already exists and is not a symlink: ${dest}`);
      return;
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      warn(`Could not inspect existing Claude marketplace path: ${dest}`);
      return;
    }
  }

  try {
    symlinkSync(src, dest, IS_WINDOWS ? 'junction' : 'dir');
    ok(`Linked Claude marketplace: ${marketplaceName}`);
  } catch {
    warn(`Could not link Claude marketplace: ${marketplaceName}`);
  }
}

function installRtkAndIcm() {
  log('Checking rtk + icm (token optimization + memory MCP)...');

  const hasRtk = commandExists('rtk');
  const hasIcm = commandExists('icm');
  if (hasRtk && hasIcm) {
    ok(`rtk ${run('rtk --version')}`);
    ok(`icm ${run('icm --version')}`);
    return;
  }

  if (IS_WINDOWS) {
    warn('rtk + icm are not auto-installed on Windows. Install them manually if you want token optimization and ICM memory tooling.');
    return;
  }

  if (!commandExists('brew')) {
    if (IS_MAC) {
      warn('rtk + icm require Homebrew on macOS. Install manually with: brew tap rtk-ai/tap && brew install rtk icm');
    } else if (IS_LINUX) {
      warn('rtk + icm require Linuxbrew on Linux for version parity. Install manually with: brew tap rtk-ai/tap && brew install rtk icm');
    }
    return;
  }

  try {
    runVisible('brew tap rtk-ai/tap');
    runVisible('brew install rtk icm');
  } catch {
    warn('rtk + icm install failed via brew. Install manually with: brew tap rtk-ai/tap && brew install rtk icm');
    return;
  }

  if (commandExists('rtk')) {
    ok(`rtk ${run('rtk --version')}`);
  } else {
    warn('rtk did not appear on PATH after brew install');
  }

  if (commandExists('icm')) {
    ok(`icm ${run('icm --version')}`);
  } else {
    warn('icm did not appear on PATH after brew install');
  }
}

console.log('');
console.log(`${BOLD}AscendOps installer${R}`);
console.log('Persistent 24/7 Claude Code agents with Telegram control');
console.log('');

// ─── 1. Node.js version ──────────────────────────────────────────────────────

log('Checking Node.js...');
const nodeVersion = run('node --version').replace('v', '');
const nodeMajor = parseInt(nodeVersion.split('.')[0], 10);
if (nodeMajor < 20) {
  fail(`Node.js v${nodeVersion} is too old. v20 or later required.\n    Install from https://nodejs.org`);
}
ok(`Node.js v${nodeVersion}`);

try {
  const npmVersion = run('npm --version');
  ok(`npm ${npmVersion}`);
} catch {
  fail('npm is not installed');
}

// ─── 2. git ───────────────────────────────────────────────────────────────────

log('Checking git...');
if (!commandExists('git')) {
  if (IS_MAC) {
    warn('git is not installed. It will be installed with Xcode Command Line Tools (next step).');
  } else if (IS_LINUX) {
    warn('git is not installed. Installing...');
    try { runVisible('sudo apt-get install -y git'); ok('git installed'); }
    catch { fail('Could not install git. Run: sudo apt-get install -y git'); }
  } else {
    fail('git is not installed.\n    Install from https://git-scm.com/download/win or via: winget install Git.Git');
  }
} else {
  ok(`git ${run('git --version')}`);
}

// ─── 2b. Homebrew (macOS — needed for jq auto-install) ───────────────────────

if (IS_MAC && !commandExists('brew')) {
  console.log('');
  console.log(`${Y}  ! Homebrew is not installed.${R}`);
  console.log('    Homebrew is used to auto-install jq and other tools on macOS.');
  console.log(`    Install it: ${Y}/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"${R}`);
  console.log('    You can skip this for now, but jq will need to be installed manually later.');
  console.log('');
}

// ─── 3. Build tools (required for node-pty native compilation) ───────────────

log('Checking build tools (required for native dependencies)...');

if (IS_MAC) {
  let hasXcode = false;
  try {
    run('xcode-select -p');
    hasXcode = true;
  } catch { /* not installed */ }

  if (!hasXcode) {
    console.log('');
    console.log(`${Y}  ! Xcode Command Line Tools are not installed.${R}`);
    console.log(`    These are required to compile native Node.js addons (node-pty).`);
    console.log('');
    console.log(`    ${BOLD}Installing now...${R}`);
    console.log(`    A dialog box will appear asking you to install the tools.`);
    console.log(`    Click "Install" and wait for it to complete, then press Enter here.`);
    console.log('');
    try {
      runVisible('xcode-select --install');
    } catch { /* dialog already open or installing */ }
    // Wait for user to confirm
    console.log('');
    await new Promise((resolve) => {
      process.stdout.write('    Press Enter once Xcode CLI tools installation is complete... ');
      process.stdin.once('data', resolve);
    });
    try {
      run('xcode-select -p');
      ok('Xcode Command Line Tools installed');
    } catch {
      fail('Xcode Command Line Tools still not found. Install them manually:\n    xcode-select --install');
    }
  } else {
    ok(`Xcode Command Line Tools: ${run('xcode-select -p')}`);
  }
} else if (IS_LINUX) {
  let hasBuildEssential = false;
  try {
    run('dpkg -l build-essential 2>/dev/null | grep -q "^ii"');
    hasBuildEssential = true;
  } catch { /* not installed */ }
  if (!hasBuildEssential) {
    warn('build-essential not detected. Installing...');
    tryInstall('build-essential', () => runVisible('sudo apt-get install -y build-essential python3'));
  } else {
    ok('build-essential');
  }
} else if (IS_WINDOWS) {
  // Check for Visual C++ Build Tools. `cl.exe` is only on PATH inside a
  // "Developer PowerShell for VS" — a normal PowerShell won't see it even when
  // the tools ARE installed, which produced false "build tools missing" failures
  // mid-install. So if cl.exe isn't on PATH we fall back to vswhere, which
  // reports the install regardless of PATH (and is what node-gyp itself uses to
  // locate the toolset, so a vswhere hit is sufficient for the later build).
  let hasBuildTools = false;
  try {
    run('where cl.exe');
    hasBuildTools = true;
  } catch { /* cl.exe not on PATH — normal outside a Developer PowerShell */ }

  if (!hasBuildTools) {
    // vswhere ships with every VS 2017+ installer at a fixed location. Query for
    // the VC++ x64/x86 toolset component; a non-empty installationPath means the
    // build tools are present even though cl.exe isn't on this shell's PATH.
    const vswhere = join(
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'Microsoft Visual Studio', 'Installer', 'vswhere.exe'
    );
    if (existsSync(vswhere)) {
      try {
        const vcPath = run(`${JSON.stringify(vswhere)} -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`);
        if (vcPath) hasBuildTools = true;
      } catch { /* vswhere found no matching install */ }
    }
  }

  if (!hasBuildTools) {
    console.log('');
    console.log(`${Y}  ! Visual C++ Build Tools are required for native Node.js addons (node-pty).${R}`);
    console.log('');
    console.log(`    ${BOLD}Recommended: install via winget (Administrator PowerShell)${R}`);
    console.log('    Run this, then re-run this installer:');
    console.log(`    ${Y}  winget install Microsoft.VisualStudio.2022.BuildTools --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"${R}`);
    console.log('');
    console.log(`    ${BOLD}Manual alternative${R}`);
    console.log('    https://visualstudio.microsoft.com/visual-cpp-build-tools/');
    console.log('    (select the "Desktop development with C++" workload)');
    console.log('');
    const tryAuto = process.env.AUTO_BUILD_TOOLS === '1';
    if (tryAuto) {
      warn('Attempting auto-install of VC++ Build Tools via winget (requires admin)...');
      try {
        runVisible('winget install Microsoft.VisualStudio.2022.BuildTools --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"');
        ok('Visual C++ Build Tools installed via winget');
      } catch {
        fail('Could not auto-install build tools via winget. Install manually (see above), then re-run.\nIf winget is missing, update "App Installer" from the Microsoft Store.');
      }
    } else {
      fail('Visual C++ Build Tools required. See instructions above.\nSet AUTO_BUILD_TOOLS=1 to attempt auto-install via winget (requires admin).');
    }
  } else {
    ok('Visual C++ Build Tools found');
  }
}

// ─── 3b. Python 3 (needed as fallback for native module compilation) ─────────

log('Checking Python 3...');
const hasPython = commandExists('python3') || commandExists('python');
if (!hasPython) {
  if (IS_LINUX) {
    warn('python3 not found. Installing...');
    tryInstall('python3', () => runVisible('sudo apt-get install -y python3'));
  } else if (IS_WINDOWS) {
    warn('python3 not found. node-pty compilation may fail.');
    console.log('    Install Python 3 from https://www.python.org/downloads/');
    console.log('    Or via Microsoft Store: search "Python 3"');
    console.log('');
  } else if (IS_MAC) {
    // Xcode CLI tools include Python 3 — should already be present
    warn('python3 not found (should be included with Xcode CLI Tools).');
  }
} else {
  try {
    const pyver = run(commandExists('python3') ? 'python3 --version' : 'python --version');
    ok(pyver);
  } catch { ok('python3: installed'); }
}

// ─── 4. Claude Code ───────────────────────────────────────────────────────────

log('Checking Claude Code...');
if (commandExists('claude')) {
  try {
    const claudeVersion = run('claude --version').split('\n')[0];
    ok(`Claude Code ${claudeVersion}`);
  } catch {
    ok('Claude Code (installed)');
  }
} else {
  warn('Claude Code is not installed. Installing now...');
  try {
    runVisible('npm install -g @anthropic-ai/claude-code');
    ok('Claude Code installed');
  } catch {
    console.log('');
    console.log(`${Y}  Could not auto-install Claude Code. Install manually:${R}`);
    console.log(`    npm install -g @anthropic-ai/claude-code`);
    console.log('');
  }
}

// Check claude authentication — use `claude auth status` which covers all auth methods (OAuth, API key, etc.)
{
  let authenticated = false;
  try {
    const authOutput = run('claude auth status');
    if (authOutput.includes('"loggedIn": true') || authOutput.includes('"loggedIn":true')) {
      authenticated = true;
    }
  } catch {
    // fall through to env var fallback below
  }

  if (!authenticated && process.env.ANTHROPIC_API_KEY) {
    authenticated = true;
  }

  if (!authenticated) {
    console.log('');
    console.log(`${RED}${BOLD}ERROR: Claude Code is not authenticated.${R}`);
    console.log('');
    console.log('Run this command, then re-run the AscendOps installer:');
    console.log('');
    console.log(`  ${Y}claude login${R}`);
    console.log('');
    console.log('If you do not use Claude login, set ANTHROPIC_API_KEY first, then re-run the installer:');
    console.log('');
    console.log(`  ${Y}export ANTHROPIC_API_KEY=sk-ant-your-key${R}`);
    console.log('');
    process.exit(1);
  } else {
    ok('Claude Code authenticated');
  }
}

// ─── 5. jq ────────────────────────────────────────────────────────────────────

log('Checking jq (required for agent bus scripts)...');
if (!commandExists('jq')) {
  warn('jq is not installed. Installing...');
  let installed = false;

  if (IS_MAC) {
    if (commandExists('brew')) {
      installed = tryInstall('jq', () => runVisible('brew install jq'));
    } else {
      console.log('');
      console.log(`    ${BOLD}Homebrew is required to auto-install jq on macOS.${R}`);
      console.log('    Install Homebrew first: https://brew.sh');
      console.log('    Then run: brew install jq');
      console.log('');
    }
  } else if (IS_LINUX) {
    installed = tryInstall('jq', () => runVisible('sudo apt-get install -y jq'));
  } else if (IS_WINDOWS) {
    if (commandExists('winget')) {
      installed = tryInstall('jq', () => runVisible('winget install jqlang.jq --silent'));
    } else if (commandExists('choco')) {
      installed = tryInstall('jq', () => runVisible('choco install jq -y'));
    } else {
      console.log('');
      console.log(`    ${BOLD}Install jq on Windows:${R}`);
      console.log('    winget:  winget install jqlang.jq');
      console.log('    choco:   choco install jq');
      console.log('    manual:  https://jqlang.github.io/jq/download/');
      console.log('');
    }
  }

  if (installed && commandExists('jq')) {
    ok(`jq ${run('jq --version')}`);
  } else if (!installed) {
    warn('jq not installed — agent bus scripts will not work without it');
  }
} else {
  ok(`jq ${run('jq --version')}`);
}

installRtkAndIcm();

// ─── 6. Windows: WSL check ────────────────────────────────────────────────────

if (IS_WINDOWS) {
  log('Checking WSL (required for agent shell scripts on Windows)...');
  if (commandExists('wsl')) {
    try {
      const wslVersion = run('wsl --version 2>&1 || wsl -l -v');
      ok(`WSL installed`);
    } catch {
      ok('WSL installed');
    }
  } else {
    console.log('');
    console.log(`${Y}  ! WSL (Windows Subsystem for Linux) is required.${R}`);
    console.log('    Agent shell scripts run inside a bash environment.');
    console.log('');
    console.log(`    ${BOLD}Install WSL (requires restart):${R}`);
    console.log(`    ${Y}  wsl --install${R}`);
    console.log('    Run this in an Administrator PowerShell, then restart your machine.');
    console.log('    After restart, run this installer again.');
    console.log('');
    warn('WSL not installed — agents will not work without it on Windows');
  }
}

console.log('');

// ─── 7. Clone or update ───────────────────────────────────────────────────────

// Friendly note for operators who have an existing ~/cortextos checkout (likely
// upstream cortextOS, not a prior AscendOps install — AscendOps just shipped
// today). AscendOps installs separately at ~/ascendops by design; ASCENDOPS_DIR
// override lets you point elsewhere if you've moved your install path.
const LEGACY_CORTEXTOS_DIR = join(homedir(), 'cortextos');
if (
  !process.env.ASCENDOPS_DIR &&
  !process.env.CORTEXTOS_DIR &&
  INSTALL_DIR !== LEGACY_CORTEXTOS_DIR &&
  existsSync(LEGACY_CORTEXTOS_DIR)
) {
  info(`Note: ~/cortextos already exists (likely upstream cortextOS, not a prior AscendOps install). AscendOps installs separately at ${INSTALL_DIR}. Set ASCENDOPS_DIR=<path> to override.`);
}

if (existsSync(INSTALL_DIR)) {
  warn(`Directory ${INSTALL_DIR} already exists`);
  if (existsSync(join(INSTALL_DIR, '.git'))) {
    // Check and migrate remote setup if needed
    let hasUpstream = false;
    try {
      run('git remote get-url upstream', { cwd: INSTALL_DIR });
      hasUpstream = true;
    } catch { /* no upstream remote yet */ }

    if (!hasUpstream) {
      let originUrl = '';
      try { originUrl = run('git remote get-url origin', { cwd: INSTALL_DIR }); } catch { /* no origin */ }
      const repoName = REPO_URL.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').split('/').pop();
      // origin IS the canonical repo (a plain clone) — rename it to upstream.
      const isCanonicalOrigin = !!originUrl && (
        originUrl.includes('noogalabs/ascendops') ||
        originUrl.includes('grandamenium/cortextos') ||
        originUrl === REPO_URL
      );
      // origin is a personal FORK — same repo name, different owner
      // (e.g. <you>/ascendops). Recognize it by repo-name so an in-place
      // re-run of a manually forked+cloned tree still wires up upstream and can
      // pull updates, instead of silently skipping the migration.
      const isForkOrigin = !!originUrl && !isCanonicalOrigin && (
        originUrl.endsWith(`/${repoName}.git`) || originUrl.endsWith(`/${repoName}`)
      );
      if (isCanonicalOrigin) {
        log('Migrating git remotes: renaming origin → upstream...');
        try {
          run('git remote rename origin upstream', { cwd: INSTALL_DIR });
          ok('Remote migrated: canonical repo is now "upstream"');
          hasUpstream = true;
        } catch {
          warn('Could not rename remote — run manually: git remote rename origin upstream');
        }
      } else if (isForkOrigin) {
        // Keep origin = your fork; add canonical as upstream so pulls work and
        // you can still contribute back. Matches the gh-fork install end state.
        log('Detected a personal fork as origin — adding canonical "upstream" remote...');
        try {
          run(`git remote add upstream ${REPO_URL}`, { cwd: INSTALL_DIR });
          ok(`"upstream" remote added (origin stays your fork, upstream = ${repoName})`);
          hasUpstream = true;
        } catch {
          warn(`Could not add upstream — run manually: git remote add upstream ${REPO_URL}`);
        }
      }
    }

    log('Pulling latest changes...');
    try {
      if (hasUpstream) {
        runVisible('git pull upstream main --ff-only', { cwd: INSTALL_DIR });
      } else {
        runVisible('git pull --ff-only', { cwd: INSTALL_DIR });
      }
    } catch {
      warn('Could not pull — continuing with existing version');
    }
  } else {
    fail(`${INSTALL_DIR} exists but is not a git repo. Remove it or set CORTEXTOS_DIR to a different path.`);
  }
} else {
  // Try fork-by-default first: if gh CLI is installed and authed, create
  // (or reuse) the user's personal fork on GitHub so origin=fork +
  // upstream=canonical. That enables both pulling updates AND contributing
  // back via PR. Fall back to plain clone if gh isn't available — same
  // observable end state for the install minus the personal fork.
  const REPO_OWNER_PATH = REPO_URL.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  const REPO_NAME = REPO_OWNER_PATH.split('/').pop();

  const REPO_OWNER = REPO_OWNER_PATH.split('/')[0];

  let ghForkOk = false;
  if (commandExists('gh')) {
    let ghAuthed = false;
    try { run('gh auth status'); ghAuthed = true; } catch { /* not authed */ }

    // When the operator's gh account IS the canonical repo owner (e.g. someone
    // from noogalabs installing their own AscendOps), `gh repo fork` errors
    // with "can't create fork in own account". The catch falls through to
    // plain clone, but it's a noisy stderr dump for a known no-op. Detect the
    // case up front and skip the fork attempt cleanly.
    let ghUser = '';
    if (ghAuthed) {
      try { ghUser = run('gh api user --jq .login'); } catch { /* unreachable when authed */ }
    }
    const ownsCanonical = ghAuthed && ghUser && ghUser === REPO_OWNER;

    if (ghAuthed && ownsCanonical) {
      info(`gh CLI authed as ${ghUser} — you own ${REPO_OWNER_PATH}. Skipping fork; using plain clone.`);
    } else if (ghAuthed) {
      log(`Forking ${REPO_OWNER_PATH} to your GitHub account (gh CLI authed)...`);
      try {
        // gh CLI rejects `--remote` (including `--remote=false`) when a
        // repository argument is provided: "the --remote flag is unsupported
        // when a repository argument is provided". Pass `--clone=false` only
        // and add the upstream remote manually after the clone below.
        run(`gh repo fork ${REPO_OWNER_PATH} --clone=false`);
        const forkUrl = `https://github.com/${ghUser}/${REPO_NAME}.git`;
        log(`Cloning your fork to ${INSTALL_DIR}...`);
        runVisible(`git clone --branch ${REPO_BRANCH} ${forkUrl} ${JSON.stringify(INSTALL_DIR)}`);
        run(`git remote add upstream ${REPO_URL}`, { cwd: INSTALL_DIR });
        ok(`Forked + cloned (origin = your fork, upstream = ${REPO_OWNER_PATH})`);
        ghForkOk = true;
      } catch (err) {
        // Surface the full error to stderr so future install failures are
        // diagnosable. execSync wraps the child stderr in err.stderr, so
        // include it explicitly — err.message alone is just "Command failed".
        // Truncating to 80 chars previously hid the ship-blocker that caused
        // this fix; keep the user-facing line short but log full context.
        const stderrText = err?.stderr ? err.stderr.toString() : '';
        const stdoutText = err?.stdout ? err.stdout.toString() : '';
        const fullErr = [err?.message || String(err), stderrText && `stderr: ${stderrText}`, stdoutText && `stdout: ${stdoutText}`]
          .filter(Boolean)
          .join('\n');
        console.error(`\n[install] gh repo fork failed — full error:\n${fullErr}\n`);
        // Pick the most informative single line for the user-facing warn:
        // the first non-empty line of stderr is usually the real reason.
        const userLine = (stderrText.split('\n').find(l => l.trim()) || err?.message || 'unknown').slice(0, 160);
        warn(`gh repo fork failed (${userLine}) — falling back to plain clone`);
      }
    } else {
      info('gh CLI installed but not authed — run `gh auth login` later to enable contributing back. Falling back to plain clone.');
    }
  } else {
    info('gh CLI not installed — using plain clone. Install gh + run `gh auth login` later if you want to contribute changes back upstream.');
  }

  if (!ghForkOk) {
    log(`Cloning AscendOps (branch: ${REPO_BRANCH}) to ${INSTALL_DIR}...`);
    runVisible(`git clone --branch ${REPO_BRANCH} ${REPO_URL} ${JSON.stringify(INSTALL_DIR)}`);
    ok('Cloned');

    // Rename origin → upstream so check-upstream and upstream-sync work
    // the same way the gh-fork path produces (origin → fork or absent,
    // upstream → canonical).
    log('Configuring git remotes...');
    try {
      run('git remote rename origin upstream', { cwd: INSTALL_DIR });
      ok('"upstream" remote configured (tracks canonical AscendOps)');
    } catch {
      warn('Could not configure upstream remote — run manually: git remote rename origin upstream');
    }
  }
}

// ─── 8. npm install ───────────────────────────────────────────────────────────

log('Installing dependencies (this may take a minute)...');
try {
  runVisible('npm install', { cwd: INSTALL_DIR });
  ok('Dependencies installed');
} catch (err) {
  console.error('');
  console.error(`${RED}  npm install failed.${R}`);
  if (IS_MAC) {
    console.error('  If you see C++ compilation errors, install Xcode CLI tools:');
    console.error('    xcode-select --install');
  } else if (IS_LINUX) {
    console.error('  If you see C++ compilation errors, install build tools:');
    console.error('    sudo apt-get install -y build-essential');
  } else if (IS_WINDOWS) {
    console.error('  If you see C++ compilation errors, install Visual C++ Build Tools (run as Administrator):');
    console.error('    winget install Microsoft.VisualStudio.2022.BuildTools --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"');
  }
  process.exit(1);
}

// ─── 8b. Fix node-pty spawn-helper permissions ───────────────────────────────
// npm doesn't reliably preserve executable bits on prebuild binaries.
// This causes posix_spawnp to fail on macOS/Linux when the daemon tries to spawn agents.

if (!IS_WINDOWS) {
  const prebuilds = join(INSTALL_DIR, 'node_modules', 'node-pty', 'prebuilds');
  const buildRel = join(INSTALL_DIR, 'node_modules', 'node-pty', 'build', 'Release');
  let fixed = false;

  if (existsSync(prebuilds)) {
    try {
      for (const d of readdirSync(prebuilds)) {
        const h = join(prebuilds, d, 'spawn-helper');
        if (existsSync(h) && (statSync(h).mode & 0o111) === 0) { chmodSync(h, 0o755); fixed = true; }
      }
    } catch { /* skip */ }
  }
  const bh = join(buildRel, 'spawn-helper');
  if (existsSync(bh)) {
    try { if ((statSync(bh).mode & 0o111) === 0) { chmodSync(bh, 0o755); fixed = true; } } catch { /* skip */ }
  }

  if (fixed) ok('Fixed node-pty spawn-helper permissions');
}

// ─── 9. Build ─────────────────────────────────────────────────────────────────

log('Building...');
runVisible('npm run build', { cwd: INSTALL_DIR });
ok('Build complete');

// ─── 10. Link CLI globally ────────────────────────────────────────────────────

log('Linking cortextos CLI...');
try {
  runVisible('npm link', { cwd: INSTALL_DIR });
} catch {
  try {
    runVisible('npm install -g .', { cwd: INSTALL_DIR });
  } catch {
    warn('Could not install globally. Run manually: cd ' + INSTALL_DIR + ' && npm install -g .');
  }
}

if (commandExists('cortextos')) {
  ok('cortextos CLI available');
} else {
  warn('cortextos not in PATH yet. You may need to restart your terminal.');
}

// ─── 11. PM2 ─────────────────────────────────────────────────────────────────

log('Checking PM2 (process manager)...');
if (!commandExists('pm2')) {
  log('Installing PM2...');
  try {
    runVisible('npm install -g pm2');
    ok(`PM2 ${run('pm2 --version')}`);
  } catch {
    warn('Could not install PM2. Install manually: npm install -g pm2');
  }
} else {
  ok(`PM2 ${run('pm2 --version')}`);
}

// ─── 12. Run cortextos install ────────────────────────────────────────────────

log('Running cortextos install...');
try {
  runVisible('node dist/cli.js install', { cwd: INSTALL_DIR });
} catch {
  warn('cortextos install had warnings — see above');
}

log('Linking bundled Claude plugins...');
for (const marketplace of ['caveman', 'thedotmack']) {
  linkVendoredClaudeMarketplace(marketplace);
}

// ─── Done ─────────────────────────────────────────────────────────────────────

console.log('');
console.log(`${G}${BOLD}AscendOps installed successfully!${R}`);
console.log('');

const onboardingLaunchCommand = `cd ${JSON.stringify(INSTALL_DIR)} && claude /onboarding`;

if (!commandExists('claude')) {
  console.log(`${Y}  IMPORTANT: Install and authenticate Claude Code before continuing:${R}`);
  console.log(`    npm install -g @anthropic-ai/claude-code`);
  console.log(`    claude login`);
  console.log('');
}

console.log(`${BOLD}Next step — copy-paste this single command:${R}`);
console.log('');
console.log(`  ${Y}${onboardingLaunchCommand}${R}`);
console.log('');
console.log('This opens Claude Code with the /onboarding wizard already running.');
console.log('');

if (commandExists('claude') && process.stdin.isTTY && process.stdout.isTTY) {
  console.log('Launching Claude Code and starting /onboarding...');
  console.log('');

  const claudeProc = spawn('claude', ['/onboarding'], {
    cwd: INSTALL_DIR,
    stdio: 'inherit',
  });

  claudeProc.on('error', () => {
    warn('Could not auto-launch Claude Code. Use the copy-paste command above.');
  });

  claudeProc.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}
