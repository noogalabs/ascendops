import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const root = mkdtempSync(join(tmpdir(), 'cortextos-import-agent-test-'));
const frameworkRoot = join(root, 'framework');
const home = join(root, 'home');
const previousFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
const previousProjectRoot = process.env.CTX_PROJECT_ROOT;
const previousHome = process.env.HOME;

process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
delete process.env.CTX_PROJECT_ROOT;
process.env.HOME = home;

const { importAgentCommand } = await import('../../../src/cli/import-agent.js');

function makeExport(name: string, runtime?: string): string {
  const source = join(root, `${name}-source`);
  const agentDir = join(source, 'agent');
  const archive = join(root, `${name}.tar.gz`);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, '.export-manifest.json'), JSON.stringify({
    version: '1',
    agent_name: name,
    exported_at: '2026-07-19T00:00:00Z',
    ...(runtime ? { runtime } : {}),
  }));
  const tar = spawnSync('tar', ['-czf', archive, '-C', source, 'agent']);
  if (tar.status !== 0) throw new Error(tar.stderr.toString());
  return archive;
}

async function importFixture(name: string, runtime?: string): Promise<Record<string, unknown>> {
  const archive = makeExport(name, runtime);
  await importAgentCommand.parseAsync([
    'node',
    'import-agent',
    archive,
    '--org',
    'acme',
    '--name',
    name,
    '--no-start',
  ]);
  return JSON.parse(readFileSync(
    join(frameworkRoot, 'orgs', 'acme', 'agents', name, 'config.json'),
    'utf-8',
  ));
}

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  if (previousFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
  else process.env.CTX_FRAMEWORK_ROOT = previousFrameworkRoot;
  if (previousProjectRoot === undefined) delete process.env.CTX_PROJECT_ROOT;
  else process.env.CTX_PROJECT_ROOT = previousProjectRoot;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

describe('import-agent runtime preservation', () => {
  it('preserves codex-app-server from the export manifest', async () => {
    const config = await importFixture('runtime-import', 'codex-app-server');
    expect(config.runtime).toBe('codex-app-server');
  });

  it('defaults imports without a runtime to claude-code', async () => {
    const config = await importFixture('default-runtime-import');
    expect(config.runtime).toBe('claude-code');
  });
});
