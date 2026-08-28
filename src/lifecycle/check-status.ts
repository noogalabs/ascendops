import type {
  LifecycleStatusSnapshot,
  StatusCheckPolicy,
  StatusCheckReasonCode,
  StatusCheckResult,
} from './status-types.js';
import {
  LEGACY_STATUS_OBSERVATIONS,
  LEGACY_PARTIAL_OBSERVATION_CODES,
  STATUS_CHECK_POLICIES,
  type LegacyStatusObservationCode,
} from './status-contract.js';

const NAMESPACE_EVIDENCE = [
  'CORTEXT_ISOLATION_LIVE_ROOT_DISJOINT',
  'CORTEXT_ISOLATION_PROCESS_NAMESPACE_DISJOINT',
  'CORTEXT_ISOLATION_MANAGED_INTEGRATIONS_ROUTED',
] as const;

const CONTAINMENT_EVIDENCE = [
  ...NAMESPACE_EVIDENCE,
  'CORTEXT_ISOLATION_BOUNDARY_ENFORCED',
  'CORTEXT_ISOLATION_HOST_CREDENTIALS_UNAVAILABLE',
  'CORTEXT_ISOLATION_EGRESS_POLICY_ENFORCED',
  'CORTEXT_ISOLATION_HOST_ACCESS_CONSTRAINED',
] as const;

const BLOCKING_OBSERVATION_CODES = new Set<LegacyStatusObservationCode>([
  'CORTEXT_STATUS_LEGACY_ROOT_AUTHORITY_UNPROVEN',
  'CORTEXT_STATUS_LEGACY_AGENT_NAME_COLLISION',
  'CORTEXT_STATUS_STATE_MISSING',
  'CORTEXT_STATUS_STATE_UNREADABLE',
]);
const PARTIAL_OBSERVATION_CODES = new Set<LegacyStatusObservationCode>(
  LEGACY_PARTIAL_OBSERVATION_CODES,
);

export class UnsupportedStatusCheckPolicyError extends Error {
  constructor() {
    super('CORTEXT_STATUS_UNSUPPORTED_CHECK_POLICY');
  }
}

export function normalizeStatusCheckPolicy(input: string): StatusCheckPolicy {
  const normalized = input.endsWith('@v1') ? input.slice(0, -3) : input;
  if (!STATUS_CHECK_POLICIES.includes(normalized as StatusCheckPolicy)) {
    throw new UnsupportedStatusCheckPolicyError();
  }
  return normalized as StatusCheckPolicy;
}

function hasEvidence(snapshot: LifecycleStatusSnapshot, required: readonly string[]): boolean {
  const present = new Set<string>(snapshot.runtime.isolation.evidence_codes);
  return required.every(code => present.has(code));
}

function addReason(
  reasons: StatusCheckReasonCode[],
  failed: boolean,
  code: StatusCheckReasonCode,
): void {
  if (failed && !reasons.includes(code)) reasons.push(code);
}

function snapshotIncomplete(snapshot: LifecycleStatusSnapshot): boolean {
  return snapshot.snapshot_status !== 'complete'
    || snapshot.observations.some(observation =>
      PARTIAL_OBSERVATION_CODES.has(observation.code as LegacyStatusObservationCode));
}

function evaluateUsable(
  snapshot: LifecycleStatusSnapshot,
  reasons: StatusCheckReasonCode[],
): void {
  addReason(
    reasons,
    snapshotIncomplete(snapshot),
    'CORTEXT_CHECK_SNAPSHOT_INCOMPLETE',
  );
  addReason(reasons, !snapshot.scope.resolved_instance_id, 'CORTEXT_CHECK_INSTANCE_UNRESOLVED');
  addReason(
    reasons,
    !['healthy', 'degraded', 'stopped'].includes(snapshot.overall.status)
      || snapshot.runtime.daemon.status === 'unknown'
      || snapshot.observations.some(observation =>
        BLOCKING_OBSERVATION_CODES.has(observation.code as LegacyStatusObservationCode)),
    'CORTEXT_CHECK_OVERALL_DISALLOWED',
  );
  addReason(reasons, snapshot.state.status !== 'readable', 'CORTEXT_CHECK_STATE_NOT_READABLE');
}

