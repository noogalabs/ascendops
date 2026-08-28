export type LeaseSupervisorInput = Readonly<{
  scopeKey: string;
  owner: string;
  command: readonly string[];
}>;

export type LeaseAcquireRequest = Readonly<{
  scopeKey: string;
  owner: string;
  requestId: string;
}>;

export type LeaseSupervisorDependencies = {
  createRequestId(): string;
  persistRequestId(requestId: string): Promise<void>;
  acquire(request: LeaseAcquireRequest): Promise<
    | { kind: 'granted'; token: string }
    | { kind: 'refused'; reason: string }
  >;
  spawnProtectedChild(command: readonly string[], lease: Readonly<{
    scopeKey: string;
    requestId: string;
    token: string;
  }>): {
    pid: number;
    settled: Promise<number>;
    resume(): void;
    terminate(): void;
  };
  bindChild(request: LeaseAcquireRequest & { token: string; childPid: number }): Promise<
    { kind: 'bound' } | { kind: 'refused'; reason: string }
  >;
  release(request: LeaseAcquireRequest & { token: string }): Promise<void>;
  removeRequestId(requestId: string): Promise<void>;
  /** Resolves only in harnesses that model loss of the supervisor process. */
  supervisorDeath: Promise<void>;
};

export type LeaseSupervisorResult =
  | { kind: 'completed'; exitCode: number }
  | { kind: 'refused'; reason: string }
  | { kind: 'supervisor-died' };

/**
 * Own the external-holder side of the reviewed lease boundary. The request ID
 * becomes durable before IPC acquire, and the supervisor remains the measured
 * peer until the protected child settles and the opaque capability is released.
 *
 * This is the one authorized protected-span custody shape: the supervisor is
 * the measured lease holder, and the destructive child cannot outlive it. On
 * modeled supervisor death we terminate the child and keep the lease/request
 * evidence held-unknown until the child is proven reaped. Only then may daemon
 * reconstruction classify the dead holder and govern stale reclaim.
 */
export async function superviseLeaseSpan(
  input: LeaseSupervisorInput,
  dependencies: LeaseSupervisorDependencies,
): Promise<LeaseSupervisorResult> {
  const requestId = dependencies.createRequestId();
  await dependencies.persistRequestId(requestId);
  const request = { scopeKey: input.scopeKey, owner: input.owner, requestId };
  const acquired = await dependencies.acquire(request);
  if (acquired.kind === 'refused') {
    return { kind: 'refused', reason: acquired.reason };
  }

  const child = dependencies.spawnProtectedChild(input.command, {
    scopeKey: input.scopeKey,
    requestId,
    token: acquired.token,
  });
  let binding: { kind: 'bound' } | { kind: 'refused'; reason: string };
  try {
    binding = await dependencies.bindChild({
      ...request,
      token: acquired.token,
      childPid: child.pid,
    });
  } catch (error) {
    // Rejection has exactly the same stopped-wrapper custody obligations as
    // an explicit refusal. Always make SIGTERM deliverable, reap, and release
    // before surfacing the transport failure.
    child.resume();
    child.terminate();
    await child.settled;
    await dependencies.release({ ...request, token: acquired.token });
    await dependencies.removeRequestId(requestId);
    throw error;
  }
  if (binding.kind === 'refused') {
    // The wrapper child is born stopped. SIGTERM alone remains pending on a
    // stopped process group, so continue it before termination and reap it
    // before releasing the repository-wide capability.
    child.resume();
    child.terminate();
    await child.settled;
    await dependencies.release({ ...request, token: acquired.token });
    await dependencies.removeRequestId(requestId);
    return { kind: 'refused', reason: binding.reason };
  }
  child.resume();
  const outcome = await Promise.race([
    child.settled.then(exitCode => ({ kind: 'child' as const, exitCode })),
    dependencies.supervisorDeath.then(() => ({ kind: 'supervisor-died' as const })),
  ]);
  if (outcome.kind === 'supervisor-died') {
    // A real process death cannot issue release. Retaining both the durable
    // request ID and grant lets daemon reconstruction observe the dead measured
    // identity and enter the governed stale-reclaim path.
    child.terminate();
    await child.settled;
    return { kind: 'supervisor-died' };
  }

  await dependencies.release({ ...request, token: acquired.token });
  await dependencies.removeRequestId(requestId);
  return { kind: 'completed', exitCode: outcome.exitCode };
}
