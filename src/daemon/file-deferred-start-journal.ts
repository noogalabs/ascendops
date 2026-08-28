import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { durableReplace, type DurableFs } from './durable-state';
import type { DeferredJournalEntry, DeferredStartJournal } from './deferred-start-journal';

export class FileDeferredStartJournal<T extends { agent: string }>
  implements DeferredStartJournal<T> {
  private sequence = 0;
  private readonly cache = new Map<string, DeferredJournalEntry<T>[]>();

  constructor(private readonly options: {
    directory: string;
    platform: NodeJS.Platform | string;
    fs: DurableFs;
    nonce?: () => string;
  }) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  }

  append(value: T): DeferredJournalEntry<T> {
    this.load(value.agent);
    const entry = { sequence: ++this.sequence, value: structuredClone(value) };
    // Recovery needs the latest durable receipt, not an unbounded transition
    // history. Keeping one record makes rewrite/fsync cost constant while
    // preserving sequence monotonicity across daemon restarts.
    const entries = [entry];
    const targetPath = this.path(value.agent);
    durableReplace({
      targetPath,
      tempPath: `${targetPath}.tmp.${(this.options.nonce ?? randomUUID)()}`,
      data: `${JSON.stringify(entries)}\n`,
      platform: this.options.platform,
      fs: this.options.fs,
    });
    this.cache.set(value.agent, entries);
    return structuredClone(entry);
  }

  latest(key: string): DeferredJournalEntry<T> | undefined {
    const entry = this.load(key).at(-1);
    return entry && structuredClone(entry);
  }

  entries(key: string): readonly DeferredJournalEntry<T>[] {
    return structuredClone(this.load(key));
  }

  keys(): readonly string[] {
    const agents = new Set(this.cache.keys());
    for (const name of readdirSync(this.options.directory)) {
      if (!name.endsWith('.json')) continue;
      const parsed = JSON.parse(readFileSync(join(this.options.directory, name), 'utf8')) as DeferredJournalEntry<T>[];
      if (!Array.isArray(parsed) || parsed.length === 0) continue;
      const agent = parsed.at(-1)?.value?.agent;
      if (typeof agent !== 'string' || !agent) throw new Error('deferred journal malformed agent key');
      agents.add(agent);
    }
    return [...agents].sort();
  }

  private load(agent: string): DeferredJournalEntry<T>[] {
    const cached = this.cache.get(agent);
    if (cached) return cached;
    const path = this.path(agent);
    if (!existsSync(path)) {
      this.cache.set(agent, []);
      return [];
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as DeferredJournalEntry<T>[];
    if (!Array.isArray(parsed) || parsed.some(entry => !Number.isSafeInteger(entry.sequence) || entry.value?.agent !== agent)) {
      throw new Error(`deferred journal malformed for ${agent}`);
    }
    this.sequence = Math.max(this.sequence, ...parsed.map(entry => entry.sequence), 0);
    this.cache.set(agent, parsed);
    return parsed;
  }

  private path(agent: string): string {
    const key = createHash('sha256').update(agent).digest('hex');
    return join(this.options.directory, `${key}.json`);
  }
}
