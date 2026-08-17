import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRoot = join(__dirname, '../../..');
const scriptPath = join(
  repoRoot,
  'templates',
  'agent',
  '.claude',
  'skills',
  'trending-repo-scout',
  'scripts',
  'classify-trending.mjs',
);

let tempDir: string;

describe('classify-trending', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'classify-trending-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('bounds a stalled classifier and records the timeout before keyword fallback', () => {
    const fakeClaude = join(tempDir, 'claude');
    const candidatesPath = join(tempDir, 'candidates.json');
    const seenPath = join(tempDir, 'seen.json');

    writeFileSync(fakeClaude, '#!/bin/sh\nsleep 1\n', 'utf8');
    chmodSync(fakeClaude, 0o755);
    writeFileSync(candidatesPath, JSON.stringify([{
      slug: 'example/agent-tool',
      description: 'AI agent workflow',
      topics: ['agents'],
      star_delta: '10 stars today',
    }]), 'utf8');
    writeFileSync(seenPath, '{}', 'utf8');

    const startedAt = Date.now();
    const stdout = execFileSync(
      process.execPath,
      [scriptPath, candidatesPath, seenPath],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH ?? ''}`,
          TRENDING_SCOUT_CLASSIFIER_TIMEOUT_MS: '20',
        },
      },
    );
    const elapsedMs = Date.now() - startedAt;
    const result = JSON.parse(stdout);

    expect(elapsedMs).toBeLessThan(750);
    expect(result.classification).toBe('keyword fallback');
    expect(result.classifier_error).toContain('ETIMEDOUT');
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].slug).toBe('example/agent-tool');
  });
});
