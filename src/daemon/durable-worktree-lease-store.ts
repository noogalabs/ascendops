import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { durableReplace, type DurableFs } from './durable-state';
import type { LeasePersistence, LeaseRecord } from './worktree-lease-arbiter';

type PersistedLeaseState =
  | { version: 1; kind: 'live'; record: LeaseRecord }
  | { version: 1; kind: 'released'; scopeKey: string; requestId: string };

type DurableWorktreeLeaseStoreOptions = {
  directory: string;
  platform: NodeJS.Platform | string;
  fs: DurableFs;
  createAttemptNonce(): string;
  lockOwner?: () => LockOwnerIdentity;
  observeLockOwner?: (owner: LockOwnerIdentity) => 'matching-live' | 'dead-or-reused' | 'unknown';
};

type LockOwnerIdentity = Readonly<{
  pid: number;
  platform: 'linux' | 'darwin';
  processStartIdentity: string;
  scopeKey: string;
  acquiredAtMs: number;
}>;

export class DurableWorktreeLeaseStore implements LeasePersistence {
  static readonly RELEASED_TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;
  private readonly directory: string;
  private readonly platform: NodeJS.Platform | string;
  private readonly fs: DurableFs;
  private readonly createAttemptNonce: () => string;
  private readonly lockOwner: () => LockOwnerIdentity;
  private readonly observeLockOwner: (owner: LockOwnerIdentity) => 'matching-live' | 'dead-or-reused' | 'unknown';
  private tempPath?: string;

