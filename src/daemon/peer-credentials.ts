/**
 * Credentials measured from the native IPC transport.  The private symbol is
 * deliberately not exported: JSON supplied by a lease client cannot be
 * mistaken for a peer measured by SO_PEERCRED/LOCAL_PEERPID.
 */
const measuredPeer = Symbol('transport-measured-peer');

export type MeasuredPeerCredentials = Readonly<{
  pid: number;
  processStartIdentity: string;
  platform: 'linux' | 'darwin';
  [measuredPeer]: true;
}>;

export type NativePeerCredentialReading = Readonly<{
  pid: number;
  platform: 'linux' | 'darwin';
}>;

export type NativePeerCredentialHelper = {
  /** Linux: SO_PEERCRED. macOS: LOCAL_PEERPID. */
  readPeerCredentials(socketHandle: number): NativePeerCredentialReading;
};

export type PeerProcessIdentityHelper = {
  /** Linux boot-id + proc start ticks, or macOS proc_pidinfo start time. */
  readStartIdentity(pid: number, platform: 'linux' | 'darwin'): string | undefined;
};

export function measurePeerCredentials(
  socketHandle: number,
  native: NativePeerCredentialHelper,
  identity: PeerProcessIdentityHelper,
): MeasuredPeerCredentials {
  const peer = native.readPeerCredentials(socketHandle);
  if (!Number.isSafeInteger(peer.pid) || peer.pid <= 0) {
    throw new Error('UNKNOWN: native peer helper returned an invalid pid');
  }
  const processStartIdentity = identity.readStartIdentity(peer.pid, peer.platform);
  if (!processStartIdentity) {
    throw new Error('UNKNOWN: high-resolution peer start identity is unavailable');
  }
  return Object.freeze({
    pid: peer.pid,
    platform: peer.platform,
    processStartIdentity,
    [measuredPeer]: true as const,
  });
}

export function isMeasuredPeerCredentials(value: unknown): value is MeasuredPeerCredentials {
  return Boolean(
    value
      && typeof value === 'object'
      && (value as Partial<MeasuredPeerCredentials>)[measuredPeer] === true,
  );
}

export function acceptNativeMeasuredPeer(value: NativePeerCredentialReading & {
  processStartIdentity: string;
}): MeasuredPeerCredentials {
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !value.processStartIdentity) {
    throw new Error('UNKNOWN: invalid native measured peer');
  }
  return Object.freeze({
    pid: value.pid,
    platform: value.platform,
    processStartIdentity: value.processStartIdentity,
    [measuredPeer]: true as const,
  });
}
