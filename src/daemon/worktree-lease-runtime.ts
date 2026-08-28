import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DurableWorktreeLeaseStore } from './durable-worktree-lease-store';
import {
  readNativeParentPid,
  readNativePeerCredentials,
  readNativeProcessIdentity,
  runNativeFullFsync,
} from './native-peer-credential-helper';
import { createNodeDurableFs } from './node-durable-state';
import { WorktreeLeaseArbiter } from './worktree-lease-arbiter';
import { WorktreeLeaseIpcService } from './worktree-lease-ipc';
import type { ProcessIdentity } from './process-identity';

export function worktreeLeasePlatformPolicy(platform: NodeJS.Platform | string): {
  custodyEnabled: boolean;
  reaperEnabled: boolean;
  reason?: string;
} {
  return platform === 'win32'
    ? { custodyEnabled: false, reaperEnabled: false, reason: 'worktree-reaper-disabled-no-measured-win32-identity' }
    : { custodyEnabled: true, reaperEnabled: true };
}

export function createWorktreeLeaseRuntime(options: {
  ctxRoot: string;
  /** Canonical git common-dir shared by every daemon instance for this repo. */
  repositoryCommonDir?: string;
  nativeHelperPath: string;
  /** Production defaults to the native kernel reader; injectable for deterministic runtime casualties. */
  readProcessIdentity?(pid: number): ProcessIdentity;
  /** Test observation point while every admission surface is still closed. */
  observeReconstructionGate?(arbiter: WorktreeLeaseArbiter): void;
  platform?: NodeJS.Platform | string;
}) {
  const platform = options.platform ?? process.platform;
  const policy = worktreeLeasePlatformPolicy(platform);
  const observeProcess = options.readProcessIdentity
    ?? ((pid: number) => readNativeProcessIdentity(pid, options.nativeHelperPath));
  const store = new DurableWorktreeLeaseStore({
    directory: options.repositoryCommonDir
      ? join(options.repositoryCommonDir, '.cortextos-worktree-leases')
      : join(options.ctxRoot, 'state', '.worktree-leases'),
    platform,
    fs: createNodeDurableFs({
      fullFsync(path) { runNativeFullFsync(path, options.nativeHelperPath); },
    }),
    createAttemptNonce: randomUUID,
    lockOwner() {
      const observation = observeProcess(process.pid);
      if (observation.kind !== 'known') throw new Error(`lock-owner-identity-${observation.kind}`);
      return {
        pid: process.pid,
        platform: observation.platform,
        processStartIdentity: observation.kernelToken,
        scopeKey: '',
        acquiredAtMs: Date.now(),
      };
    },
    observeLockOwner(owner) {
      const observation = observeProcess(owner.pid);
      if (observation.kind === 'unknown') return 'unknown';
      if (observation.kind === 'vanished') return 'dead-or-reused';
      return observation.platform === owner.platform
        && observation.kernelToken === owner.processStartIdentity
        ? 'matching-live'
        : 'dead-or-reused';
    },
  });
  const arbiter = new WorktreeLeaseArbiter({
    persistence: store,
    admissionInitiallyClosed: true,
    observeIdentity(record) {
      const observation = observeProcess(record.pid);
      if (observation.kind === 'unknown') return 'unknown';
      if (observation.kind === 'vanished') return 'dead-or-reused';
      return observation.platform === record.platform
        && observation.kernelToken === record.processStartIdentity
        ? 'matching-live'
        : 'dead-or-reused';
    },
  });
  options.observeReconstructionGate?.(arbiter);
  arbiter.rebuildPersistedScopes(store.listPersistedScopes());
  const service = new WorktreeLeaseIpcService({
    arbiter,
    disabledReason: policy.reaperEnabled ? undefined : policy.reason,
    measurePeer(socketFd) {
      return readNativePeerCredentials(socketFd, options.nativeHelperPath);
    },
    measureProcess(pid) {
      const observation = observeProcess(pid);
      if (observation.kind !== 'known') throw new Error(`child-identity-${observation.kind}`);
      return {
        pid,
        platform: observation.platform,
        processStartIdentity: observation.kernelToken,
      };
    },
    isDescendant(child, peer) {
      let current = child.pid;
      const visited = new Set<number>();
      while (current > 1 && !visited.has(current)) {
        if (current === peer.pid) {
          const observation = observeProcess(peer.pid);
          return observation.kind === 'known'
            && observation.platform === peer.platform
            && observation.kernelToken === peer.processStartIdentity;
        }
        visited.add(current);
        current = readNativeParentPid(current);
      }
      return false;
    },
  });
  return { store, arbiter, service, policy };
}
