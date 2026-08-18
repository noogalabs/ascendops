import { basename, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { platform } from 'os';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { OutputBuffer } from './output-buffer.js';
import { loadAdapter } from './adapters/base.js';
import { injectMessage as injectMessageIntoPty } from './inject.js';
import {
  ensureBypassPromptSuppressed,
  ensureFolderTrusted,
  readUnattendedConsent,
} from '../utils/claude-preflight.js';
import { parseEnvFileStrict } from '../utils/env.js';
import { prepareNodePtySpawn } from './node-pty-loader.js';

// node-pty types
interface IPty {
  pid: number;
  write(data: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
}

interface IPtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

type SpawnFn = (file: string, args: string[], options: IPtySpawnOptions) => IPty;

const ANSI_OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_OSC_RE, '').replace(ANSI_CSI_RE, '');
}

/**
 * Manages a single Claude Code PTY session.
 * Replaces the tmux session management in agent-wrapper.sh.
 */
export class AgentPTY {
  private pty: IPty | null = null;
  private _alive = false;
  private _awaitingInteractiveConfirmation = false;
  private outputBuffer: OutputBuffer;
  protected env: CtxEnv;
  protected config: AgentConfig;
  private onExitHandler: ((exitCode: number, signal?: number) => void) | null = null;
  private spawnFn: SpawnFn | null = null;
  private prepareSpawnFn: (cachedSpawn: SpawnFn | null) => SpawnFn = prepareNodePtySpawn;
  // Trust-prompt auto-accept timers. Stored so they can be cancelled when
  // the PTY exits or is killed — otherwise a timer from a previous spawn()
  // can fire against a RESPAWNED PTY on the same instance and write a stray
  // Enter into the new session (the callbacks only check `this.pty`, which
  // is truthy again after a respawn).
  private trustPromptTimers: ReturnType<typeof setTimeout>[] = [];
  private promptAnswerSent = false;
  private promptOutputCursor = 0;
  private bypassAnswerCount = 0;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string, bootstrapPattern?: string) {
    this.env = env;
    this.config = config;
    this.outputBuffer = new OutputBuffer(1000, logPath, bootstrapPattern);
  }

  /**
   * Spawn Claude Code in a PTY process.
   *
   * @param mode 'fresh' for new conversation, 'continue' for preserving history
   * @param prompt The startup or continue prompt to pass to Claude
   */
  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    if (this.pty) {
      throw new Error('PTY already spawned. Kill first.');
    }
    this._awaitingInteractiveConfirmation = false;
    // One AgentPTY instance can respawn multiple child processes. Bootstrap
    // readiness is monotonic only within a child lifecycle, so discard the
    // previous child's ring and latch before admitting output from the next.
    this.outputBuffer.clear();

    const explicitSkip = this.config.dangerously_skip_permissions;
    let effectiveSkip = explicitSkip;
    if (explicitSkip === undefined && this.isClaudeCodeRuntime()) {
      // Derived state must never be written into the store that distinguishes explicit from absent.
      effectiveSkip = readUnattendedConsent(this.env.frameworkRoot);
    }

    // Repair the installed helper at every spawn boundary. npm can replace the
    // package after this instance has cached node-pty's spawn function.
    this.spawnFn = this.prepareSpawnFn(this.spawnFn);

    const configuredCwd = this.config.working_directory;
    if (configuredCwd !== undefined && configuredCwd !== '') {
      const trimmed = configuredCwd.trim();
      if (trimmed === '') {
        throw new Error(`[agent-pty] ${this.env.agentName}: working_directory is whitespace-only; set a valid path or remove it`);
      }
      if (!existsSync(trimmed)) {
        throw new Error(`[agent-pty] ${this.env.agentName}: working_directory does not exist: ${trimmed}`);
      }
    }
    const cwd = (configuredCwd && configuredCwd.trim()) || this.env.agentDir || process.cwd();

    // Build environment variables for the PTY process
    const ptyEnv: Record<string, string> = {
      ...this.getBaseEnv(),
      CTX_INSTANCE_ID: this.env.instanceId,
      CTX_ROOT: this.env.ctxRoot,
      CTX_FRAMEWORK_ROOT: this.env.frameworkRoot,
      CTX_AGENT_NAME: this.env.agentName,
      CTX_ORG: this.env.org,
      CTX_AGENT_DIR: this.env.agentDir,
      CTX_PROJECT_ROOT: this.env.projectRoot,
      // Backward compat
      CRM_AGENT_NAME: this.env.agentName,
      CRM_TEMPLATE_ROOT: this.env.frameworkRoot,
    };

    // Source org-level shared secrets (orgs/{org}/secrets.env).
    // These are shared across all agents in the org: OPENAI_KEY, APIFY_TOKEN, GEMINI_API_KEY, etc.
    // Agent .env is loaded after and overrides org values — agent-specific keys win.
    // parseEnvFileStrict (utils/env.ts) shares the canonical parser — it strips
    // surrounding quotes, tolerates a UTF-8 BOM, and handles CRLF. The hand-rolled
    // loops that used to live here did none of that, so a QUOTED value reached the
    // agent with its quote characters still attached, which made quoting unusable
    // as a fix for values containing shell metacharacters (2026-08-13 secrets.env
    // DATABASE_URL: a bare `&` breaks every `source` of the file).
    //
    // STRICT, not the tolerant `parseEnvFile`, and the distinction is load-bearing.
    // The replaced loops used a bare readFileSync, so a present-but-unreadable
    // secrets file (EACCES, EISDIR) threw and the agent refused to start. The
    // tolerant reader returns {} instead, which would spawn the agent with its
    // secrets silently absent — BOT_TOKEN missing, failing later as something
    // unrecognisable. Startup must keep failing loudly here.
    if (this.env.org && this.env.projectRoot) {
      const orgEnvFile = join(this.env.projectRoot, 'orgs', this.env.org, 'secrets.env');
      if (existsSync(orgEnvFile)) {
        Object.assign(ptyEnv, parseEnvFileStrict(orgEnvFile, { stripInlineComments: false }));
      }
    }

    // Source agent .env file (overrides org secrets.env for same key names).
    // Contains agent-specific secrets: BOT_TOKEN, CHAT_ID, CLAUDE_CODE_OAUTH_TOKEN.
    // Strict for the same reason as above.
    const agentEnvFile = join(this.env.agentDir, '.env');
    if (existsSync(agentEnvFile)) {
      Object.assign(ptyEnv, parseEnvFileStrict(agentEnvFile, { stripInlineComments: false }));
    }

    // Add convenience CTX_* aliases used throughout agent templates.
    // CTX_TELEGRAM_CHAT_ID: alias for CHAT_ID from the agent's .env
    if (ptyEnv['CHAT_ID']) {
      ptyEnv['CTX_TELEGRAM_CHAT_ID'] = ptyEnv['CHAT_ID'];
    }
    // CTX_TIMEZONE: from config.json timezone field, falls back to system TZ
    const configTimezone = this.config.timezone;
    if (configTimezone) {
      ptyEnv['CTX_TIMEZONE'] = configTimezone;
      ptyEnv['TZ'] = configTimezone; // also set TZ so date/time system calls use correct zone
    } else if (process.env.TZ) {
      ptyEnv['CTX_TIMEZONE'] = process.env.TZ;
    }
    // CTX_ORCHESTRATOR_AGENT: read from org context.json so agents can route to orchestrator
    if (this.env.projectRoot && this.env.org) {
      try {
        const contextPath = join(this.env.projectRoot, 'orgs', this.env.org, 'context.json');
        if (existsSync(contextPath)) {
          const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
          if (ctx.orchestrator) {
            ptyEnv['CTX_ORCHESTRATOR_AGENT'] = ctx.orchestrator;
          }
        }
      } catch { /* leave unset if context.json is missing or malformed */ }
    }

    this.customizeEnv(ptyEnv);

    // Spawn the agent binary directly (no shell wrapper) — cross-platform, no shell escaping needed.
    // env is passed natively via node-pty options; no bash export commands required.
    // On Windows, npm global installs create .cmd wrappers, not .exe binaries.
    // node-pty's CreateProcess requires the exact wrapper name to resolve correctly.
    const effectiveConfig = effectiveSkip === undefined
      ? this.config
      : { ...this.config, dangerously_skip_permissions: effectiveSkip };
    const claudeArgs = this.buildClaudeArgs(mode, prompt, effectiveConfig);
    const claudeCmd = this.getBinaryName();

    // Apply vendor adapter's env filter — strips CLAUDE_* env vars before
    // spawning non-Anthropic binaries so CLAUDE_CODE_SKIP_*_AUTH leakage
    // doesn't corrupt Codex/Gemini auth detection. Anthropic adapter is a
    // no-op pass-through. HermesPTY uses default config.vendor (anthropic),
    // so its env is unchanged.
    const filteredEnv = loadAdapter(this.config.vendor).envFilter(ptyEnv);

    const handlesClaudeTrustPrompts = this.isClaudeCodeRuntime();
    if (handlesClaudeTrustPrompts) {
      try {
        ensureFolderTrusted(cwd);
      } catch (error) {
        console.warn(`[claude-preflight] unexpected folder trust failure; spawn will continue: ${String(error)}`);
      }
      if (effectiveSkip !== false) {
        try {
          ensureBypassPromptSuppressed();
        } catch (error) {
          console.warn(`[claude-preflight] unexpected bypass suppression failure; spawn will continue: ${String(error)}`);
        }
      }
    }

    this.pty = this.spawnFn!(claudeCmd, claudeArgs, {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd,
      env: filteredEnv,
    });

    this._alive = true;

    // Set up output capture
    this.pty.onData((data: string) => {
      this.outputBuffer.push(data);
    });

    // Set up exit handler
    this.pty.onExit(({ exitCode, signal }) => {
      this._alive = false;
      this.pty = null;
      // Flush any held-back partial-JWT tail — the stream is over, so the
      // hold can never be resolved by a next chunk. Writes an explicit
      // marker (or the bare prefix fragment) instead of dropping bytes.
      this.outputBuffer.close();
      // Cancel pending trust-prompt timers — the PTY they targeted is gone,
      // and they must not fire against a future respawn on this instance.
      this.clearTrustPromptTimers();
      if (this.onExitHandler) {
        this.onExitHandler(exitCode, signal);
      }
    });

    // Claude Code can show two startup gates:
    //   1. Folder trust defaults to accept, so Enter confirms it.
    //   2. Bypass Permissions defaults to "No, exit", so bare Enter kills the process.
    // Retry through 32s while a gate remains visible, with a hard answer cap.
    this.promptAnswerSent = false;
    this.promptOutputCursor = this.outputBuffer.createSafeCursor();
    this.bypassAnswerCount = 0;
    if (handlesClaudeTrustPrompts) {
      for (const delayMs of [5000, 8000, 11000, 14000, 20000, 26000, 32000]) {
        const timer = setTimeout(() => {
          if (!this.pty || this.outputBuffer.isBootstrapped()) return;
          const candidate = this.promptAnswerSent
            ? this.outputBuffer.getSafeTailSince(this.promptOutputCursor, 4096)
            : this.outputBuffer.getRecentTail(4096);
          const tail = stripAnsi(candidate);
          const lower = tail.toLowerCase();
          try {
            const bypassGateVisible =
              tail.includes('Yes, I accept')
              || tail.includes('running in Bypass Permissions mode');
            if (bypassGateVisible && effectiveSkip !== false) {
              if (this.bypassAnswerCount >= 3) return;
              // Bypass Permissions defaults to exit. Move to accept, then confirm.
              this.pty.write('\x1b[B\r');
              this.bypassAnswerCount += 1;
              this.promptAnswerSent = true;
              this.promptOutputCursor = this.outputBuffer.createSafeCursor();
              return;
            }
            const trustGateVisible =
              (lower.includes('trust this folder') ||
                lower.includes('trust this directory') ||
                lower.includes('trust the files in this folder')) &&
              (lower.includes('yes') || lower.includes('proceed'));
            if (trustGateVisible) {
              // Folder trust defaults to accept. Down+Enter would select exit here.
              this.pty.write('\r');
              this.promptAnswerSent = true;
              this.promptOutputCursor = this.outputBuffer.createSafeCursor();
            }
          } catch {
            // PTY torn down between the alive check and the write. Ignore it.
          }
        }, delayMs);
        this.trustPromptTimers.push(timer);
      }

      const backstop = setTimeout(() => {
        if (!this.pty || this.outputBuffer.isBootstrapped()) return;
        const tail = stripAnsi(this.outputBuffer.getRecentTail(4096));
        const promptVisible =
          tail.includes('No, exit') ||
          tail.includes('dangerously') ||
          tail.includes('Bypass Permissions') ||
          tail.includes('trust this folder') ||
          tail.includes('trust this directory');
        if (promptVisible) {
          this._awaitingInteractiveConfirmation = true;
          console.warn(`[agent-pty] ${this.env.agentName}: awaiting interactive confirmation — first-run prompt still showing at backstop`);
        }
      }, 45_000);
      this.trustPromptTimers.push(backstop);
    }
  }

  /**
   * Whether the binary this PTY will spawn is Claude Code. Derived from
   * getBinaryName() -- the same value that decides what actually spawns -- so
   * runtimes that override the binary (Hermes -> 'hermes', OpenCode ->
   * 'opencode') and vendor adapters that spawn codex/gemini are excluded
   * automatically, with no per-subclass opt-out to forget.
   *
   * Gates BOTH Claude-only spawn behaviors:
   *   1. the claude-preflight config writes (~/.claude.json folder trust,
   *      ~/.claude/settings.json bypass-prompt suppression), and
   *   2. the trust/bypass prompt auto-accept timers, whose loose substring
   *      match must never fire a stray keypress into a non-Claude TUI
   *      (the hazard HermesPTY previously opted out of by override).
   */
  protected isClaudeCodeRuntime(): boolean {
    const binary = basename(this.getBinaryName()).toLowerCase();
    return binary === 'claude' || binary === 'claude.cmd' || binary === 'claude.exe';
  }

  private clearTrustPromptTimers(): void {
    for (const timer of this.trustPromptTimers) {
      clearTimeout(timer);
    }
    this.trustPromptTimers = [];
  }

  /**
   * Returns the binary name for the agent process.
   * Protected so HermesPTY can override to return 'hermes'.
   * Default delegates to the configured vendor adapter (anthropic by default).
   */
  protected getBinaryName(): string {
    const adapterBinary = loadAdapter(this.config.vendor).binary;
    const isClaudeAdapter = adapterBinary === 'claude' || adapterBinary === 'claude.cmd';
    if (platform() !== 'win32' || !isClaudeAdapter) {
      return adapterBinary;
    }

    // Newer Windows Claude Code installs can ship only claude.exe with no
    // claude.cmd shim. Probe PATH and prefer .exe when present.
    //
    // Loop order: outer = PATH dirs, inner = extensions. This preserves
    // Windows command-resolution precedence (directory order first,
    // PATHEXT order within each directory). The inverted form would return
    // a later-PATH .exe over an earlier-PATH .cmd shim, which can launch
    // the wrong binary on installs that intentionally use a .cmd wrapper.
    const pathDirs = (process.env.PATH || '').split(';').filter(Boolean);
    for (const dir of pathDirs) {
      for (const ext of ['.exe', '.cmd']) {
        if (existsSync(join(dir, `claude${ext}`))) {
          return `claude${ext}`;
        }
      }
    }

    // Fall back to the legacy wrapper name so the missing-file surface remains
    // recognizable if neither binary is on PATH.
    return 'claude.cmd';
  }

  /**
   * Build the CLI argument array.
   * Returns args suitable for passing directly to node-pty spawn (no shell escaping needed).
   * Protected so HermesPTY can override this for its own spawn args.
   * Default delegates to the configured vendor adapter (anthropic by default).
   */
  protected buildClaudeArgs(
    mode: 'fresh' | 'continue',
    prompt: string,
    config: AgentConfig = this.config,
  ): string[] {
    const adapter = loadAdapter(config.vendor);
    return adapter.buildArgs(mode, prompt, { config, env: this.env });
  }

  /**
   * Runtime-specific env hook. Subclasses such as OpencodePTY use this to add
   * CLI-specific isolation variables while keeping AgentPTY's shared cortextOS
   * env/secrets loading path in one place.
   */
  protected customizeEnv(_env: Record<string, string>): void {
    // Default Claude Code runtime has no extra env.
  }

  /**
   * Write data to the PTY.
   */
  write(data: string): void {
    if (!this.pty) {
      throw new Error('PTY not spawned');
    }
    this.pty.write(data);
  }

  /**
   * Inject a complete inbound message into the runtime.
   *
   * Claude Code accepts bracketed paste reliably, so the base implementation
   * keeps the historical shared injector. Runtime subclasses can override this
   * when their TUI has different paste semantics.
   */
  injectMessage(content: string): void {
    injectMessageIntoPty((data) => this.write(data), content);
  }

  /**
   * Kill the PTY process.
   */
  kill(): void {
    // Cancel pending trust-prompt timers unconditionally — even if the PTY
    // is already gone, stale timers must not survive into a respawn.
    this.clearTrustPromptTimers();
    const pty = this.pty;
    if (pty) {
      this._alive = false;
      this.pty = null;
      try {
        pty.kill();
      } catch {
        // The process may have exited between the null-check and the kill;
        // a throw here must not propagate into stop()/restart paths.
      }
      // Belt-and-suspenders: onExit normally fires after kill and flushes
      // the held tail, but if the event loop tears down first (daemon
      // shutdown) the hold would be lost. close() is idempotent, so the
      // subsequent onExit flush is a no-op.
      this.outputBuffer.close();
    }
  }

  /**
   * Check if the PTY process is alive.
   * Uses an internal flag set by the onExit handler — cross-platform safe.
   * (process.kill(pid, 0) is unreliable on Windows.)
   */
  isAlive(): boolean {
    return this._alive && this.pty !== null;
  }

  /**
   * Get the PTY PID.
   */
  getPid(): number | null {
    return this.pty?.pid || null;
  }

  /**
   * Register an exit handler.
   */
  onExit(handler: (exitCode: number, signal?: number) => void): void {
    this.onExitHandler = handler;
  }

  /**
   * Get the output buffer for inspection.
   */
  getOutputBuffer(): OutputBuffer {
    return this.outputBuffer;
  }

  isAwaitingInteractiveConfirmation(): boolean {
    return this._awaitingInteractiveConfirmation && !this.outputBuffer.isBootstrapped();
  }

  /**
   * Get a clean base environment (excluding potentially harmful vars).
   */
  private getBaseEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    // Copy essential env vars
    const keepVars = [
      'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
      'TMPDIR', 'TEMP', 'TMP', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY',
      'NODE_PATH', 'COMSPEC', 'USERPROFILE',
      // HERMES_HOME: without this the child could NEVER inherit the daemon's
      // value, while AgentProcess.resolveHermesHome() falls back to it when no
      // env file supplies one — so the daemon probed a state.db the child would
      // never use. Passing it through makes the daemon's documented
      // process.env fallback true for the child as well. See resolveHermesHome.
      'HERMES_HOME',
      // Windows path-expansion essentials.
      'SystemDrive', 'SystemRoot', 'windir',
      'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ALLUSERSPROFILE',
      'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
      'HOMEDRIVE', 'HOMEPATH', 'PUBLIC',
    ];
    for (const key of keepVars) {
      if (process.env[key]) {
        env[key] = process.env[key]!;
      }
    }

    // Windows: ensure UTF-8 locale so emoji and Unicode pass through the PTY
    if (platform() === 'win32') {
      if (!env['LANG']) env['LANG'] = 'en_US.UTF-8';
      if (!env['LC_ALL']) env['LC_ALL'] = 'en_US.UTF-8';
      if (!process.env['PYTHONIOENCODING']) env['PYTHONIOENCODING'] = 'utf-8';
    }

    return env;
  }
}
