/**
 * Stop hook - writes a Unix timestamp to last_idle.flag.
 *
 * Used by fast-checker to determine whether the agent is currently "working"
 * on a response to a Telegram message (for the typing indicator).
 *
 * Logic in fast-checker:
 *   typing = last_message_injected > last_idle AND within 10 min
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { hookBootstrap } from './bootstrap.js';
async function main(): Promise<void> {
  // PROCESS LINEAGE IS NOT INTENT — see bootstrap.ts.
  // main() is invoked at module scope below, so importing a hook module runs
  // hookBootstrap(). Shared validators live in skill-validators.ts specifically
  // so bus code never imports a hook module merely to reuse its exports; that
  // extraction, not main() placement, fixed the credential-loss regression.
  hookBootstrap();
  const agentName = process.env.CTX_AGENT_NAME;
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  if (!agentName) return;

  const stateDir = join(homedir(), '.cortextos', instanceId, 'state', agentName);
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'last_idle.flag'), String(Math.floor(Date.now() / 1000)), 'utf-8');
  } catch { /* ignore */ }
}

main().catch(() => process.exit(0));
