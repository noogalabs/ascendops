import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, basename, resolve as resolvePath, sep } from 'path';
import { homedir } from 'os';
import type { CtxEnv } from '../types/index.js';
import { ensureDir } from './atomic.js';
import { validateAgentName, validateOrgName } from './validate.js';
import { stripBom } from './strip-bom.js';

import { randomString } from './random.js';
/**
 * Resolve the cortextOS environment context.
 * Equivalent of bash _ctx-env.sh - reads from env vars, .cortextos-env, .env files.
 */
export function resolveEnv(overrides?: Partial<CtxEnv>): CtxEnv {
  // Priority: overrides > env vars > .cortextos-env file > defaults

  // Try reading .cortextos-env from cwd
  let envFile: Record<string, string> = {};
  const cortextosEnvPath = join(process.cwd(), '.cortextos-env');
  if (existsSync(cortextosEnvPath)) {
    envFile = parseEnvFile(cortextosEnvPath);
  }

  const instanceId =
    overrides?.instanceId ||
    process.env.CTX_INSTANCE_ID ||
    envFile.CTX_INSTANCE_ID ||
    'default';

  const ctxRoot =
    overrides?.ctxRoot ||
    process.env.CTX_ROOT ||
    envFile.CTX_ROOT ||
    join(homedir(), '.cortextos', instanceId);

  const frameworkRoot =
    overrides?.frameworkRoot ||
    process.env.CORTEXTOS_DIR ||
    process.env.CTX_FRAMEWORK_ROOT ||
    envFile.CTX_FRAMEWORK_ROOT ||
    '';

  const agentName =
    overrides?.agentName ||
    process.env.CTX_AGENT_NAME ||
    envFile.CTX_AGENT_NAME ||
    basename(process.cwd());

  const org =
    overrides?.org ||
    process.env.CTX_ORG ||
    envFile.CTX_ORG ||
    '';

  const projectRoot =
    overrides?.projectRoot ||
    process.env.CORTEXTOS_DIR ||
    process.env.CTX_PROJECT_ROOT ||
    envFile.CTX_PROJECT_ROOT ||
    '';

  // Resolve agent directory
  let agentDir =
    overrides?.agentDir ||
    process.env.CTX_AGENT_DIR ||
    envFile.CTX_AGENT_DIR ||
    '';

  if (!agentDir && org && projectRoot) {
    agentDir = join(projectRoot, 'orgs', org, 'agents', agentName);
  } else if (!agentDir && projectRoot) {
    agentDir = join(projectRoot, 'agents', agentName);
  }

  // Resolve timezone and orchestrator from org context.json
  let timezone = overrides?.timezone || process.env.CTX_TIMEZONE || '';
  let orchestrator = overrides?.orchestrator || process.env.CTX_ORCHESTRATOR || '';

  if ((!timezone || !orchestrator) && org && projectRoot) {
    try {
      const contextPath = join(projectRoot, 'orgs', org, 'context.json');
      if (existsSync(contextPath)) {
        // stripBom: PowerShell/Notepad-saved context.json files have a BOM
        // that breaks JSON.parse at position 0 — silent fallback to wrong
        // timezone/orchestrator. See src/utils/strip-bom.ts for incident.
        const ctx = JSON.parse(stripBom(readFileSync(contextPath, 'utf-8')));
        if (!timezone && ctx.timezone) timezone = ctx.timezone;
        if (!orchestrator && ctx.orchestrator) orchestrator = ctx.orchestrator;
      }
    } catch { /* ignore */ }
  }

  // Sandbox/live isolation (issue #313): when both CTX_FRAMEWORK_ROOT and CTX_AGENT_DIR
  // are set, the resolved agentDir MUST be subordinate to frameworkRoot. Catches the leak
  // class where a CLI subprocess inherits CTX_AGENT_DIR (or CTX_PROJECT_ROOT) from a live
  // agent shell while only CTX_FRAMEWORK_ROOT was overridden — agentDir then silently
  // points at the live install. Equality check on projectRoot vs frameworkRoot catches
  // the same divergence on the projectRoot axis.
  if (agentDir && frameworkRoot) {
    const fwRootResolved = resolvePath(frameworkRoot);
    const agentDirResolved = resolvePath(agentDir);
    if (agentDirResolved !== fwRootResolved && !agentDirResolved.startsWith(fwRootResolved + sep)) {
      throw new Error(
        `Resolved CTX_AGENT_DIR '${agentDir}' is not under CTX_FRAMEWORK_ROOT '${frameworkRoot}'. ` +
        `This indicates a sandbox/live environment leak — likely CTX_FRAMEWORK_ROOT was overridden ` +
        `but CTX_AGENT_DIR or CTX_PROJECT_ROOT was inherited from the parent shell. ` +
        `Refusing to proceed.`,
      );
    }
  }
  if (projectRoot && frameworkRoot && resolvePath(projectRoot) !== resolvePath(frameworkRoot)) {
    throw new Error(
      `CTX_PROJECT_ROOT '${projectRoot}' must equal CTX_FRAMEWORK_ROOT '${frameworkRoot}'. ` +
      `A divergence indicates a sandbox/live environment leak — likely one of the two was ` +
      `inherited from the parent shell while the other was overridden. Refusing to proceed.`,
    );
  }

  // Security (H9): Validate agent name and org before they flow into filesystem paths.
  // These come from env vars / .cortextos-env and must match [a-z0-9_-]+.
  if (agentName) {
    try {
      validateAgentName(agentName);
    } catch (err) {
      throw new Error(`CTX_AGENT_NAME is invalid: ${(err as Error).message}`);
    }
  }
  if (org) {
    // Org names from the env may use mixed-case (e.g. AcmeCorp) when the
    // org directory was created before strict lowercase validation was enforced.
    // Only reject values that contain path-traversal characters or whitespace;
    // lowercase enforcement is a CLI-layer concern, not an env-resolution concern.
    if (/[./\\<>|;'"(){}[\] ]/.test(org) || org.includes('..')) {
      throw new Error(`CTX_ORG is invalid: contains unsafe characters`);
    }
  }

  // Per-agent git worktree path (worktree-isolation pattern,
  // the worktree-isolation design).
  // Lives under per-agent state so each specialist gets its own HEAD + index,
  // sharing only the canonical .git/objects/ via git worktree's native linking.
  const agentWorktree =
    overrides?.agentWorktree ||
    process.env.CTX_AGENT_WORKTREE ||
    envFile.CTX_AGENT_WORKTREE ||
    (ctxRoot && agentName ? join(ctxRoot, 'state', 'agents', agentName, 'worktree') : '');

  return { instanceId, ctxRoot, frameworkRoot, agentName, agentDir, org, projectRoot, timezone, orchestrator, agentWorktree };
}

/**
 * Resolve another agent's directory from the caller's environment.
 *
 * Commands that take a target agent argument (e.g. manage-cycle) must
 * operate on the TARGET agent's files, not the caller's — writing to the
 * caller's dir creates a second, diverging registry the target never reads
 * (manage-cycle create was a silent no-op for autoresearch). Targets
 * are resolved as a sibling of the caller's agentDir first (matches every
 * deployment layout), then via the same projectRoot conventions resolveEnv
 * uses. Returns null when no candidate directory exists on disk, so callers
 * can fail loudly instead of writing into a directory no agent reads.
 * Throws on invalid agent names (path-traversal guard).
 */
export function resolveTargetAgentDir(env: CtxEnv, targetAgent: string): string | null {
  validateAgentName(targetAgent);
  if (targetAgent === env.agentName && env.agentDir) {
    return env.agentDir;
  }
  const candidates: string[] = [];
  if (env.agentDir) {
    candidates.push(join(env.agentDir, '..', targetAgent));
  }
  if (env.projectRoot && env.org) {
    candidates.push(join(env.projectRoot, 'orgs', env.org, 'agents', targetAgent));
  }
  if (env.projectRoot) {
    candidates.push(join(env.projectRoot, 'agents', targetAgent));
  }
  for (const candidate of candidates) {
    const dir = resolvePath(candidate);
    if (existsSync(dir)) {
      return dir;
    }
  }
  return null;
}

/**
 * Write .cortextos-env file for backward compatibility with bash bus scripts.
 * Per D6: maintain this pattern.
 */
export function writeCortextosEnv(agentDir: string, env: CtxEnv): void {
  ensureDir(agentDir);
  const lines = [
    `CTX_INSTANCE_ID=${env.instanceId}`,
    `CTX_ROOT=${env.ctxRoot}`,
    `CTX_FRAMEWORK_ROOT=${env.frameworkRoot}`,
    `CTX_AGENT_NAME=${env.agentName}`,
    `CTX_ORG=${env.org}`,
    `CTX_AGENT_DIR=${env.agentDir}`,
    `CTX_PROJECT_ROOT=${env.projectRoot}`,
  ];
  if (env.agentWorktree) {
    lines.push(`CTX_AGENT_WORKTREE=${env.agentWorktree}`);
  }
  writeFileSync(join(agentDir, '.cortextos-env'), lines.join('\n') + '\n', 'utf-8');
}

/**
 * Parse a KEY=VALUE env file. Supports:
 *   - `#` comments at start of line
 *   - Surrounding single or double quotes on the value (stripped)
 *   - Inline ` #` comments on unquoted values
 * Lines with no `=` are skipped.
 */
export function parseEnvFile(
  filePath: string,
  options: ParseEnvOptions = {},
): Record<string, string> {
  try {
    return parseEnvContent(readFileSync(filePath, 'utf-8'), options);
  } catch {
    // Ignore read errors
    return {};
  }
}

export interface ParseEnvOptions {
  /**
   * Strip an inline ` #` comment from an UNQUOTED value. Default `true`.
   *
   * Set `false` where a value may legitimately contain a literal ` #` — a
   * password or token, for instance — and truncating it would silently change
   * a working credential. Callers replacing a parser that did not strip inline
   * comments must pass `false` to preserve their existing semantics; no other
   * env reader in this repo strips them.
   */
  stripInlineComments?: boolean;
}

/**
 * Like {@link parseEnvFile}, but does NOT swallow read errors.
 *
 * Callers that treat a present-but-unreadable env file as a fatal startup
 * condition must use this. `parseEnvFile` returns `{}` on EACCES/EISDIR, which
 * for a secrets file means the process continues with the secrets simply absent
 * — a silent failure that surfaces later as a confusing downstream error rather
 * than at the point the file could not be read.
 *
 * Added 2026-08-13: routing AgentPTY through the tolerant `parseEnvFile` would
 * have converted its startup from fail-loud to fail-open, because the loop it
 * replaced used a bare `readFileSync` that threw.
 */
export function parseEnvFileStrict(
  filePath: string,
  options: ParseEnvOptions = {},
): Record<string, string> {
  return parseEnvContent(readFileSync(filePath, 'utf-8'), options);
}

/**
 * Parse already-read env-file text. Pure — no IO, so the caller owns the
 * failure semantics of reading the file.
 */
export function parseEnvContent(
  raw: string,
  options: ParseEnvOptions = {},
): Record<string, string> {
  const stripInlineComments = options.stripInlineComments ?? true;
  const result: Record<string, string> = {};
  {
    // stripBom + CRLF-aware split: Windows tooling (PowerShell Out-File,
    // Notepad) writes .env files with a UTF-8 BOM at position 0 AND CRLF
    // line endings. Without stripBom the first KEY line never matches
    // because position 0 is the BOM byte; without the regex split, each
    // value gets a trailing \r that breaks downstream validators.
    const content = stripBom(raw);
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue; // no '=' or empty key

      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();

      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      } else if (stripInlineComments) {
        // Unquoted: strip inline comments starting with ' #'
        const hashIdx = value.indexOf(' #');
        if (hashIdx >= 0) {
          value = value.slice(0, hashIdx).trim();
        }
      }

      result[key] = value;
    }
  }
  return result;
}

