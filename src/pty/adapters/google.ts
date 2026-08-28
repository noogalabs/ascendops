// Gemini CLI vendor adapter — migration step #3 of multi-model adapter MVP.
// Sources: internal design docs §4 + CAO
// gemini_cli.py reference (~/cortextos-reference/cli-agent-orchestrator).
//
// Constants per delta doc §4 + CAO patterns:
//   - binary: 'gemini'
//   - bypass flags: --yolo --sandbox false (verified against CAO line 215;
//     --yolo is documented per CAO header comment line 14)
//   - pasteEnterCount: 2 (Gemini Ink renderer needs double-Enter, same as Claude)
//   - extractionRetries: 2 (Ink notification spinners can obscure response 10–15s)
//   - envFilter: strip CLAUDE_* (esp CLAUDE_CODE_SKIP_*_AUTH; corrupts Gemini auth)
//
// Continue mode: Gemini CLI has NO documented session-resume flag (verified
// against CAO gemini_cli.py — they always spawn fresh and manage session
// continuity at the tmux/conversation layer). Adapter falls back to fresh on
// mode='continue' rather than throwing — keeps the AgentPTY contract intact;
// the trade-off is that a Gemini agent restart loses conversation history.
// Revisit when Gemini ships a CLI-level resume mechanism.
//
// Verification: `gemini` binary not installed locally at adapter-write time;
// flags taken from CAO authoritative impl. Reverify against `gemini --help`
// before first live spawn — same lesson as the Codex resume-subcommand
// discovery (delta-doc Source-RFC corrections section).

import type { AdapterContext, VendorAdapter } from './base.js';

const BINARY = 'gemini';

const BYPASS_FLAGS = ['--yolo', '--sandbox', 'false'];

export const googleAdapter: VendorAdapter = {
  name: 'google',
  binary: BINARY,
  pasteEnterCount: 2,
  extractionRetries: 2,

  buildArgs(_mode: 'fresh' | 'continue', prompt: string, ctx: AdapterContext): string[] {
    const args: string[] = [...BYPASS_FLAGS];

    const model = ctx.config.model;
    if (model) {
      args.push('--model', model);
    }

    args.push(prompt);

    return args;
  },

  envFilter(env: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith('CLAUDE_')) continue;
      out[key] = value;
    }
    return out;
  },
};
