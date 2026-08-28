import type {
  IsolationEvidenceCode,
  LegacyStatusObservationCode,
  LegacyStatusObservationDomain,
  LegacySupportedCapability,
  LegacyUnsupportedCapability,
  StatusCheckPolicy,
  StatusCheckReasonCode,
  StatusCheckReasonFor,
} from './status-contract.js';

export type {
  StatusCheckPolicy,
  StatusCheckReasonCode,
  StatusCheckReasonFor,
} from './status-contract.js';

export type StatusSeverity = 'info' | 'warning' | 'error' | 'critical';
export type SnapshotStatus = 'complete' | 'partial';
export type OverallStatus =
  | 'healthy'
  | 'degraded'
  | 'stopped'
  | 'migrating'
  | 'blocked'
  | 'uninitialized'
  | 'unknown';

type FailedStatusCheckForPolicy<P extends StatusCheckPolicy> = {
  policy: P;
  policy_version: `cortext.check.${P}/v1`;
  result: 'fail';
  reason_codes: [StatusCheckReasonFor<P>, ...StatusCheckReasonFor<P>[]];
};

type StatusCheckForPolicy<P extends StatusCheckPolicy> =
  P extends 'update-safe'
    ? FailedStatusCheckForPolicy<P>
    : {
      policy: P;
      policy_version: `cortext.check.${P}/v1`;
      result: 'pass';
      reason_codes: [];
    }
      | FailedStatusCheckForPolicy<P>;

export type StatusCheckResult = {
  [P in StatusCheckPolicy]: StatusCheckForPolicy<P>;
}[StatusCheckPolicy];

export interface StatusObservation {
  code: LegacyStatusObservationCode;
  severity: StatusSeverity;
  domain: LegacyStatusObservationDomain;
  summary: string;
  recommended_operation: null;
}

