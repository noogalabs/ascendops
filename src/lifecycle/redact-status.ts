import { randomUUID } from 'crypto';
import { CORTEXTOS_VERSION } from '../version.js';
import { evaluateStatusCheck } from './check-status.js';
import {
  ISOLATION_EVIDENCE_CODES,
  LEGACY_STATUS_OBSERVATIONS,
  LEGACY_PARTIAL_OBSERVATION_CODES,
  LEGACY_SUPPORTED_CAPABILITIES,
  LEGACY_UNSUPPORTED_CAPABILITIES,
  STATUS_CHECK_POLICIES,
  type LegacyStatusObservationCode,
} from './status-contract.js';
import type {
  CountBucket,
  LifecycleStatusSnapshot,
  OverallStatus,
  RedactedLifecycleStatusSnapshot,
  StatusObservation,
  StatusCheckPolicy,
  StatusCheckResult,
  StatusSeverity,
} from './status-types.js';

const SEVERITY_ORDER: readonly StatusSeverity[] = ['critical', 'error', 'warning', 'info'];
const BLOCKING_OBSERVATIONS = new Set<LegacyStatusObservationCode>([
  'CORTEXT_STATUS_LEGACY_ROOT_AUTHORITY_UNPROVEN',
  'CORTEXT_STATUS_LEGACY_AGENT_NAME_COLLISION',
  'CORTEXT_STATUS_STATE_MISSING',
  'CORTEXT_STATUS_STATE_UNREADABLE',
]);
const PARTIAL_OBSERVATIONS = new Set<LegacyStatusObservationCode>(
  LEGACY_PARTIAL_OBSERVATION_CODES,
);

export function countBucket(value: number | null): CountBucket | null {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return null;
  if (value === 0) return '0';
  if (value === 1) return '1';
  if (value <= 5) return '2-5';
  if (value <= 20) return '6-20';
  if (value <= 100) return '21-100';
  return '>100';
}

function closedValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

function projectCheck(snapshot: LifecycleStatusSnapshot): StatusCheckResult | null {
  const policy = snapshot.check?.policy;
  if (!policy || !STATUS_CHECK_POLICIES.includes(policy as StatusCheckPolicy)) return null;
  return evaluateStatusCheck(snapshot, policy);
}

function deriveOverall(
  snapshotStatus: LifecycleStatusSnapshot['snapshot_status'],
  stateStatus: LifecycleStatusSnapshot['state']['status'],
  daemonStatus: LifecycleStatusSnapshot['runtime']['daemon']['status'],
  ipcStatus: LifecycleStatusSnapshot['runtime']['daemon']['ipc_status'],
  observations: StatusObservation[],
): LifecycleStatusSnapshot['overall'] {
  const highestSeverity = SEVERITY_ORDER.find(severity =>
    observations.some(observation => observation.severity === severity)) ?? null;
  const materialObservation = observations.some(observation => observation.severity !== 'info');
  let status: OverallStatus;
  if (
    stateStatus !== 'readable'
    || observations.some(observation => BLOCKING_OBSERVATIONS.has(observation.code))
  ) status = 'blocked';
  else if (daemonStatus === 'unknown') status = 'unknown';
  else if (daemonStatus === 'stopped') status = 'stopped';
  else if (
    daemonStatus === 'unresponsive'
    || ipcStatus !== 'responsive'
    || snapshotStatus !== 'complete'
    || materialObservation
  ) status = 'degraded';
  else status = 'healthy';
  return { status, summary: '', highest_severity: highestSeverity };
}

