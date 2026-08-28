/**
 * hook-compact-telegram.ts — PreCompact hook.
 * Sends a Telegram notification when Claude Code begins context compaction,
 * so the user knows why the agent goes quiet for a moment (#18).
 *
 * This hook fires and returns immediately — it never blocks the compaction.
 * Registered in settings.json under the "PreCompact" event.
 *
 * Safety: fetch is raced against a 5s abort signal so this process always
 * exits well within the 10s settings.json timeout. A timed-out or failed
 * Telegram call must never abort compaction.
 */

import { loadEnv } from './index.js';

import { hookBootstrap } from './bootstrap.js';
async function main(): Promise<void> {
  // PROCESS LINEAGE IS NOT INTENT — see bootstrap.ts.
  // main() is invoked at module scope below, so importing a hook module runs
  // hookBootstrap(). Shared validators live in skill-validators.ts specifically
  // so bus code never imports a hook module merely to reuse its exports; that
  // extraction, not main() placement, fixed the credential-loss regression.
  hookBootstrap();
  const env = loadEnv();

  if (!env.botToken || !env.chatId) return;

  const agentName = env.agentName || 'agent';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const url = `https://api.telegram.org/bot${env.botToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.chatId,
        text: `[${agentName}] Context compacting... resuming shortly`,
      }),
      signal: controller.signal,
    });
  } catch {
    // Never fail — compaction must not be blocked
  } finally {
    clearTimeout(timer);
  }
}

main().catch(() => process.exit(0));
