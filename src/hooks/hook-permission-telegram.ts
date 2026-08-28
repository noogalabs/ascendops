
/**
 * hook-permission-telegram.ts - Blocking PermissionRequest hook
 * Forwards permission prompts to Telegram with Approve/Deny inline buttons.
 * Polls for a response file written by fast-checker when the user taps a button.
 * Timeout: 1800s (30 min, deny by default).
 */

import { TelegramAPI } from '../telegram/api';
import {
  readStdin,
  parseHookInput,
  loadEnv,
  outputDecision,
  generateId,
  waitForResponseFile,
  formatToolSummary,
  isClaudeDirOperation,
  sanitizeCodeBlock,
  buildPermissionKeyboard,
  cleanupResponseFile,
} from './index';
import { join } from 'path';
import { mkdirSync } from 'fs';

import { hookBootstrap } from './bootstrap.js';
async function main(): Promise<void> {
  // PROCESS LINEAGE IS NOT INTENT — see bootstrap.ts.
  // main() is invoked at module scope below, so importing a hook module runs
  // hookBootstrap(). Shared validators live in skill-validators.ts specifically
  // so bus code never imports a hook module merely to reuse its exports; that
  // extraction, not main() placement, fixed the credential-loss regression.
  hookBootstrap();
  const input = await readStdin();
  const { tool_name, tool_input } = parseHookInput(input);

  // ExitPlanMode and AskUserQuestion are handled by other hooks
  if (tool_name === 'ExitPlanMode' || tool_name === 'AskUserQuestion') {
    process.exit(0);
  }

  const env = loadEnv();

  if (!env.botToken || !env.chatId) {
    outputDecision('deny', 'No Telegram credentials configured for remote approval');
    return;
  }

  // Auto-approve .claude/ directory writes
  if (isClaudeDirOperation(tool_name, tool_input)) {
    outputDecision('allow');
    return;
  }

  // Build human-readable summary
  const summary = formatToolSummary(tool_name, tool_input);

  // Generate unique ID
  const uniqueId = generateId();
  mkdirSync(env.stateDir, { recursive: true });
  const responseFile = join(env.stateDir, `hook-response-${uniqueId}.json`);

  // Register cleanup
  const cleanup = () => cleanupResponseFile(responseFile);
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(1); });
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  // Build message
  let message = `PERMISSION REQUEST\nAgent: ${env.agentName}\nTool: ${tool_name}\n\n\`\`\`\n${sanitizeCodeBlock(summary)}\n\`\`\``;

  // Truncate if over limit
  if (message.length > 3800) {
    message = message.slice(0, 3800) + '...(truncated)';
  }

  const keyboard = buildPermissionKeyboard(uniqueId);
  const api = new TelegramAPI(env.botToken);

  try {
    await api.sendMessage(env.chatId, message, keyboard);
  } catch {
    outputDecision('deny', 'Failed to send permission request to Telegram');
    return;
  }

  // Poll for response (30 min timeout)
  const TIMEOUT_MS = 1800 * 1000;
  const content = await waitForResponseFile(responseFile, TIMEOUT_MS);

  if (content !== null) {
    try {
      const response = JSON.parse(content);
      const decision = response.decision || 'deny';
      if (decision === 'allow') {
        outputDecision('allow');
      } else {
        outputDecision('deny', 'Denied by user via Telegram');
      }
    } catch {
      outputDecision('deny', 'Invalid response file');
    }
  } else {
    // Timeout - deny and notify
    try {
      await api.sendMessage(
        env.chatId,
        `Permission request TIMED OUT (auto-denied): ${tool_name}`,
      );
    } catch {
      // Ignore notification failure
    }
    outputDecision('deny', 'Timed out waiting for Telegram approval (30m)');
  }
}

main().catch((err) => {
  process.stderr.write(`hook-permission-telegram error: ${err}\n`);
  outputDecision('deny', `Hook error: ${err}`);
});
