export type DeferredJournalEntry<T> = Readonly<{
  sequence: number;
  value: T;
}>;

/**
 * The state machine deliberately depends on this tiny synchronous boundary.
 * The daemon adapter can implement it with temp-write/file-fsync/rename/
 * directory-fsync; publication is not visible to the machine until append
 * returns.  The memory implementation is useful for deterministic recovery
 * and crash-window tests.
 */
export interface DeferredStartJournal<T> {
  append(value: T): DeferredJournalEntry<T>;
  latest(key: string): DeferredJournalEntry<T> | undefined;
  entries(key: string): readonly DeferredJournalEntry<T>[];
  keys(): readonly string[];
}

export class MemoryDeferredStartJournal<T extends { agent: string }>
  implements DeferredStartJournal<T>
{
  private sequence = 0;
  private readonly records = new Map<string, DeferredJournalEntry<T>[]>();

  append(value: T): DeferredJournalEntry<T> {
    const published = { sequence: ++this.sequence, value: structuredClone(value) };
    const entries = this.records.get(value.agent) ?? [];
    entries.push(published);
    this.records.set(value.agent, entries);
    return structuredClone(published);
  }

  latest(key: string): DeferredJournalEntry<T> | undefined {
    const entry = this.records.get(key)?.at(-1);
    return entry && structuredClone(entry);
  }

  entries(key: string): readonly DeferredJournalEntry<T>[] {
    return structuredClone(this.records.get(key) ?? []);
  }

  keys(): readonly string[] {
    return [...this.records.keys()].sort();
  }
}