/**
 * Source a .env file into process.env (for agent environment).
 */
export function sourceEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const vars = parseEnvFile(filePath);
  for (const [key, value] of Object.entries(vars)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

/**
 * The agent-session credential.
 *
 * A heartbeat refresh is a claim that THE AGENT'S OWN SESSION did something.
 * `CTX_AGENT_NAME` cannot carry that claim: it is a LAUNCHER-PROVIDED name that
 * answers "which agent is this ABOUT", never "WHO is running this". The daemon
 * sets it on any subprocess it spawns on an agent's behalf — including the
 * watchdog rollback path, which runs `cortextos bus log-event` with the name of
 * the agent it is rolling back. Using an attribution field as an authentication
 * field is the defect this credential removes.
 *
 * The credential is minted ONLY where an agent session is actually created: the
 * PTY boundary. Nothing else mints it, and it is deliberately absent from every
 * `execFile`/`spawn` that inherits ambient daemon env, so those paths fail
 * closed without anyone having to enumerate them.
 *
 * Fail-closed direction: absence means "do not refresh". A liveness signal that
 * defaults to ON when identity is unknown is not a liveness signal.
 */
export const HEARTBEAT_SESSION_ENV = 'CTX_HEARTBEAT_SESSION';

/**
 * Mint the credential for ONE named agent session. PTY session boundaries only.
 *
 * The value is `<agent>:<nonce>`, not a presence flag. A flag says "some session
 * minted this"; it cannot say WHICH, and a PTY child that changes
 * `CTX_AGENT_NAME` (or exports `BUS_AGENT`, as `bin/quota-resume.sh` does) keeps
 * a flag and can then claim liveness for the agent it borrowed. Binding the
 * minted identity into the value makes the credential a CAPABILITY rather than a
 * flag: it authorises a refresh for exactly one agent, and an identity change
 * without a re-mint authorises nothing.
 *
 * The nonce carries no authority on its own — it exists so the value cannot be
 * hand-constructed from a guessable agent name alone.
 */
export function agentSessionCredential(agentName: string): Record<string, string> {
  return { [HEARTBEAT_SESSION_ENV]: `${agentName}:${randomString(24)}` };
}

/**
 * The agent this process's credential was minted for, or null if there is none
 * or it is malformed. Malformed is null, never a match: fail closed.
 */
export function sessionCredentialAgent(): string | null {
  const raw = process.env[HEARTBEAT_SESSION_ENV];
  if (!raw) return null;
  const split = raw.lastIndexOf(':');
  if (split <= 0) return null;
  const agent = raw.slice(0, split);
  const nonce = raw.slice(split + 1);
  if (!agent || nonce.length < 16) return null;
  return agent;
}

/**
 * Is this process running inside the agent session this write claims to be?
 *
 * Presence is not enough — the credential must have been minted FOR this agent.
 *
 * Reads `process.env` DIRECTLY and does NOT consult `resolveEnv()`. Two reasons,
 * both load-bearing:
 *
 *  - `resolveEnv()` accepts overrides and falls back to `.cortextos-env` on
 *    disk, so a caller could hand it a flag-derived value and be believed. An
 *    authentication check must not read a field its caller can supply.
 *  - it does an `existsSync` and possibly a `readFileSync`, which is filesystem
 *    work on the event-write hot path.
 */
export function hasAgentSessionCredential(actingAgent: string): boolean {
  const minted = sessionCredentialAgent();
  return minted !== null && minted === actingAgent;
}

/** The nonce half of this process's credential, or null if absent or malformed. */
export function sessionCredentialNonce(): string | null {
  const raw = process.env[HEARTBEAT_SESSION_ENV];
  if (!raw) return null;
  const split = raw.lastIndexOf(':');
  if (split <= 0) return null;
  const nonce = raw.slice(split + 1);
  return nonce.length >= 16 ? nonce : null;
}

/**
 * Strip the reserved session credential from anything an env FILE supplies.
 *
 * The credential is minted at the PTY boundary and nowhere else. Config must not
 * be able to set it — not because the mint would lose (it is the last write), but
 * because a config file that TRIES is a misconfiguration worth seeing rather than
 * silently overriding. Two directions, both real:
 *
 *  - a stale non-`1` value would stop a healthy agent refreshing (fails safe,
 *    but pages falsely);
 *  - a configured `1` would mean the credential is no longer PTY-exclusive,
 *    which is the invariant this whole mechanism rests on.
 */
export function stripReservedSessionCredential(
  source: string,
  parsed: Record<string, string>,
): Record<string, string> {
  if (!(HEARTBEAT_SESSION_ENV in parsed)) return parsed;
  const { [HEARTBEAT_SESSION_ENV]: _reserved, ...rest } = parsed;
  console.warn(
    `[env] ignoring reserved ${HEARTBEAT_SESSION_ENV} from ${source} — it is minted only at the PTY session boundary`,
  );
  return rest;
}

/**
 * Remove the reserved session credential from an environment being handed to a
 * NON-SESSION process.
 *
 * Minting only at the PTY boundary is necessary and not sufficient. The
 * credential is an ordinary environment variable, so it propagates by
 * inheritance: an agent session that runs `cortextos start` hands the daemon its
 * whole `process.env`, and every subprocess the daemon later spawns — including
 * the watchdog rollback write this guard exists to stop — inherits it and
 * satisfies the gate.
 *
 * So every boundary that constructs an environment for something that is NOT an
 * agent session strips it. The mint is the only way in; this is the only way it
 * stays that way.
 */
export function stripSessionCredentialFromEnv<T extends Record<string, string | undefined>>(
  env: T,
): T {
  if (!(HEARTBEAT_SESSION_ENV in env)) return env;
  const copy = { ...env };
  delete copy[HEARTBEAT_SESSION_ENV];
  return copy;
}