function evaluateHealthy(
  snapshot: LifecycleStatusSnapshot,
  reasons: StatusCheckReasonCode[],
): void {
  evaluateUsable(snapshot, reasons);
  const stable = snapshot.consistency.status === 'stable'
    || (snapshot.capabilities.profile === 'legacy_bridge_v1'
      && snapshot.consistency.status === 'unsupported');
  addReason(reasons, !stable, 'CORTEXT_CHECK_CONSISTENCY_UNSTABLE');
  addReason(
    reasons,
    snapshot.runtime.daemon.status !== 'running'
      || snapshot.runtime.daemon.ipc_status !== 'responsive',
    'CORTEXT_CHECK_DAEMON_NOT_RUNNING',
  );
  addReason(reasons, snapshot.overall.status !== 'healthy', 'CORTEXT_CHECK_OVERALL_DISALLOWED');
  addReason(
    reasons,
    snapshot.observations.some(observation => {
      if (!Object.prototype.hasOwnProperty.call(LEGACY_STATUS_OBSERVATIONS, observation.code)) {
        return false;
      }
      return LEGACY_STATUS_OBSERVATIONS[observation.code as LegacyStatusObservationCode].severity
        !== 'info';
    }),
    'CORTEXT_CHECK_LIFECYCLE_ERROR_PRESENT',
  );
}

function managedBasisComplete(snapshot: LifecycleStatusSnapshot): boolean {
  const basis = snapshot.basis;
  return basis.instance_id !== null
    && basis.manager_version !== null
    && basis.trust_metadata_revision !== null
    && basis.compatibility_matrix_revision !== null
    && basis.lifecycle_generation !== null
    && basis.writer_epoch !== null
    && basis.selected_release_id !== null
    && basis.config_revision !== null
    && basis.observation_manifest_version !== null
    && basis.config_observation_digest !== null
    && basis.state_schema !== null
    && basis.state_layout_generation !== null
    && basis.state_control_observation_digest !== null
    && basis.component_lock_revision !== null;
}

function evaluateUpdateSafe(
  snapshot: LifecycleStatusSnapshot,
  reasons: StatusCheckReasonCode[],
): void {
  evaluateUsable(snapshot, reasons);
  // cortext.status/v1 is explicitly the legacy bridge contract. Managed
  // update-safety will be evaluated by a future discriminated contract.
  addReason(reasons, true, 'CORTEXT_CHECK_PROFILE_UNSUPPORTED');
  addReason(
    reasons,
    snapshot.manager.integrity !== 'verified'
      || snapshot.manager.trust_status !== 'verified'
      || snapshot.manager.recovery_launcher_status !== 'verified',
    'CORTEXT_CHECK_MANAGER_INTEGRITY_UNVERIFIED',
  );
  addReason(reasons, snapshot.consistency.status !== 'stable', 'CORTEXT_CHECK_CONSISTENCY_UNSTABLE');
  addReason(reasons, !managedBasisComplete(snapshot), 'CORTEXT_CHECK_BASIS_INCOMPLETE');
  addReason(
    reasons,
    snapshot.device.writer_role !== 'active' || snapshot.device.lease_status !== 'held',
    'CORTEXT_CHECK_WRITER_NOT_ACTIVE',
  );
  addReason(reasons, snapshot.state.migration_status !== 'idle', 'CORTEXT_CHECK_MIGRATION_NOT_IDLE');
  addReason(reasons, snapshot.state.status !== 'readable', 'CORTEXT_CHECK_STATE_NOT_READABLE');
  addReason(reasons, snapshot.application.integrity !== 'verified', 'CORTEXT_CHECK_APPLICATION_UNVERIFIED');
  addReason(
    reasons,
    snapshot.compatibility.status !== 'compatible' && snapshot.compatibility.status !== 'warning',
    'CORTEXT_CHECK_COMPATIBILITY_UNSAFE',
  );
  addReason(
    reasons,
    snapshot.recovery.latest_checkpoint.verification !== 'passed',
    'CORTEXT_CHECK_CHECKPOINT_UNVERIFIED',
  );
  addReason(
    reasons,
    snapshot.recovery.latest_state_backup.verification !== 'passed',
    'CORTEXT_CHECK_BACKUP_UNVERIFIED',
  );
  addReason(reasons, snapshot.recovery.rollback_status !== 'ready', 'CORTEXT_CHECK_ROLLBACK_NOT_READY');
  addReason(
    reasons,
    snapshot.observations.some(observation =>
      (observation.severity === 'critical' || observation.severity === 'error')
      && ['manager', 'device', 'application', 'instance', 'state', 'recovery', 'compatibility']
        .includes(observation.domain)),
    'CORTEXT_CHECK_LIFECYCLE_ERROR_PRESENT',
  );
}