export function redactLifecycleStatus(
  snapshot: LifecycleStatusSnapshot,
  reportId: string = randomUUID(),
): RedactedLifecycleStatusSnapshot {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reportId)) {
    throw new Error('Invalid generated report identifier');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(snapshot.observed_at)
    || !Number.isFinite(Date.parse(snapshot.observed_at))) {
    throw new Error('Invalid lifecycle observation timestamp');
  }
  const canonicalObservations: StatusObservation[] = snapshot.observations.flatMap(observation => {
    if (!Object.prototype.hasOwnProperty.call(LEGACY_STATUS_OBSERVATIONS, observation.code)) return [];
    const code = observation.code as LegacyStatusObservationCode;
    const metadata = LEGACY_STATUS_OBSERVATIONS[code];
    return [{ code, ...metadata }];
  });
  const suppliedSnapshotStatus = closedValue(
    snapshot.snapshot_status,
    ['complete', 'partial'],
    'partial',
  );
  const snapshotStatus = suppliedSnapshotStatus === 'partial'
    || canonicalObservations.some(observation => PARTIAL_OBSERVATIONS.has(observation.code))
    ? 'partial'
    : 'complete';
  const stateStatus = closedValue(
    snapshot.state.status,
    ['readable', 'missing', 'unreadable', 'unknown'],
    'unknown',
  );
  const daemonStatus = closedValue(
    snapshot.runtime.daemon.status,
    ['running', 'stopped', 'unresponsive', 'unknown'],
    'unknown',
  );
  const ipcStatus = closedValue(
    snapshot.runtime.daemon.ipc_status,
    ['responsive', 'absent', 'refused', 'timeout', 'invalid', 'unknown'],
    'unknown',
  );
  const overall = deriveOverall(
    snapshotStatus,
    stateStatus,
    daemonStatus,
    ipcStatus,
    canonicalObservations,
  );
  const snapshotForCheck: LifecycleStatusSnapshot = {
    ...snapshot,
    snapshot_status: snapshotStatus,
    state: { ...snapshot.state, status: stateStatus },
    runtime: {
      ...snapshot.runtime,
      daemon: { ...snapshot.runtime.daemon, status: daemonStatus, ipc_status: ipcStatus },
    },
    overall,
    observations: canonicalObservations,
  };
  const observations = canonicalObservations.map(observation => ({
    code: observation.code,
    severity: observation.severity,
    domain: observation.domain,
    recommended_operation: observation.recommended_operation,
  }));
  return {
    schema_version: 'cortext.status.redacted/v1',
    ok: true,
    report_id: reportId,
    observed_day: `${snapshot.observed_at.slice(0, 10)}Z`,
    snapshot_status: snapshotStatus,
    scope: {
      instance_alias: 'instance_1',
      target_kind: closedValue(snapshot.scope.target_kind, ['live', 'sandbox', 'unknown'], 'unknown'),
      layout_kind: closedValue(snapshot.scope.layout_kind, ['legacy_combined', 'unknown'], 'unknown'),
    },
    manager: {
      version: CORTEXTOS_VERSION,
      installation_status: 'legacy_bridge',
      integrity: 'unverified',
      trust_status: 'unsupported',
      recovery_launcher_status: 'unsupported',
    },
    capabilities: {
      profile: 'legacy_bridge_v1',
      supported: [...LEGACY_SUPPORTED_CAPABILITIES],
      unsupported: [...LEGACY_UNSUPPORTED_CAPABILITIES],
    },
    basis: {
      lifecycle_generation_present: false,
      writer_epoch_present: false,
      trust_metadata_present: false,
      compatibility_matrix_present: false,
      public_release_id: null,
      config_revision_alias: null,
      config_observation_digest_present: false,
      state_schema: null,
      state_layout_generation_present: false,
      state_control_observation_digest_present: false,
      component_lock_present: false,
    },
    consistency: { status: 'unsupported' },
    device: {
      identity_status: 'absent',
      device_alias: null,
      writer_role: 'unknown',
      lease_status: 'unsupported',
    },
    application: {
      version: snapshot.application.version === CORTEXTOS_VERSION ? CORTEXTOS_VERSION : null,
      public_release_id: null,
      public_source_commit: null,
      channel: null,
      integrity: 'unverified',
    },
    instance: {
      instance_alias: 'instance_1',
      config_schema: null,
      config_status: 'unknown',
      versioning: closedValue(snapshot.instance.versioning, ['git', 'unversioned', 'unknown'], 'unknown'),
      remote_status: closedValue(
        snapshot.instance.remote_status,
        ['none', 'configured_unverified', 'unknown'],
        'unknown',
      ),
      portability: 'unknown',
    },
    state: {
      schema_version: null,
      status: stateStatus,
      migration_status: 'unknown',
    },
    components: {
      lock_status: 'unsupported',
      declared_count_bucket: null,
      resolved_count_bucket: null,
      drift: 'unknown',
    },
    runtime: {
      daemon_status: daemonStatus,
      dashboard_status: 'unknown',
      agent_count_bucket: countBucket(snapshot.runtime.agents.configured),
      observed_process_count_bucket: countBucket(snapshot.runtime.agents.observed_processes),
      active_process_count_bucket: countBucket(snapshot.runtime.agents.active_processes),
      degraded_agent_count_bucket: countBucket(snapshot.runtime.agents.degraded),
      expected_missing_count_bucket: countBucket(snapshot.runtime.agents.expected_missing),
      disabled_active_count_bucket: countBucket(snapshot.runtime.agents.disabled_active),
      unregistered_active_count_bucket: countBucket(snapshot.runtime.agents.unregistered_active),
      poller_count_bucket: null,
      duplicate_poller_count_bucket: null,
      cron_count_bucket: null,
      isolation: {
        boundary: closedValue(
          snapshot.runtime.isolation.boundary,
          ['none', 'os_process', 'container', 'vm', 'unknown'],
          'unknown',
        ),
        data_roots: closedValue(
          snapshot.runtime.isolation.data_roots,
          ['isolated', 'live', 'unknown'],
          'unknown',
        ),
        process_namespace: closedValue(
          snapshot.runtime.isolation.process_namespace,
          ['isolated', 'live', 'unknown'],
          'unknown',
        ),
        managed_integrations: closedValue(
          snapshot.runtime.isolation.managed_integrations,
          ['intercepted', 'disabled', 'enabled', 'unknown'],
          'unknown',
        ),
        credentials: closedValue(
          snapshot.runtime.isolation.credentials,
          ['removed', 'scoped', 'host_available', 'unknown'],
          'unknown',
        ),
        network: closedValue(
          snapshot.runtime.isolation.network,
          ['none', 'restricted', 'unrestricted', 'unknown'],
          'unknown',
        ),
        host_access: closedValue(
          snapshot.runtime.isolation.host_access,
          ['constrained', 'full', 'unknown'],
          'unknown',
        ),
        claim: closedValue(
          snapshot.runtime.isolation.claim,
          ['none', 'cortext_namespace', 'security_contained'],
          'none',
        ),
        evidence_codes: Array.isArray(snapshot.runtime.isolation.evidence_codes)
          ? [...new Set(snapshot.runtime.isolation.evidence_codes.filter(code =>
            ISOLATION_EVIDENCE_CODES.includes(code)))]
          : [],
      },
    },
    recovery: {
      checkpoint_alias: null,
      checkpoint_age_bucket: null,
      checkpoint_verification: 'unknown',
      backup_alias: null,
      backup_age_bucket: null,
      backup_verification: 'unknown',
      rollback_status: 'unknown',
    },
    updates: {
      channel: null,
      availability: 'not_checked',
      checked_age_bucket: null,
    },
    compatibility: { status: 'unknown', reason_codes: [] },
    overall: {
      status: overall.status,
      highest_severity: overall.highest_severity,
    },
    check: projectCheck(snapshotForCheck),
    observations,
  };
}
