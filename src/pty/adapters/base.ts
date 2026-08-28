import type { AgentConfig, CtxEnv } from '../../types/index.js';

export interface AdapterContext {
  config: AgentConfig;
  env: CtxEnv;
}

export interface VendorAdapter {
  name: 'anthropic' | 'openai' | 'google';
  binary: string;
  buildArgs(mode: 'fresh' | 'continue', prompt: string, ctx: AdapterContext): string[];
  envFilter(env: Record<string, string>): Record<string, string>;
  pasteEnterCount: 1 | 2;
  extractionRetries: number;
}

import { anthropicAdapter } from './anthropic.js';
import { openaiAdapter } from './openai.js';
// Task 2: Gemini skeleton wired into the factory
import { googleAdapter } from './google.js';

export function loadAdapter(vendor: string | undefined): VendorAdapter {
  const v = vendor || 'anthropic';
  switch (v) {
    case 'anthropic':
      return anthropicAdapter;
    case 'openai':
      return openaiAdapter;
    case 'google':
      return googleAdapter;
    default:
      throw new Error(
        `Unknown vendor: '${v}'. Supported MVP vendors: 'anthropic', 'openai', 'google'.`
      );
  }
}
