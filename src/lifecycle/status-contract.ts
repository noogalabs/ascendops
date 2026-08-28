export const LEGACY_SUPPORTED_CAPABILITIES = [
  'legacy_layout',
  'legacy_application_evidence',
  'legacy_state_readability',
  'legacy_agent_inventory',
  'legacy_daemon_ipc',
  'redacted_projection',
  'check_policies_v1',
] as const;

export const LEGACY_UNSUPPORTED_CAPABILITIES = [
  'transaction_basis',
  'device_identity',
  'writer_lease',
  'release_integrity',
  'component_lock',
  'recovery_index',
  'update_metadata',
  'compatibility_matrix',
] as const;

export const ISOLATION_EVIDENCE_CODES = [
  'CORTEXT_ISOLATION_LIVE_ROOT_DISJOINT',
  'CORTEXT_ISOLATION_PROCESS_NAMESPACE_DISJOINT',
  'CORTEXT_ISOLATION_MANAGED_INTEGRATIONS_ROUTED',
  'CORTEXT_ISOLATION_BOUNDARY_ENFORCED',
  'CORTEXT_ISOLATION_HOST_CREDENTIALS_UNAVAILABLE',
  'CORTEXT_ISOLATION_EGRESS_POLICY_ENFORCED',
  'CORTEXT_ISOLATION_HOST_ACCESS_CONSTRAINED',
] as const;

export const LEGACY_STATUS_OBSERVATIONS = {
  CORTEXT_STATUS_LEGACY_LAYOUT: {
    severity: 'info', domain: 'legacy',
    summary: 'An existing combined Cortext layout was detected.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_LEGACY_CAPABILITIES_LIMITED: {
    severity: 'info', domain: 'legacy',
    summary: 'Managed lifecycle authority is unavailable in the legacy bridge profile.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_LEGACY_ROOT_AUTHORITY_UNPROVEN: {
    severity: 'error', domain: 'legacy',
    summary: 'The selected custom state root cannot be bound to the legacy daemon identity.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_FRAMEWORK_NOT_FOUND: {
    severity: 'warning', domain: 'application',
    summary: 'The legacy application checkout could not be resolved.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_APPLICATION_VERSION_UNKNOWN: {
    severity: 'warning', domain: 'application',
    summary: 'The legacy application version could not be established.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_FRAMEWORK_MODIFIED: {
    severity: 'warning', domain: 'application',
    summary: 'The legacy framework checkout contains local modifications.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_VERSION_CONFLICT: {
    severity: 'warning', domain: 'application',
    summary: 'Legacy application version sources disagree.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_REGISTRY_INVALID: {
    severity: 'error', domain: 'runtime',
    summary: 'The enabled-agent registry is invalid or unreadable.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_AGENT_CONFIG_INVALID: {
    severity: 'error', domain: 'runtime',
    summary: 'At least one agent configuration is invalid or unreadable.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_AGENT_ID_INVALID: {
    severity: 'error', domain: 'runtime',
    summary: 'At least one legacy agent or organization identifier is invalid.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_LEGACY_AGENT_ID_NONCANONICAL: {
    severity: 'warning', domain: 'runtime',
    summary: 'At least one observable legacy agent or organization identifier requires canonicalization.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_LEGACY_AGENT_NAME_COLLISION: {
    severity: 'error', domain: 'runtime',
    summary: 'Multiple configured agents cannot be distinguished safely by legacy or canonical identity mapping.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_HEARTBEAT_INVALID: {
    severity: 'warning', domain: 'runtime',
    summary: 'At least one existing heartbeat is invalid or unreadable.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_DAEMON_ENDPOINT_STALE: {
    severity: 'warning', domain: 'runtime',
    summary: 'The daemon endpoint refused a local connection.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_DAEMON_TIMEOUT: {
    severity: 'error', domain: 'runtime',
    summary: 'The daemon status request timed out.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_DAEMON_RESPONSE_INVALID: {
    severity: 'error', domain: 'runtime',
    summary: 'The daemon returned an invalid status response.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_DAEMON_STATUS_UNKNOWN: {
    severity: 'error', domain: 'runtime',
    summary: 'The daemon status could not be determined.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_AGENT_EXPECTED_MISSING: {
    severity: 'warning', domain: 'runtime',
    summary: 'At least one enabled agent is absent from responsive daemon status.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_DISABLED_PROCESS_ACTIVE: {
    severity: 'error', domain: 'runtime',
    summary: 'At least one disabled agent process is active.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_UNREGISTERED_PROCESS_ACTIVE: {
    severity: 'error', domain: 'runtime',
    summary: 'At least one unregistered agent process is active.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_AGENT_DEGRADED: {
    severity: 'warning', domain: 'runtime',
    summary: 'At least one observed agent process is degraded.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_STATE_MISSING: {
    severity: 'error', domain: 'state',
    summary: 'The selected legacy state directory is missing.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_STATE_UNREADABLE: {
    severity: 'critical', domain: 'state',
    summary: 'The selected legacy state root is unreadable or invalid.',
    recommended_operation: null,
  },
} as const;

