/**
 * probe -> bind -> revoke, as one unit with injectable collaborators.
 *
 * The order IS the guarantee and it has been wrong three times:
 *
 *  - inferring exclusivity from the bind resolving (it unlinks any existing
 *    socket with no liveness check and resolves while another daemon listens);
 *  - probing AFTER the bind, so the probe connected to this daemon's own listener
 *    and always answered yes, making the revocation permanently inert;
 *  - skipping the revocation on conflict but continuing to bind, which stole the
 *    live daemon's socket anyway.
 *
 * It lives here as a free function taking its collaborators because every textual
 * assertion of this order has been defeated — a comment containing the call, a
 * decoy inside the function body, a call aliased through a `const`. A test can
 * only prove what RAN by watching the collaborators run.
 */
export async function bindInstanceAndReconcileSessionRecords(deps: {
  /** Does another daemon answer this instance's socket? Asked BEFORE we bind. */
  probe: () => Promise<boolean>;
  /** Bind this instance's socket. */
  bind: () => Promise<void>;
  /** Drop session records left by a previous daemon lifecycle. */
  revoke: () => void;
  /** Called instead of revoking when another daemon owns the instance. */
  onConflict?: () => void;
}): Promise<void> {
  // While the answer can still be about somebody else.
  const anotherDaemonAnswers = await deps.probe();

  // ABORT, and abort BEFORE the bind. Skipping the revocation and continuing
  // would still unlink the live daemon's socket and start a duplicate fleet.
  if (anotherDaemonAnswers) {
    deps.onConflict?.();
    throw new Error('another daemon is already running for this instance');
  }

  await deps.bind();

  // After the bind succeeds, so a daemon that failed to come up never revokes.
  deps.revoke();
}
