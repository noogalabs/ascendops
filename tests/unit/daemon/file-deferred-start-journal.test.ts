import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileDeferredStartJournal } from '../../../src/daemon/file-deferred-start-journal';
import { createNodeDurableFs } from '../../../src/daemon/node-durable-state';

type Value = { agent: string; state: string };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'deferred-journal-'));
  roots.push(directory);
  let nonce = 0;
  return {
    directory,
    make: () => new FileDeferredStartJournal<Value>({
      directory,
      platform: 'linux',
      fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
      nonce: () => `attempt-${++nonce}`,
    }),
  };
}

describe('file deferred-start journal', () => {
  it('durably reconstructs the latest receipt after a daemon restart', () => {
    const f = fixture();
    const first = f.make();
    first.append({ agent: 'alpha', state: 'deferred-with-owner' });
    first.append({ agent: 'alpha', state: 'spawning' });
    const restarted = f.make();
    expect(restarted.latest('alpha')?.value).toEqual({ agent: 'alpha', state: 'spawning' });
    expect(restarted.entries('alpha')).toHaveLength(1);
  });

  it('bounded-journal-retains-the-latest-recoverable-record-after-many-restarts', () => {
    const f = fixture();
    for (let index = 0; index < 100; index += 1) {
      f.make().append({ agent: 'alpha', state: `phase-${index}` });
    }
    const restarted = f.make();
    expect(restarted.entries('alpha')).toHaveLength(1);
    expect(restarted.latest('alpha')?.value.state).toBe('phase-99');
    const path = join(f.directory, readdirSync(f.directory).find(name => name.endsWith('.json'))!);
    expect(readFileSync(path, 'utf8').length).toBeLessThan(256);
  });

  it('fails closed rather than inferring absence from malformed persisted state', () => {
    const f = fixture();
    const journal = f.make();
    journal.append({ agent: 'alpha', state: 'deferred-with-owner' });
    const path = join(f.directory, readdirSync(f.directory)[0]);
    expect(readFileSync(path, 'utf8')).toContain('deferred-with-owner');
    writeFileSync(path, '{not-json');
    expect(() => f.make().latest('alpha')).toThrow();
  });
});