export const LEGACY_PARTIAL_OBSERVATION_CODES = [
  'CORTEXT_STATUS_LEGACY_ROOT_AUTHORITY_UNPROVEN',
  'CORTEXT_STATUS_FRAMEWORK_NOT_FOUND',
  'CORTEXT_STATUS_APPLICATION_VERSION_UNKNOWN',
  'CORTEXT_STATUS_REGISTRY_INVALID',
  'CORTEXT_STATUS_AGENT_CONFIG_INVALID',
  'CORTEXT_STATUS_AGENT_ID_INVALID',
  'CORTEXT_STATUS_LEGACY_AGENT_NAME_COLLISION',
  'CORTEXT_STATUS_HEARTBEAT_INVALID',
  'CORTEXT_STATUS_DAEMON_TIMEOUT',
  'CORTEXT_STATUS_DAEMON_RESPONSE_INVALID',
  'CORTEXT_STATUS_DAEMON_STATUS_UNKNOWN',
  'CORTEXT_STATUS_STATE_MISSING',
  'CORTEXT_STATUS_STATE_UNREADABLE',
] as const satisfies readonly (keyof typeof LEGACY_STATUS_OBSERVATIONS)[];

export const STATUS_CHECK_POLICIES = [
  'usable',
  'healthy',
  'update-safe',
  'sandbox-namespace',
  'security-contained',
] as const;

export const STATUS_CHECK_REASON_CODES = [
  'CORTEXT_CHECK_SNAPSHOT_INCOMPLETE',
  'CORTEXT_CHECK_INSTANCE_UNRESOLVED',
  'CORTEXT_CHECK_OVERALL_DISALLOWED',
  'CORTEXT_CHECK_STATE_NOT_READABLE',
  'CORTEXT_CHECK_PROFILE_UNSUPPORTED',
  'CORTEXT_CHECK_MANAGER_INTEGRITY_UNVERIFIED',
  'CORTEXT_CHECK_CONSISTENCY_UNSTABLE',
  'CORTEXT_CHECK_DAEMON_NOT_RUNNING',
  'CORTEXT_CHECK_BASIS_INCOMPLETE',
  'CORTEXT_CHECK_WRITER_NOT_ACTIVE',
  'CORTEXT_CHECK_MIGRATION_NOT_IDLE',
  'CORTEXT_CHECK_APPLICATION_UNVERIFIED',
  'CORTEXT_CHECK_COMPATIBILITY_UNSAFE',
  'CORTEXT_CHECK_CHECKPOINT_UNVERIFIED',
  'CORTEXT_CHECK_BACKUP_UNVERIFIED',
  'CORTEXT_CHECK_ROLLBACK_NOT_READY',
  'CORTEXT_CHECK_LIFECYCLE_ERROR_PRESENT',
  'CORTEXT_CHECK_TARGET_NOT_SANDBOX',
  'CORTEXT_CHECK_ROOTS_NOT_ISOLATED',
  'CORTEXT_CHECK_PROCESSES_NOT_ISOLATED',
  'CORTEXT_CHECK_INTEGRATIONS_NOT_ROUTED',
  'CORTEXT_CHECK_BOUNDARY_INSUFFICIENT',
  'CORTEXT_CHECK_CREDENTIALS_EXPOSED',
  'CORTEXT_CHECK_NETWORK_UNCONSTRAINED',
  'CORTEXT_CHECK_HOST_ACCESS_FULL',
  'CORTEXT_CHECK_ISOLATION_EVIDENCE_MISSING',
] as const;