  constructor(options: DurableWorktreeLeaseStoreOptions) {
    this.directory = options.directory;
    this.platform = options.platform;
    this.fs = options.fs;
    this.createAttemptNonce = options.createAttemptNonce;
    this.lockOwner = options.lockOwner ?? (() => ({
      pid: process.pid,
      platform: process.platform === 'darwin' ? 'darwin' : 'linux',
      processStartIdentity: `process:${process.pid}`,
      scopeKey: '',
      acquiredAtMs: Date.now(),
    }));
    this.observeLockOwner = options.observeLockOwner ?? (() => 'matching-live');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  pathForScope(scopeKey: string): string {
    const digest = createHash('sha256').update(scopeKey).digest('hex');
    return join(this.directory, `${digest}.json`);
  }

  lastTempPath(): string | undefined {
    return this.tempPath;
  }

  withScopeLock<T>(scopeKey: string, operation: () => T): T {
    const lockPath = `${this.pathForScope(scopeKey)}.lock`;
    this.claimScopeLock(lockPath, scopeKey);
    try {
      return operation();
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }

  private claimScopeLock(lockPath: string, scopeKey: string): void {
    // Deliberate fail-closed residual: a crash between mkdir and owner.json
    // leaves an identity-less lock held-unknown forever. Reclaiming a lock
    // without an attributable holder identity would be exploitable.
    try {
      mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const identityPath = join(lockPath, 'owner.json');
      let owner: LockOwnerIdentity;
      try {
        owner = JSON.parse(readFileSync(identityPath, 'utf8')) as LockOwnerIdentity;
        if (owner.scopeKey !== scopeKey || !owner.processStartIdentity || owner.pid <= 0) {
          throw new Error('invalid-lock-owner');
        }
      } catch {
        throw new Error('lease-scope-lock-held-unknown');
      }
      const observation = this.observeLockOwner(owner);
      if (observation !== 'dead-or-reused') {
        throw new Error(observation === 'matching-live'
          ? 'lease-scope-lock-held'
          : 'lease-scope-lock-held-unknown');
      }
      const tombstone = `${lockPath}.reclaim-${this.createAttemptNonce()}`;
      try {
        renameSync(lockPath, tombstone);
      } catch {
        throw new Error('lease-scope-lock-reclaim-lost');
      }
      let claimedOwner: LockOwnerIdentity;
      try {
        claimedOwner = JSON.parse(readFileSync(join(tombstone, 'owner.json'), 'utf8')) as LockOwnerIdentity;
      } catch {
        try { renameSync(tombstone, lockPath); } catch { /* another contender restored it */ }
        throw new Error('lease-scope-lock-reclaim-lost');
      }
      if (claimedOwner.pid !== owner.pid
        || claimedOwner.platform !== owner.platform
        || claimedOwner.processStartIdentity !== owner.processStartIdentity
        || claimedOwner.scopeKey !== owner.scopeKey
        || claimedOwner.acquiredAtMs !== owner.acquiredAtMs) {
        try { renameSync(tombstone, lockPath); } catch { /* current holder already restored */ }
        throw new Error('lease-scope-lock-reclaim-lost');
      }
      try {
        mkdirSync(lockPath, { mode: 0o700 });
      } catch {
        rmSync(tombstone, { recursive: true, force: true });
        throw new Error('lease-scope-lock-reclaim-lost');
      }
      rmSync(tombstone, { recursive: true, force: true });
    }
    const owner = { ...this.lockOwner(), scopeKey, acquiredAtMs: Date.now() };
    try {
      writeFileSync(join(lockPath, 'owner.json'), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    } catch (error) {
      rmSync(lockPath, { recursive: true, force: true });
      throw error;
    }
  }

  publish(record: LeaseRecord): void {
    this.replace(record.scopeKey, record.requestId, { version: 1, kind: 'live', record });
  }

  remove(record: LeaseRecord): void {
    const current = this.read(record.scopeKey);
    if (!current || current.kind !== 'live'
      || current.record.requestId !== record.requestId
      || current.record.token !== record.token) {
      throw new Error('lease-release-capability-mismatch');
    }
    this.replace(record.scopeKey, record.requestId, {
      version: 1,
      kind: 'released',
      scopeKey: record.scopeKey,
      requestId: record.requestId,
    });
  }

  load(scopeKey: string): LeaseRecord | undefined {
    const state = this.read(scopeKey);
    return state?.kind === 'live' ? state.record : undefined;
  }

  loadReleasedRequest(scopeKey: string): string | undefined {
    const state = this.read(scopeKey);
    return state?.kind === 'released' ? state.requestId : undefined;
  }

  listPersistedScopes(): string[] {
    const scopes = new Set<string>();
    for (const name of readdirSync(this.directory)) {
      if (name.endsWith('.tmp')) throw new Error('lease-state-ambiguous-temp-debris');
      if (!name.endsWith('.json')) continue;
      const path = join(this.directory, name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        throw new Error('lease-state-malformed');
      }
      const state = parsed as Partial<PersistedLeaseState>;
      const scopeKey = state.kind === 'live'
        ? state.record?.scopeKey
        : state.kind === 'released'
          ? state.scopeKey
          : undefined;
      if (!scopeKey) throw new Error('lease-state-malformed');
      if (state.kind === 'released'
        && typeof state.requestId === 'string'
        && Date.now() - statSync(path).mtimeMs > DurableWorktreeLeaseStore.RELEASED_TOMBSTONE_RETENTION_MS) {
        this.fs.unlink(path);
        this.fs.fsyncDirectory(this.directory);
        continue;
      }
      scopes.add(scopeKey);
    }
    return [...scopes].sort();
  }

  private replace(scopeKey: string, requestId: string, state: PersistedLeaseState): void {
    const targetPath = this.pathForScope(scopeKey);
    const nonce = this.createAttemptNonce();
    if (!nonce || /[^A-Za-z0-9_-]/.test(nonce)) throw new Error('invalid-attempt-nonce');
    const tempPath = join(this.directory, `.${basename(targetPath)}.${requestId}.${nonce}.tmp`);
    this.tempPath = tempPath;
    durableReplace({
      targetPath,
      tempPath,
      data: `${JSON.stringify(state)}\n`,
      platform: this.platform,
      fs: this.fs,
    });
  }

  private read(scopeKey: string): PersistedLeaseState | undefined {
    const path = this.pathForScope(scopeKey);
    if (readdirSync(this.directory).some(name => name.endsWith('.tmp'))) {
      throw new Error('lease-state-ambiguous-temp-debris');
    }
    if (!this.fs.exists(path)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error('lease-state-malformed');
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
      throw new Error('lease-state-malformed');
    }
    const state = parsed as PersistedLeaseState;
    if (state.kind === 'live' && state.record?.scopeKey === scopeKey) return state;
    if (state.kind === 'released' && state.scopeKey === scopeKey && typeof state.requestId === 'string') return state;
    throw new Error('lease-state-malformed');
  }
}