export interface LifecycleStatusSnapshot {
  schema_version: 'cortext.status/v1';
  ok: true;
  observed_at: string;
  snapshot_status: SnapshotStatus;
  scope: {
    requested_instance: string | null;
    selection_source: 'argument' | 'only_instance' | 'legacy_environment';
    resolved_instance_id: string;
    target_kind: 'live' | 'sandbox' | 'unknown';
    layout_kind: 'legacy_combined' | 'unknown';
  };
  manager: {
    version: string;
    protocol_version: null;
    status_contract: 'cortext.status/v1';
    installation_status: 'legacy_bridge';
    integrity: 'verified' | 'unverified' | 'invalid' | 'tampered' | 'unsupported' | 'unknown';
    trust_status: 'verified' | 'unverified' | 'invalid' | 'tampered' | 'unsupported' | 'unknown';
    recovery_launcher_status: 'verified' | 'unverified' | 'invalid' | 'tampered' | 'unsupported' | 'unknown';
  };
  capabilities: {
    profile: 'legacy_bridge_v1';
    supported: LegacySupportedCapability[];
    unsupported: LegacyUnsupportedCapability[];
  };
  basis: {
    instance_id: string;
    manager_version: string;
    trust_metadata_revision: null;
    compatibility_matrix_revision: null;
    lifecycle_generation: null;
    writer_epoch: null;
    selected_release_id: null;
    config_revision: null;
    observation_manifest_version: null;
    config_observation_digest: null;
    state_schema: null;
    state_layout_generation: null;
    state_control_observation_digest: null;
    component_lock_revision: null;
  };
  consistency: {
    collection_started_at: string;
    collection_completed_at: string;
    generation_before: null;
    generation_after: null;
    status: 'stable' | 'changed_during_read' | 'unsupported';
  };
  device: {
    identity_status: 'absent';
    device_id: null;
    writer_role: 'active' | 'standby' | 'conflict' | 'unknown';
    lease_status: 'held' | 'not_held' | 'expired' | 'conflict' | 'unsupported' | 'unknown';
    lease_expires_at: null;
  };
  application: {
    version: string | null;
    release_id: null;
    source_commit: string | null;
    channel: null;
    integrity: 'verified' | 'modified' | 'unverified' | 'unknown';
    selection: 'unknown';
    root: string | null;
    version_evidence: Array<{
      domain: 'application' | 'dashboard_component' | 'source_provenance';
      source: 'root_package' | 'cli_metadata' | 'dashboard_package' | 'git_commit';
      authority: 'primary_legacy' | 'corroborating' | 'component' | 'provenance';
      value: string;
    }>;
  };
  instance: {
    instance_id: string;
    display_name: null;
    config_schema: null;
    config_revision: null;
    config_status: 'unknown';
    versioning: 'git' | 'unversioned' | 'unknown';
    remote_status: 'none' | 'configured_unverified' | 'unknown';
    portability: 'unknown';
    root: string | null;
  };
  state: {
    schema_version: null;
    status: 'readable' | 'missing' | 'unreadable' | 'unknown';
    migration_status:
      | 'idle'
      | 'planned'
      | 'in_progress'
      | 'interrupted'
      | 'verifying'
      | 'rollback_in_progress'
      | 'unknown';
    migration_id: null;
    root: string | null;
  };
  components: {
    lock_status: 'unsupported';
    lock_revision: null;
    declared: null;
    resolved: null;
    drift: 'unknown';
  };
  runtime: {
    daemon: {
      status: 'running' | 'stopped' | 'unresponsive' | 'unknown';
      pid: null;
      started_at: null;
      application_release_id: null;
      ipc_status: 'responsive' | 'absent' | 'refused' | 'timeout' | 'invalid' | 'unknown';
    };
    dashboard: { status: 'unknown' };
    agents: {
      configured: number | null;
      enabled: number | null;
      observed_processes: number | null;
      active_processes: number | null;
      running: number | null;
      starting: number | null;
      stopped: number | null;
      busy: null;
      degraded: number | null;
      unknown: number | null;
      expected_missing: number | null;
      disabled_active: number | null;
      unregistered_active: number | null;
      recent_heartbeat: number | null;
      stale_heartbeat: number | null;
    };
    pollers: {
      expected: null;
      active: null;
      duplicates: null;
    };
    crons: {
      enabled: null;
      due: null;
      overdue: null;
      paused: null;
    };
    isolation: {
      profile: 'legacy_full_host';
      boundary: 'none' | 'os_process' | 'container' | 'vm' | 'unknown';
      data_roots: 'isolated' | 'live' | 'unknown';
      process_namespace: 'isolated' | 'live' | 'unknown';
      managed_integrations: 'intercepted' | 'disabled' | 'enabled' | 'unknown';
      credentials: 'removed' | 'scoped' | 'host_available' | 'unknown';
      network: 'none' | 'restricted' | 'unrestricted' | 'unknown';
      host_access: 'constrained' | 'full' | 'unknown';
      claim: 'none' | 'cortext_namespace' | 'security_contained';
      evidence_codes: IsolationEvidenceCode[];
    };
  };
  recovery: {
    latest_checkpoint: {
      id: null;
      created_at: null;
      verification: 'passed' | 'failed' | 'not_run' | 'stale' | 'unknown';
    };
    latest_state_backup: {
      id: null;
      created_at: null;
      verification: 'passed' | 'failed' | 'not_run' | 'stale' | 'unknown';
    };
    rollback_release_id: null;
    rollback_status: 'ready' | 'incomplete' | 'unavailable' | 'unknown';
  };
  updates: {
    channel: null;
    policy: null;
    pinned_release: null;
    availability: 'not_checked';
    candidate_release_id: null;
    checked_at: null;
  };
  compatibility: {
    status: 'compatible' | 'warning' | 'blocked' | 'unknown';
    matrix_version: null;
    reasons: [];
  };
  overall: {
    status: OverallStatus;
    summary: string;
    highest_severity: StatusSeverity | null;
  };
  check: StatusCheckResult | null;
  observations: StatusObservation[];
}