function evaluateSandboxNamespace(
  snapshot: LifecycleStatusSnapshot,
  reasons: StatusCheckReasonCode[],
  includeEvidence = true,
): void {
  addReason(reasons, snapshotIncomplete(snapshot), 'CORTEXT_CHECK_SNAPSHOT_INCOMPLETE');
  addReason(reasons, snapshot.scope.target_kind !== 'sandbox', 'CORTEXT_CHECK_TARGET_NOT_SANDBOX');
  addReason(reasons, snapshot.runtime.isolation.data_roots !== 'isolated', 'CORTEXT_CHECK_ROOTS_NOT_ISOLATED');
  addReason(
    reasons,
    snapshot.runtime.isolation.process_namespace !== 'isolated',
    'CORTEXT_CHECK_PROCESSES_NOT_ISOLATED',
  );
  addReason(
    reasons,
    snapshot.runtime.isolation.managed_integrations !== 'intercepted'
      && snapshot.runtime.isolation.managed_integrations !== 'disabled',
    'CORTEXT_CHECK_INTEGRATIONS_NOT_ROUTED',
  );
  if (includeEvidence) {
    addReason(
      reasons,
      snapshot.runtime.isolation.claim !== 'cortext_namespace'
        && snapshot.runtime.isolation.claim !== 'security_contained',
      'CORTEXT_CHECK_ISOLATION_EVIDENCE_MISSING',
    );
    addReason(
      reasons,
      !hasEvidence(snapshot, NAMESPACE_EVIDENCE),
      'CORTEXT_CHECK_ISOLATION_EVIDENCE_MISSING',
    );
  }
}

function evaluateSecurityContained(
  snapshot: LifecycleStatusSnapshot,
  reasons: StatusCheckReasonCode[],
): void {
  evaluateSandboxNamespace(snapshot, reasons, false);
  addReason(
    reasons,
    snapshot.runtime.isolation.boundary !== 'container'
      && snapshot.runtime.isolation.boundary !== 'vm',
    'CORTEXT_CHECK_BOUNDARY_INSUFFICIENT',
  );
  addReason(
    reasons,
    snapshot.runtime.isolation.credentials !== 'removed'
      && snapshot.runtime.isolation.credentials !== 'scoped',
    'CORTEXT_CHECK_CREDENTIALS_EXPOSED',
  );
  addReason(
    reasons,
    snapshot.runtime.isolation.network !== 'none'
      && snapshot.runtime.isolation.network !== 'restricted',
    'CORTEXT_CHECK_NETWORK_UNCONSTRAINED',
  );
  addReason(
    reasons,
    snapshot.runtime.isolation.host_access !== 'constrained',
    'CORTEXT_CHECK_HOST_ACCESS_FULL',
  );
  addReason(
    reasons,
    snapshot.runtime.isolation.claim !== 'security_contained'
      || !hasEvidence(snapshot, CONTAINMENT_EVIDENCE),
    'CORTEXT_CHECK_ISOLATION_EVIDENCE_MISSING',
  );
}

export function evaluateStatusCheck(
  snapshot: LifecycleStatusSnapshot,
  requestedPolicy: string,
): StatusCheckResult {
  const policy = normalizeStatusCheckPolicy(requestedPolicy);
  const reasonCodes: StatusCheckReasonCode[] = [];

  if (policy === 'usable') evaluateUsable(snapshot, reasonCodes);
  else if (policy === 'healthy') evaluateHealthy(snapshot, reasonCodes);
  else if (policy === 'update-safe') evaluateUpdateSafe(snapshot, reasonCodes);
  else if (policy === 'sandbox-namespace') evaluateSandboxNamespace(snapshot, reasonCodes);
  else evaluateSecurityContained(snapshot, reasonCodes);

  if (reasonCodes.length === 0) {
    return {
      policy,
      policy_version: `cortext.check.${policy}/v1`,
      result: 'pass',
      reason_codes: [],
    } as StatusCheckResult;
  }
  return {
    policy,
    policy_version: `cortext.check.${policy}/v1`,
    result: 'fail',
    reason_codes: reasonCodes as [StatusCheckReasonCode, ...StatusCheckReasonCode[]],
  } as StatusCheckResult;
}
