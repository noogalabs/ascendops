/**
 * StatusLine hook — writes Claude Code's context window usage to a state file.
 *
 * Configured in settings.json as:
 *   "statusLine": { "type": "command", "command": "cortextos bus hook-context-status",
 *                   "refreshInterval": 5, "timeout": 2 }
 *
 * Claude Code pipes a JSON blob to stdin after every assistant turn (debounced 300ms)
 * and on each refreshInterval tick. We extract the context % and write it atomically
 * so the FastChecker context monitor can read it.
 *
 * Must complete quickly, swallow all errors, and always exit 0 — a failed statusLine
 * hook blocks Claude Code's status bar rendering.
 */

import { statSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { atomicWriteSync } from '../utils/atomic.js';

import { hookBootstrap } from './bootstrap.js';
interface StatusLineInput {
  context_window?: {
    used_percentage?: number | null;
    context_window_size?: number;
    exceeds_200k_tokens?: boolean;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  session_id?: string;
}

async function main(): Promise<void> {
  // PROCESS LINEAGE IS NOT INTENT — see bootstrap.ts.
  // main() is invoked at module scope below, so importing a hook module runs
  // hookBootstrap(). Shared validators live in skill-validators.ts specifically
  // so bus code never imports a hook module merely to reuse its exports; that
  // extraction, not main() placement, fixed the credential-loss regression.
  hookBootstrap();
  const agentName = process.env.CTX_AGENT_NAME;
  if (!agentName) return;

  const ctxRoot = process.env.CTX_ROOT || join(homedir(), '.cortextos', 'default');
  const stateDir = join(ctxRoot, 'state', agentName);
  const outPath = join(stateDir, 'context_status.json');

  // Debounce: skip write if file is younger than 500ms to avoid thrashing during tool loops
  try {
    const mtime = statSync(outPath).mtimeMs;
    if (Date.now() - mtime < 500) return;
  } catch { /* file doesn't exist yet — continue */ }

  // Read stdin (Claude Code pipes the statusLine JSON)
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', resolve);
    process.stdin.on('error', resolve);
    // Timeout safety: don't block forever
    setTimeout(resolve, 1500);
  });

  let data: StatusLineInput = {};
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch { return; }

  const cw = data.context_window;
  if (!cw) return;

  const payload = JSON.stringify({
    used_percentage: typeof cw.used_percentage === 'number' ? cw.used_percentage : null,
    context_window_size: cw.context_window_size ?? null,
    exceeds_200k_tokens: Boolean(cw.exceeds_200k_tokens),
    current_usage: cw.current_usage ?? null,
    session_id: data.session_id ?? null,
    written_at: new Date().toISOString(),
  });

  mkdirSync(stateDir, { recursive: true });
  atomicWriteSync(outPath, payload);
}

main().catch(() => process.exit(0));