export const STATUS_CHECK_REASONS_BY_POLICY = {
  usable: [
    'CORTEXT_CHECK_SNAPSHOT_INCOMPLETE',
    'CORTEXT_CHECK_INSTANCE_UNRESOLVED',
    'CORTEXT_CHECK_OVERALL_DISALLOWED',
    'CORTEXT_CHECK_STATE_NOT_READABLE',
  ],
  healthy: [
    'CORTEXT_CHECK_SNAPSHOT_INCOMPLETE',
    'CORTEXT_CHECK_INSTANCE_UNRESOLVED',
    'CORTEXT_CHECK_OVERALL_DISALLOWED',
    'CORTEXT_CHECK_STATE_NOT_READABLE',
    'CORTEXT_CHECK_CONSISTENCY_UNSTABLE',
    'CORTEXT_CHECK_DAEMON_NOT_RUNNING',
    'CORTEXT_CHECK_LIFECYCLE_ERROR_PRESENT',
  ],
  'update-safe': [
    'CORTEXT_CHECK_SNAPSHOT_INCOMPLETE',
    'CORTEXT_CHECK_INSTANCE_UNRESOLVED',
    'CORTEXT_CHECK_OVERALL_DISALLOWED',
    'CORTEXT_CHECK_STATE_NOT_READABLE',
    'CORTEXT_CHECK_PROFILE_UNSUPPORTED',
    'CORTEXT_CHECK_MANAGER_INTEGRITY_UNVERIFIED',
    'CORTEXT_CHECK_CONSISTENCY_UNSTABLE',
    'CORTEXT_CHECK_BASIS_INCOMPLETE',
    'CORTEXT_CHECK_WRITER_NOT_ACTIVE',
    'CORTEXT_CHECK_MIGRATION_NOT_IDLE',
    'CORTEXT_CHECK_APPLICATION_UNVERIFIED',
    'CORTEXT_CHECK_COMPATIBILITY_UNSAFE',
    'CORTEXT_CHECK_CHECKPOINT_UNVERIFIED',
    'CORTEXT_CHECK_BACKUP_UNVERIFIED',
    'CORTEXT_CHECK_ROLLBACK_NOT_READY',
    'CORTEXT_CHECK_LIFECYCLE_ERROR_PRESENT',
  ],
  'sandbox-namespace': [
    'CORTEXT_CHECK_SNAPSHOT_INCOMPLETE',
    'CORTEXT_CHECK_TARGET_NOT_SANDBOX',
    'CORTEXT_CHECK_ROOTS_NOT_ISOLATED',
    'CORTEXT_CHECK_PROCESSES_NOT_ISOLATED',
    'CORTEXT_CHECK_INTEGRATIONS_NOT_ROUTED',
    'CORTEXT_CHECK_ISOLATION_EVIDENCE_MISSING',
  ],
  'security-contained': [
    'CORTEXT_CHECK_SNAPSHOT_INCOMPLETE',
    'CORTEXT_CHECK_TARGET_NOT_SANDBOX',
    'CORTEXT_CHECK_ROOTS_NOT_ISOLATED',
    'CORTEXT_CHECK_PROCESSES_NOT_ISOLATED',
    'CORTEXT_CHECK_INTEGRATIONS_NOT_ROUTED',
    'CORTEXT_CHECK_BOUNDARY_INSUFFICIENT',
    'CORTEXT_CHECK_CREDENTIALS_EXPOSED',
    'CORTEXT_CHECK_NETWORK_UNCONSTRAINED',
    'CORTEXT_CHECK_HOST_ACCESS_FULL',
    'CORTEXT_CHECK_ISOLATION_EVIDENCE_MISSING',
  ],
} as const;
export const PUBLIC_VERSION_PATTERN =
  '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$';
export const PUBLIC_VERSION_RE = new RegExp(PUBLIC_VERSION_PATTERN);

export type LegacySupportedCapability = typeof LEGACY_SUPPORTED_CAPABILITIES[number];
export type LegacyUnsupportedCapability = typeof LEGACY_UNSUPPORTED_CAPABILITIES[number];
export type IsolationEvidenceCode = typeof ISOLATION_EVIDENCE_CODES[number];
export type LegacyStatusObservationCode = keyof typeof LEGACY_STATUS_OBSERVATIONS;
export type LegacyStatusObservationDomain =
  typeof LEGACY_STATUS_OBSERVATIONS[LegacyStatusObservationCode]['domain'];
export type StatusCheckPolicy = typeof STATUS_CHECK_POLICIES[number];
export type StatusCheckReasonCode = typeof STATUS_CHECK_REASON_CODES[number];
export type StatusCheckReasonFor<P extends StatusCheckPolicy> =
  typeof STATUS_CHECK_REASONS_BY_POLICY[P][number];
