import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { durableRelease, durableReplace, type DurableFs } from './durable-state';

type DurableLeaseRequestOptions = {
  directory: string;
  scopeKey: string;
  owner: string;
  platform: NodeJS.Platform | string;
  fs: DurableFs;
  createRequestId(): string;
  createAttemptNonce(): string;
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class DurableLeaseRequest {
  private readonly options: DurableLeaseRequestOptions;
  private readonly path: string;
  private tempPath?: string;

  constructor(options: DurableLeaseRequestOptions) {
    this.options = options;
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const key = createHash('sha256').update(`${options.scopeKey}\0${options.owner}`).digest('hex');
    this.path = join(options.directory, `${key}.json`);
  }

  loadOrCreate(): string {
    const existing = this.loadExisting();
    if (existing) return existing;
    const requestId = this.options.createRequestId();
    this.persist(requestId);
    return requestId;
  }

  loadExisting(): string | undefined {
    return this.options.fs.exists(this.path) ? this.read() : undefined;
  }

  persist(requestId: string): void {
    const existing = this.loadExisting();
    if (existing) {
      if (existing !== requestId) throw new Error('lease-request-already-persisted');
      return;
    }
    if (!UUID_V4.test(requestId)) throw new Error('invalid-request-id');
    const nonce = this.options.createAttemptNonce();
    if (!nonce || /[^A-Za-z0-9_-]/.test(nonce)) throw new Error('invalid-attempt-nonce');
    this.tempPath = join(
      this.options.directory,
      `.${basename(this.path)}.${requestId}.${nonce}.tmp`,
    );
    durableReplace({
      targetPath: this.path,
      tempPath: this.tempPath,
      data: `${JSON.stringify({
        version: 1,
        scopeKey: this.options.scopeKey,
        owner: this.options.owner,
        requestId,
      })}\n`,
      platform: this.options.platform,
      fs: this.options.fs,
    });
  }

  removeAfterRelease(): void {
    durableRelease({
      targetPath: this.path,
      tokenMatches: () => this.options.fs.exists(this.path) && UUID_V4.test(this.read()),
      fs: this.options.fs,
    });
  }

  exists(): boolean {
    return this.options.fs.exists(this.path);
  }

  lastTempPath(): string | undefined {
    return this.tempPath;
  }

  private read(): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      throw new Error('lease-request-malformed');
    }
    const value = parsed as {
      version?: unknown;
      scopeKey?: unknown;
      owner?: unknown;
      requestId?: unknown;
    };
    if (value.version !== 1
      || value.scopeKey !== this.options.scopeKey
      || value.owner !== this.options.owner
      || typeof value.requestId !== 'string'
      || !UUID_V4.test(value.requestId)) {
      throw new Error('lease-request-malformed');
    }
    return value.requestId;
  }
}
