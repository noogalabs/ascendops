import type { IPCResponse } from '../types/index';
import { acceptNativeMeasuredPeer } from './peer-credentials';
import type { NativeMeasuredPeer } from './native-peer-credential-helper';
import type { WorktreeLeaseArbiter } from './worktree-lease-arbiter';

export type WorktreeLeaseIpcCommand = 'acquire-worktree-lease' | 'bind-worktree-lease-child' | 'check-worktree-lease' | 'release-worktree-lease';

type WorktreeLeaseIpcServiceOptions = {
  arbiter: WorktreeLeaseArbiter;
  measurePeer(socketFd: number): Promise<NativeMeasuredPeer>;
  measureProcess?(pid: number): NativeMeasuredPeer;
  isDescendant?(child: NativeMeasuredPeer, peer: NativeMeasuredPeer): boolean;
  disabledReason?: string;
};

function stringField(data: Record<string, unknown>, field: string): string | undefined {
  const value = data[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class WorktreeLeaseIpcService {
  private readonly arbiter: WorktreeLeaseArbiter;
  private readonly measurePeer: (socketFd: number) => Promise<NativeMeasuredPeer>;
  private readonly measureProcess: (pid: number) => NativeMeasuredPeer;
  private readonly isDescendant: (child: NativeMeasuredPeer, peer: NativeMeasuredPeer) => boolean;
  private readonly disabledReason?: string;

  constructor(options: WorktreeLeaseIpcServiceOptions) {
    this.arbiter = options.arbiter;
    this.measurePeer = options.measurePeer;
    this.measureProcess = options.measureProcess ?? (() => { throw new Error('process measurement unavailable'); });
    this.isDescendant = options.isDescendant ?? (() => false);
    this.disabledReason = options.disabledReason;
  }

  async handle(
    command: WorktreeLeaseIpcCommand,
    data: Record<string, unknown>,
    socketFd: number,
  ): Promise<IPCResponse> {
    if (this.disabledReason) {
      return { success: false, error: this.disabledReason, code: 'ADMISSION_FAILED' };
    }
    const scopeKey = stringField(data, 'scopeKey');
    const requestId = stringField(data, 'requestId');
    if (!scopeKey || !requestId) {
      return { success: false, error: 'scopeKey and requestId required', code: 'INVALID_INPUT' };
    }

    if (command === 'acquire-worktree-lease') {
      const owner = stringField(data, 'owner');
      if (!owner) return { success: false, error: 'owner required', code: 'INVALID_INPUT' };
      let nativePeer: NativeMeasuredPeer;
      try {
        nativePeer = await this.measurePeer(socketFd);
      } catch {
        return { success: false, error: 'peer-identity-unknown', code: 'ADMISSION_FAILED' };
      }
      const peer = acceptNativeMeasuredPeer(nativePeer);
      const result = this.arbiter.acquire({ scopeKey, requestId, owner, peer });
      return result.kind === 'granted'
        ? { success: true, data: result }
        : { success: false, error: result.reason, code: 'ADMISSION_FAILED', data: result };
    }

    if (command === 'bind-worktree-lease-child') {
      const token = stringField(data, 'token');
      const childPid = data.childPid;
      if (!token || !Number.isSafeInteger(childPid) || Number(childPid) <= 0) {
        return { success: false, error: 'token and childPid required', code: 'INVALID_INPUT' };
      }
      try {
        const nativePeer = await this.measurePeer(socketFd);
        const peer = acceptNativeMeasuredPeer(nativePeer);
        const child = this.measureProcess(Number(childPid));
        if (!this.isDescendant(child, nativePeer)) {
          return { success: false, error: 'child-not-descendant-of-peer', code: 'ADMISSION_FAILED' };
        }
        const result = this.arbiter.bindDestructiveChild(scopeKey, requestId, token, peer, child);
        return result.kind === 'bound'
          ? { success: true, data: result }
          : { success: false, error: result.reason, code: 'ADMISSION_FAILED', data: result };
      } catch {
        return { success: false, error: 'child-identity-unknown', code: 'ADMISSION_FAILED' };
      }
    }

    const token = stringField(data, 'token');
    if (!token) return { success: false, error: 'token required', code: 'INVALID_INPUT' };
    if (command === 'check-worktree-lease') {
      const result = this.arbiter.check(scopeKey, requestId, token);
      return result.kind === 'held'
        ? { success: true, data: result }
        : { success: false, error: result.reason, code: 'ADMISSION_FAILED', data: result };
    }
    const result = this.arbiter.release(scopeKey, requestId, token);
    return result.kind === 'released'
      ? { success: true, data: result }
      : { success: false, error: result.reason, code: 'ADMISSION_FAILED', data: result };
  }
}
