import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentConfig } from '../types/index.js';

export interface AgentRegistryEntry {
  enabled?: boolean;
  org?: string;
  status?: string;
}

export interface SourceAgentCandidate {
  name: string;
  dir: string;
  org: string;
  config: AgentConfig;
}

export function isAgentStartCandidate(
  config: AgentConfig,
  registryEntry?: AgentRegistryEntry,
): boolean {
  return config.enabled !== false && registryEntry?.enabled !== false;
}

/**
 * Discover the same source-side agent candidates the daemon considers at boot.
 * Registry state is intentionally not consulted here; discoverAndStart re-reads
 * it per candidate so a concurrent enable/disable cannot be missed.
 */
export function discoverSourceAgentCandidates(frameworkRoot: string): SourceAgentCandidate[] {
  const agents: SourceAgentCandidate[] = [];
  const orgsBase = join(frameworkRoot, 'orgs');
  if (!existsSync(orgsBase)) return agents;

  let orgNames: string[] = [];
  try {
    orgNames = readdirSync(orgsBase, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return agents;
  }

  for (const org of orgNames) {
    const agentsBase = join(orgsBase, org, 'agents');
    if (!existsSync(agentsBase)) continue;

    try {
      const dirs = readdirSync(agentsBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .filter(d => !d.name.startsWith('_') && !d.name.startsWith('.'))
        .map(d => d.name);

      for (const name of dirs) {
        const dir = join(agentsBase, name);
        agents.push({ name, dir, org, config: loadSourceAgentConfig(dir) });
      }
    } catch {
      // Ignore read errors for this org and continue scanning the others.
    }
  }

  return agents;
}

/**
 * Load source config with the daemon's fail-open behavior. Invalid or unreadable
 * config remains visible in logs and defaults to an empty config so one damaged
 * agent file does not abort discovery of the rest of the fleet.
 */
export function loadSourceAgentConfig(agentDir: string): AgentConfig {
  const configPath = join(agentDir, 'config.json');
  if (!existsSync(configPath)) return {};

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    console.error(`[agent-manager] config read failed: ${configPath}: ${(err as Error).message}`);
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    const msg = (err as SyntaxError).message;
    const posMatch = /position (\d+)/.exec(msg);
    let locHint = '';
    if (posMatch) {
      const pos = Math.min(Number(posMatch[1]), raw.length);
      const before = raw.slice(0, pos);
      const line = before.split('\n').length;
      const col = pos - (before.lastIndexOf('\n') + 1) + 1;
      const offendingLine = raw.split('\n')[line - 1] || '';
      locHint = ` (line ${line}, col ${col}: \`${offendingLine.trim().slice(0, 80)}\`)`;
    }
    console.error(`[agent-manager] config.json invalid JSON: ${configPath}${locHint}: ${msg}`);
    console.error('[agent-manager] hint: trailing commas, unquoted keys, and single quotes are common causes');
    return {};
  }
}