export type CountBucket = '0' | '1' | '2-5' | '6-20' | '21-100' | '>100';

export interface RedactedLifecycleStatusSnapshot {
  schema_version: 'cortext.status.redacted/v1';
  ok: true;
  report_id: string;
  observed_day: string;
  snapshot_status: SnapshotStatus;
  scope: {
    instance_alias: 'instance_1';
    target_kind: 'live' | 'sandbox' | 'unknown';
    layout_kind: 'legacy_combined' | 'unknown';
  };
  manager: {
    version: string;
    installation_status: 'legacy_bridge';
    integrity: 'unverified';
    trust_status: 'unsupported';
    recovery_launcher_status: 'unsupported';
  };
  capabilities: LifecycleStatusSnapshot['capabilities'];
  basis: {
    lifecycle_generation_present: false;
    writer_epoch_present: false;
    trust_metadata_present: false;
    compatibility_matrix_present: false;
    public_release_id: null;
    config_revision_alias: null;
    config_observation_digest_present: false;
    state_schema: null;
    state_layout_generation_present: false;
    state_control_observation_digest_present: false;
    component_lock_present: false;
  };
  consistency: { status: 'unsupported' };
  device: {
    identity_status: 'absent';
    device_alias: null;
    writer_role: 'unknown';
    lease_status: 'unsupported';
  };
  application: {
    version: string | null;
    public_release_id: null;
    public_source_commit: null;
    channel: null;
    integrity: 'unverified';
  };
  instance: {
    instance_alias: 'instance_1';
    config_schema: null;
    config_status: 'unknown';
    versioning: LifecycleStatusSnapshot['instance']['versioning'];
    remote_status: LifecycleStatusSnapshot['instance']['remote_status'];
    portability: 'unknown';
  };
  state: {
    schema_version: null;
    status: LifecycleStatusSnapshot['state']['status'];
    migration_status: 'unknown';
  };
  components: {
    lock_status: 'unsupported';
    declared_count_bucket: null;
    resolved_count_bucket: null;
    drift: 'unknown';
  };
  runtime: {
    daemon_status: LifecycleStatusSnapshot['runtime']['daemon']['status'];
    dashboard_status: 'unknown';
    agent_count_bucket: CountBucket | null;
    observed_process_count_bucket: CountBucket | null;
    active_process_count_bucket: CountBucket | null;
    degraded_agent_count_bucket: CountBucket | null;
    expected_missing_count_bucket: CountBucket | null;
    disabled_active_count_bucket: CountBucket | null;
    unregistered_active_count_bucket: CountBucket | null;
    poller_count_bucket: null;
    duplicate_poller_count_bucket: null;
    cron_count_bucket: null;
    isolation: Omit<LifecycleStatusSnapshot['runtime']['isolation'], 'profile'>;
  };
  recovery: {
    checkpoint_alias: null;
    checkpoint_age_bucket: null;
    checkpoint_verification: 'unknown';
    backup_alias: null;
    backup_age_bucket: null;
    backup_verification: 'unknown';
    rollback_status: 'unknown';
  };
  updates: {
    channel: null;
    availability: 'not_checked';
    checked_age_bucket: null;
  };
  compatibility: { status: 'unknown'; reason_codes: [] };
  overall: {
    status: OverallStatus;
    highest_severity: StatusSeverity | null;
  };
  check: StatusCheckResult | null;
  observations: Array<{
    code: LegacyStatusObservationCode;
    severity: StatusSeverity;
    domain: LegacyStatusObservationDomain;
    recommended_operation: null;
  }>;
}

