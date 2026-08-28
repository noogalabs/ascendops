import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { AgentPTY } from './agent-pty.js';

// Hermes bootstrap signal: the prompt character that appears when Hermes is
// ready for input. The full prompt is "⚔ ❯ " but we check for "❯" as a
// substring since terminal themes may vary. Braille spinner frames and other
// output never contain "❯" so this is a clean idle signal.
const HERMES_BOOTSTRAP_PATTERN = '❯';

// Startup prompt file written to the agent dir and read by Hermes at boot.
// Using a file avoids bracketed paste (ESC[200~) which is buggy in Hermes
// (NousResearch/hermes-agent issue #7316 — leaked markers corrupt input).
const STARTUP_PROMPT_FILE = '.cortextos-startup.md';

/**
 * PTY wrapper for Hermes agents (NousResearch/hermes-agent, Python REPL).
 *
 * Key differences from Claude Code (AgentPTY):
 * - Binary: `hermes` (not `claude`)
 * - Session continuity: `--continue` flag when ~/.hermes/state.db exists
 * - No positional prompt arg: startup prompt written to a temp file and
 *   injected as a short read command after the `❯` prompt appears
 * - Bootstrap signal: `❯` in output (not Claude Code's "permissions" status bar)
 * - No trust-folder prompt: Hermes doesn't ask for folder trust on first run
 * - Exit: Ctrl+D (`\x04`), not `/exit\r\n`
 * - No `--dangerously-skip-permissions` or `--model` flags
 */
export class HermesPTY extends AgentPTY {
  private startupPrompt: string = '';
  private agentDir: string;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string) {
    super(env, config, logPath, HERMES_BOOTSTRAP_PATTERN);
    // Store agentDir here since AgentPTY.env is private
    this.agentDir = config.working_directory || env.agentDir;
  }

  /**
   * Returns the hermes binary name.
   * Hermes is a Python package installed via pip — no .cmd wrapper on Windows.
   */
  protected getBinaryName(): string {
    return 'hermes';
  }

  /**
   * Hermes never shows a trust-folder prompt (see class-level comment), so
   * the base class's auto-accept timers must not run. Their loose
   * "Yes"/"trust" substring match against recent output would fire a stray
   * Enter at the 5s/8s marks — right when the startup-file read command has
   * just been injected — and could submit a partial or empty line.
   */
  protected needsTrustPromptAutoAccept(): boolean {
    return false;
  }

  /**
   * Build Hermes CLI args.
   *
   * Hermes session continuity: if ~/.hermes/state.db exists, pass --continue
   * to resume the last session. The SQLite DB persists conversation history
   * across daemon restarts (unlike Claude Code's .jsonl files which live in
   * the working dir).
   *
   * No positional prompt: the startup prompt is injected post-boot via a
   * temp file to avoid bracketed paste issues (see class-level comment).
   */
  protected buildClaudeArgs(mode: 'fresh' | 'continue', _prompt: string): string[] {
    // mode='continue' means shouldContinue() returned true — Hermes DB exists.
    // We pass --continue so Hermes resumes the last session.
    if (mode === 'continue') {
      return ['--continue'];
    }
    return [];
  }

  /**
   * Override spawn to write the startup prompt to a temp file and inject it
   * after Hermes boots to the `❯` prompt.
   *
   * We cannot pass the startup prompt as a CLI arg (Hermes has no such flag)
   * and bracketed paste is buggy in Hermes (issue #7316). Instead:
   *   1. Write prompt to .cortextos-startup.md in the agent dir
   *   2. Spawn Hermes normally
   *   3. After `❯` appears (isBootstrapped), inject a single-line read command
   */
  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    this.startupPrompt = prompt;
    // Write startup prompt to temp file BEFORE spawn so Hermes can read it
    this.writeStartupFile(prompt);
    // Spawn Hermes (base class handles PTY setup, env injection, exit handler)
    await super.spawn(mode, prompt);
    // After `❯` appears, inject the read command — base class spawn() returns
    // as soon as the PTY is set up, not when Hermes is ready. We schedule
    // the injection asynchronously so spawn() can return quickly.
    this.scheduleStartupInjection();
  }

  /**
   * Write the startup prompt to a temp file in the agent directory.
   * The file is gitignored (.cortextos-startup.md is in .gitignore by convention).
   */
  private writeStartupFile(prompt: string): void {
    const filePath = join(this.agentDir, STARTUP_PROMPT_FILE);
    try {
      writeFileSync(filePath, prompt, 'utf-8');
    } catch (err) {
      // Non-fatal for the spawn itself, but a STALE startup file from a
      // previous boot may still be on disk. Remove it so the injected read
      // command fails loudly ("file not found") instead of Hermes silently
      // following OUTDATED instructions (e.g. a prior session's recovery
      // note or continue prompt).
      console.error(`[hermes-pty] Failed to write startup file: ${err}`);
      try {
        unlinkSync(filePath);
      } catch {
        // Nothing stale to remove (or it is equally unreachable) — fine.
      }
    }
  }

  /**
   * Wait for Hermes's `❯` prompt, then inject the startup instruction.
   * Runs in the background — does not block spawn().
   */
  private scheduleStartupInjection(): void {
    this.waitForPromptThenInject().catch(err => {
      console.error(`[hermes-pty] Startup injection failed (non-fatal): ${err}`);
    });
  }

  private async waitForPromptThenInject(timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // If the PTY died (crash, kill, restart) while we were waiting,
      // abort: this loop belongs to a dead session, and writing to a null
      // PTY would throw. Crash recovery spawns a NEW HermesPTY instance
      // with its own injection schedule.
      if (!this.isAlive()) {
        console.error('[hermes-pty] PTY exited before startup injection — skipping');
        return;
      }
      if (this.getOutputBuffer().isBootstrapped()) {
        // `❯` appeared — Hermes is ready. Inject the read command.
        this.injectStartupCommand();
        return;
      }
      await sleep(500);
    }
    // Timeout: Hermes took too long to boot. Inject anyway (if still alive)
    // and let the REPL handle it whenever it becomes ready.
    if (this.isAlive()) {
      this.injectStartupCommand();
    } else {
      console.error('[hermes-pty] PTY exited during bootstrap wait — startup injection skipped');
    }
  }

  /**
   * Write the startup read command to the PTY. write() throws if the PTY
   * has been torn down between the alive-check and the write — that race
   * must not surface as an unhandled rejection in the daemon, so it is
   * caught and logged here.
   */
  private injectStartupCommand(): void {
    try {
      this.write(`Read ${STARTUP_PROMPT_FILE} and follow the instructions there.\r`);
    } catch (err) {
      console.error(`[hermes-pty] Startup injection write failed (PTY torn down?): ${err}`);
    }
  }

}

/**
 * Check whether a Hermes session database exists.
 * Used by AgentProcess.shouldContinue() to decide whether to pass --continue.
 * Respects HERMES_HOME environment variable (set in agent .env if non-standard).
 */
export function hermesDbExists(hermesHome?: string): boolean {
  const base = hermesHome || join(homedir(), '.hermes');
  return existsSync(join(base, 'state.db'));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
