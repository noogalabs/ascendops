import type { DurableLeaseRequest } from './durable-lease-request';
import type { MeasuredPeerCredentials } from './peer-credentials';
import type { WorktreeLeaseArbiter } from './worktree-lease-arbiter';

export class InternalWorktreeWriterLease {
  private readonly grants = new Map<string, {
    request: DurableLeaseRequest;
    requestId: string;
    token: string;
  }>();

  constructor(private readonly options: {
    scopeKey: string;
    arbiter: WorktreeLeaseArbiter;
    peer(): MeasuredPeerCredentials | undefined;
    createRequest(agent: string): DurableLeaseRequest;
  }) {}

  custodyVerdict(agent: string): 'clear' | 'blocked' | 'unknown' {
    if (this.grants.has(agent)) return 'clear';
    return this.options.arbiter.availability(this.options.scopeKey);
  }

  acquire(agent: string): boolean {
    if (this.grants.has(agent)) return true;
    const peer = this.options.peer();
    if (!peer) return false;
    const request = this.options.createRequest(agent);
    const requestId = request.loadOrCreate();
    const result = this.options.arbiter.acquire({
      scopeKey: this.options.scopeKey,
      requestId,
      owner: `daemon-agent-start:${agent}`,
      peer,
    });
    if (result.kind !== 'granted') return false;
    this.grants.set(agent, { request, requestId, token: result.token });
    return true;
  }

  release(agent: string): void {
    const grant = this.grants.get(agent);
    if (!grant) return;
    const result = this.options.arbiter.release(this.options.scopeKey, grant.requestId, grant.token);
    if (result.kind !== 'released') throw new Error(`internal writer lease release refused: ${result.reason}`);
    grant.request.removeAfterRelease();
    this.grants.delete(agent);
  }
}
