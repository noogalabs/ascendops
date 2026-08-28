import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const verifier = join(process.cwd(), 'scripts/verify-buzz-typed-boundary.mjs');

describe('Buzz typed-boundary consumer census', () => {
  let fixture = '';

  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  it('derives the tracked Buzz population and finds no direct PTY/injection sink', () => {
    const run = spawnSync(process.execPath, [verifier, process.cwd()], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/Buzz typed-boundary census OK: tracked=\d+ population=\d+/);
  });

  it('kills a two-hop barrel consumer that never spells Buzz and reaches a direct sink', () => {
    fixture = mkdtempSync(join(tmpdir(), 'buzz-census-plant-'));
    mkdirSync(join(fixture, 'src', 'buzz'), { recursive: true });
    mkdirSync(join(fixture, 'src', 'transport'), { recursive: true });
    mkdirSync(join(fixture, 'src', 'future'), { recursive: true });
    writeFileSync(join(fixture, 'src', 'buzz', 'index.ts'), 'export const buzz = true;\n');
    writeFileSync(join(fixture, 'src', 'transport', 'index.ts'), "export { buzz as transport } from '../buzz/index.js';\n");
    writeFileSync(join(fixture, 'src', 'future', 'consumer.ts'), [
      "import { transport } from '../transport/index.js';",
      'export function bypass(pty: any) { if (transport) pty.write(\"raw\"); }',
      '',
    ].join('\n'));
    expect(spawnSync('git', ['init', '-q'], { cwd: fixture }).status).toBe(0);
    expect(spawnSync('git', ['add', 'src'], { cwd: fixture }).status).toBe(0);

    const run = spawnSync(process.execPath, [verifier, fixture], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('src/future/consumer.ts');
  });

  it('kills a dynamic-import consumer that reaches a direct sink', () => {
    fixture = mkdtempSync(join(tmpdir(), 'buzz-census-dynamic-plant-'));
    mkdirSync(join(fixture, 'src', 'buzz'), { recursive: true });
    mkdirSync(join(fixture, 'src', 'future'), { recursive: true });
    writeFileSync(join(fixture, 'src', 'buzz', 'index.ts'), 'export const buzz = true;\n');
    writeFileSync(join(fixture, 'src', 'future', 'dynamic-consumer.ts'), [
      'export async function bypass(pty: any) {',
      "  const { buzz } = await import('../buzz/index.js');",
      '  if (buzz) pty.write("raw");',
      '}',
      '',
    ].join('\n'));
    expect(spawnSync('git', ['init', '-q'], { cwd: fixture }).status).toBe(0);
    expect(spawnSync('git', ['add', 'src'], { cwd: fixture }).status).toBe(0);

    const run = spawnSync(process.execPath, [verifier, fixture], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('src/future/dynamic-consumer.ts');
  });

  it('kills a two-argument dynamic-import consumer that reaches a direct sink', () => {
    fixture = mkdtempSync(join(tmpdir(), 'buzz-census-dynamic-options-plant-'));
    mkdirSync(join(fixture, 'src', 'buzz'), { recursive: true });
    mkdirSync(join(fixture, 'src', 'future'), { recursive: true });
    writeFileSync(join(fixture, 'src', 'buzz', 'index.ts'), 'export const buzz = true;\n');
    writeFileSync(join(fixture, 'src', 'future', 'dynamic-options-consumer.ts'), [
      'export async function bypass(pty: any) {',
      "  const { buzz } = await import('../buzz/index.js', { with: { type: 'json' } });",
      '  if (buzz) pty.write("raw");',
      '}',
      '',
    ].join('\n'));
    expect(spawnSync('git', ['init', '-q'], { cwd: fixture }).status).toBe(0);
    expect(spawnSync('git', ['add', 'src'], { cwd: fixture }).status).toBe(0);

    const run = spawnSync(process.execPath, [verifier, fixture], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('src/future/dynamic-options-consumer.ts');
  });

  it('kills a no-substitution-template dynamic-import consumer', () => {
    fixture = mkdtempSync(join(tmpdir(), 'buzz-census-dynamic-template-plant-'));
    mkdirSync(join(fixture, 'src', 'buzz'), { recursive: true });
    mkdirSync(join(fixture, 'src', 'future'), { recursive: true });
    writeFileSync(join(fixture, 'src', 'buzz', 'index.ts'), 'export const buzz = true;\n');
    writeFileSync(join(fixture, 'src', 'future', 'dynamic-template-consumer.ts'), [
      'export async function bypass(pty: any) {',
      '  const { buzz } = await import(`../buzz/index.js`);',
      '  if (buzz) pty.write("raw");',
      '}',
      '',
    ].join('\n'));
    expect(spawnSync('git', ['init', '-q'], { cwd: fixture }).status).toBe(0);
    expect(spawnSync('git', ['add', 'src'], { cwd: fixture }).status).toBe(0);

    const run = spawnSync(process.execPath, [verifier, fixture], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('src/future/dynamic-template-consumer.ts');
  });

  it('kills an import-equals consumer that reaches a direct sink', () => {
    fixture = mkdtempSync(join(tmpdir(), 'buzz-census-import-equals-plant-'));
    mkdirSync(join(fixture, 'src', 'buzz'), { recursive: true });
    mkdirSync(join(fixture, 'src', 'future'), { recursive: true });
    writeFileSync(join(fixture, 'src', 'buzz', 'index.ts'), 'export const buzz = true;\n');
    writeFileSync(join(fixture, 'src', 'future', 'import-equals-consumer.ts'), [
      "import buzz = require('../buzz/index.js');",
      'export function bypass(pty: any) { if (buzz) pty.write("raw"); }',
      '',
    ].join('\n'));
    expect(spawnSync('git', ['init', '-q'], { cwd: fixture }).status).toBe(0);
    expect(spawnSync('git', ['add', 'src'], { cwd: fixture }).status).toBe(0);

    const run = spawnSync(process.execPath, [verifier, fixture], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('src/future/import-equals-consumer.ts');
  });

  it('kills an import-type consumer that reaches a direct sink', () => {
    fixture = mkdtempSync(join(tmpdir(), 'buzz-census-import-type-plant-'));
    mkdirSync(join(fixture, 'src', 'buzz'), { recursive: true });
    mkdirSync(join(fixture, 'src', 'future'), { recursive: true });
    writeFileSync(join(fixture, 'src', 'buzz', 'index.ts'), 'export interface BuzzMarker { ready: true; }\n');
    writeFileSync(join(fixture, 'src', 'future', 'import-type-consumer.ts'), [
      "type Buzz = import('../buzz/index.js').BuzzMarker;",
      'export function bypass(pty: any, buzz: Buzz) { if (buzz) pty.write("raw"); }',
      '',
    ].join('\n'));
    expect(spawnSync('git', ['init', '-q'], { cwd: fixture }).status).toBe(0);
    expect(spawnSync('git', ['add', 'src'], { cwd: fixture }).status).toBe(0);

    const run = spawnSync(process.execPath, [verifier, fixture], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('src/future/import-type-consumer.ts');
  });

  it('fails closed on a non-literal dynamic-import specifier and names the consumer', () => {
    fixture = mkdtempSync(join(tmpdir(), 'buzz-census-dynamic-indirection-plant-'));
    mkdirSync(join(fixture, 'src', 'buzz'), { recursive: true });
    mkdirSync(join(fixture, 'src', 'future'), { recursive: true });
    writeFileSync(join(fixture, 'src', 'buzz', 'index.ts'), 'export const buzz = true;\n');
    writeFileSync(join(fixture, 'src', 'future', 'indirect-consumer.ts'), [
      "const MODULE = '../buzz/index.js';",
      'export async function bypass(pty: any) {',
      '  const { buzz } = await import(MODULE);',
      '  if (buzz) pty.write("raw");',
      '}',
      '',
    ].join('\n'));
    expect(spawnSync('git', ['init', '-q'], { cwd: fixture }).status).toBe(0);
    expect(spawnSync('git', ['add', 'src'], { cwd: fixture }).status).toBe(0);

    const run = spawnSync(process.execPath, [verifier, fixture], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('unresolvable-dynamic-import');
    expect(run.stderr).toContain('src/future/indirect-consumer.ts');
  });

  it('fails closed when the AgentManager Buzz subject anchors are missing', () => {
    fixture = mkdtempSync(join(tmpdir(), 'buzz-census-manager-anchor-plant-'));
    mkdirSync(join(fixture, 'src', 'buzz'), { recursive: true });
    mkdirSync(join(fixture, 'src', 'daemon'), { recursive: true });
    writeFileSync(join(fixture, 'src', 'buzz', 'index.ts'), 'export const buzz = true;\n');
    writeFileSync(join(fixture, 'src', 'daemon', 'agent-manager.ts'), [
      "import { buzz } from '../buzz/index.js';",
      'export function renamedBuzzRegistration(pty: any) {',
      '  if (buzz) pty.write("raw");',
      '}',
      '',
    ].join('\n'));
    expect(spawnSync('git', ['init', '-q'], { cwd: fixture }).status).toBe(0);
    expect(spawnSync('git', ['add', 'src'], { cwd: fixture }).status).toBe(0);

    const run = spawnSync(process.execPath, [verifier, fixture], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('agent-manager Buzz subject anchors missing or out of order');
    expect(run.stderr).toContain('src/daemon/agent-manager.ts');
  });
});