export type LifecycleStatusErrorCode =
  | 'CORTEXT_STATUS_INVALID_INSTANCE'
  | 'CORTEXT_STATUS_INSTANCE_NOT_FOUND'
  | 'CORTEXT_STATUS_INSTANCE_AMBIGUOUS'
  | 'CORTEXT_STATUS_INVALID_OPTION_COMBINATION'
  | 'CORTEXT_STATUS_CONTRACT_REQUIRES_JSON'
  | 'CORTEXT_STATUS_CONTRACT_MODE_MISMATCH'
  | 'CORTEXT_STATUS_UNSUPPORTED_CONTRACT'
  | 'CORTEXT_STATUS_UNSUPPORTED_CHECK_POLICY'
  | 'CORTEXT_STATUS_COLLECTION_FAILED';

export type LifecycleStatusErrorDetailCode =
  | 'INVALID_INSTANCE'
  | 'INSTANCE_NOT_FOUND'
  | 'INSTANCE_AMBIGUOUS'
  | 'REDACT_WITH_PATHS'
  | 'CONTRACT_WITHOUT_JSON'
  | 'CONTRACT_MODE_MISMATCH'
  | 'UNSUPPORTED_CONTRACT'
  | 'UNSUPPORTED_CHECK_POLICY'
  | 'COLLECTION_FAILED';

export type LifecycleStatusErrorDetails =
  | { detail_code: Exclude<LifecycleStatusErrorDetailCode, 'INSTANCE_AMBIGUOUS'> }
  | { candidate_count: number };

export interface LifecycleStatusErrorEnvelope {
  schema_version: 'cortext.status.error/v1';
  ok: false;
  error: {
    code: LifecycleStatusErrorCode;
    message: string;
    details: LifecycleStatusErrorDetails;
  };
}

export type RedactedLifecycleStatusError =
  | {
    code: 'CORTEXT_STATUS_INVALID_INSTANCE';
    message: 'The selected Cortext instance identifier is invalid.';
    detail_code: 'INVALID_INSTANCE';
  }
  | {
    code: 'CORTEXT_STATUS_INSTANCE_NOT_FOUND';
    message: 'No legacy Cortext instance was found for the selected identifier.';
    detail_code: 'INSTANCE_NOT_FOUND';
  }
  | {
    code: 'CORTEXT_STATUS_INSTANCE_AMBIGUOUS';
    message: 'Select exactly one Cortext instance.';
    detail_code: 'INSTANCE_AMBIGUOUS';
  }
  | {
    code: 'CORTEXT_STATUS_INVALID_OPTION_COMBINATION';
    message: 'The selected redacted-output options cannot be combined.';
    detail_code: 'REDACT_WITH_PATHS';
  }
  | {
    code: 'CORTEXT_STATUS_CONTRACT_REQUIRES_JSON';
    message: 'Contract negotiation requires JSON output.';
    detail_code: 'CONTRACT_WITHOUT_JSON';
  }
  | {
    code: 'CORTEXT_STATUS_CONTRACT_MODE_MISMATCH';
    message: 'The requested status contract does not match the output mode.';
    detail_code: 'CONTRACT_MODE_MISMATCH';
  }
  | {
    code: 'CORTEXT_STATUS_UNSUPPORTED_CONTRACT';
    message: 'The requested status contract is unsupported.';
    detail_code: 'UNSUPPORTED_CONTRACT';
  }
  | {
    code: 'CORTEXT_STATUS_UNSUPPORTED_CHECK_POLICY';
    message: 'The requested status check policy is unsupported.';
    detail_code: 'UNSUPPORTED_CHECK_POLICY';
  }
  | {
    code: 'CORTEXT_STATUS_COLLECTION_FAILED';
    message: 'A trustworthy lifecycle status snapshot could not be assembled.';
    detail_code: 'COLLECTION_FAILED';
  };

export interface RedactedLifecycleStatusErrorEnvelope {
  schema_version: 'cortext.status.redacted.error/v1';
  ok: false;
  error: RedactedLifecycleStatusError;
}
